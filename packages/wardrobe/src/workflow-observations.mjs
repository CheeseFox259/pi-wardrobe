import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve, relative } from 'node:path';

const digest=value=>createHash('sha256').update(value).digest('hex');

function callIndex(messages){
  const calls=new Map();
  for(const message of messages)if(message.role==='assistant')for(const item of message.content||[])if(item.type==='toolCall')
    calls.set(item.id,{tool:item.name||null,input:item.arguments||{}});
  return calls;
}

function fileDependency(tool,input,source,cwd){
  if(tool!=='read'||typeof input?.path!=='string')return {unknown:['bash','read'].includes(tool)};
  let path=resolve(isAbsolute(input.path)?input.path:resolve(cwd||source,input.path));
  if(!existsSync(path))return {unknown:true,requestedPath:input.path};
  try{
    path=realpathSync(path);const bytes=readFileSync(path),stat=statSync(path);
    return {path,mode:stat.mode&0o777,digest:digest(bytes)};
  }catch{return {unknown:true,requestedPath:input.path};}
}

export function captureObservations(root,messages,{source,cwd}={}){
  if(!root)return [];
  const folder=join(root,'memory','observations');mkdirSync(folder,{recursive:true,mode:0o700});
  const index=join(root,'memory','observations.jsonl'),calls=callIndex(messages),known=new Set(indexEntries(root).entries.map(entry=>entry.id));
  const created=[];
  for(let i=0;i<messages.length;i++){
    const message=messages[i];if(message.role!=='toolResult'||message.isError||message.details?.isError)continue;
    const content=(message.content||[]).filter(item=>item.type==='text').map(item=>item.text).join('\n');if(!content)continue;
    const call=calls.get(message.toolCallId)||{},tool=message.toolName||call.tool||null;
    // Administrative replies and writes are state, not independent evidence.
    if(!['read','bash'].includes(tool)&&!(tool==='wardrobe_workflow'&&['lookup','probe'].includes(call.input?.action)))continue;
    const contentHash=digest(content),dependency=fileDependency(tool,call.input,source,cwd);
    if(dependency.path&&/^(?:memory|observations)\//.test(relative(realpathSync(root),dependency.path).replaceAll('\\','/')))continue;
    const inputIdentity=tool==='read'?{path:dependency.path||call.input?.path,offset:call.input?.offset||1}:call.input;
    const id=digest(JSON.stringify([tool,inputIdentity,contentHash,dependency]));
    if(known.has(id))continue;
    const path=join(folder,id+'.json');
    const record={id,tool,toolCallId:message.toolCallId||null,contentHash,content,dependency,createdAt:new Date().toISOString()};
    writeFileSync(path,JSON.stringify(record),{mode:0o600});appendFileSync(index,JSON.stringify({id,path,tool,toolCallId:record.toolCallId})+'\n',{mode:0o600});
    known.add(id);created.push(id);
  }
  return created;
}

function indexEntries(root){
  const index=join(root,'memory','observations.jsonl');if(!existsSync(index))return {entries:[],diagnostics:[]};
  const text=readFileSync(index,'utf8'),lines=text.split('\n'),terminated=text.endsWith('\n');if(terminated)lines.pop();
  const entries=[],diagnostics=[];
  for(let i=0;i<lines.length;i++){
    if(!lines[i])continue;
    try{const entry=JSON.parse(lines[i]);if(!entry||typeof entry.id!=='string'||typeof entry.path!=='string')throw Error('invalid entry');entries.push(entry);}
    catch{if(i===lines.length-1&&!terminated)diagnostics.push({code:'OBSERVATION_INDEX_TAIL_TRUNCATED',line:i+1});else throw Object.assign(Error(`Observation index is corrupt at line ${i+1}`),{code:'OBSERVATION_INDEX_CORRUPT'});}
  }
  return {entries,diagnostics};
}

export function readObservations(root,ids){
  const rootPath=resolve(root),index=indexEntries(root),entries=new Map(index.entries.map(entry=>[entry.id,entry]));
  return ids.map(id=>{
    const entry=entries.get(id);if(!entry)return {id,fresh:false,error:'Observation not found'};
    const path=resolve(rootPath,entry.path);if(!path.startsWith(rootPath+'/'))return {id,fresh:false,error:'Observation path is outside this workflow'};
    try{
      const observation=JSON.parse(readFileSync(path,'utf8'));
      if(observation.id!==id||typeof observation.content!=='string'||digest(observation.content)!==observation.contentHash)return {id,fresh:false,error:'Observation content failed integrity check'};
      const dependency=observation.dependency;
      if(dependency?.path){
        try{const bytes=readFileSync(dependency.path),stat=statSync(dependency.path);
          if(digest(bytes)!==dependency.digest||(stat.mode&0o777)!==dependency.mode)return {id,fresh:false,error:'Observed file changed',path:dependency.path};
        }catch{return {id,fresh:false,error:'Observed file is no longer available',path:dependency.path};}
      }
      return {...observation,fresh:!dependency?.unknown,...(index.diagnostics.length?{diagnostics:index.diagnostics}:{})};
    }catch{return {id,fresh:false,error:'Observation record is unavailable'};}
  });
}

export function recentObservations(root,{count=6,charBudget=6000,excerpt=900}={}){
  const entries=indexEntries(root).entries.slice(-count).toReversed(),selected=[];let budget=charBudget;
  for(const observation of readObservations(root,entries.map(entry=>entry.id))){
    if(!budget)break;
    const content=observation.content||'',limit=Math.min(excerpt,budget);budget-=Math.min(content.length,limit);
    selected.unshift({id:observation.id,tool:observation.tool,toolCallId:observation.toolCallId,fresh:observation.fresh,...(observation.error?{error:observation.error}:{}),content:content.slice(0,limit),...(content.length>limit?{truncated:true,readWith:{action:'checkpoint',observationIds:[observation.id]}}:{})});
  }
  return selected;
}

export function validObservationIds(root){
  return readObservations(root,indexEntries(root).entries.map(entry=>entry.id)).filter(item=>item.fresh).map(item=>item.id);
}
