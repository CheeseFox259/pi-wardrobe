// Deterministic native-provider exercise. No network, billing or product claims.
import {appendFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
export default function implementationProvider(pi){
 const folder=process.env.PI_CODING_AGENT_DIR;
 const model={provider:'wardrobe-implementation-local',api:'anthropic-messages',id:'implementation',name:'Implementation fixture',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:4000};
 let count=0;
 let resumed=0;
 const streamSimple=(selected,context)=>{
  count++;let state={};
  for(const m of context.messages||[])for(const p of Array.isArray(m.content)?m.content:[]){if(p.type!=='text')continue;try{const text=p.text;const value=JSON.parse(text.startsWith('Wardrobe state delta:\n')||text.includes('state):\n')?text.slice(text.indexOf('\n')+1):text);if(value.status)state={...state,...value};}catch{}}
  const {source,updateReview}=JSON.parse(readFileSync(join(folder,'implementation-case.json'),'utf8'));
  const item=(id,path=id+'.txt')=>({id,origins:[updateReview?'request':'maintain'],goal:'Deliver '+id,paths:[path],checks:[{command:'node',args:['-e',`require('node:assert/strict').equal(require('node:fs').readFileSync('${path}','utf8'),'done')`],reason:'Check '+id+' outcome'}]});
  let name='wardrobe_workflow',input;
  if(updateReview){
   if(count===1)input={action:'update',review:'human',source,request:'Add a local indicator'};
   else if(count===2)input={action:'propose',proposal:{changes:[{component:'Indicator',effect:'Expose the local status.',recommendation:'adapt'}],validation:'Check the local indicator contents.'}};
   else if((context.messages||[]).some(m=>m.role==='user'&&JSON.stringify(m.content).includes('Implement the confirmed proposal'))){
    resumed++;
    if(resumed===1)input={action:'resume'};
    else if(resumed===2&&state.status==='REVIEW_REQUIRED'){name='write';input={path:join(state.workspace.source,'prompts/indicator.md'),content:'done'};}
    else if(resumed===3)input={action:'save',submission:{summary:'Local indicator added',decisions:[{id:'request',action:'adapt',reason:'Add the status indicator'}],resources:[{action:'add',package:state.context.localPackageAlias,kind:'prompts',path:'prompts/indicator.md'}],work:[{...item('indicator','prompts/indicator.md'),ready:true}]}};
    else if(resumed===4)input={action:'verify'};
    else if(state.status==='READY_TO_INSTALL')input={action:'install',approved:true};
    else name=null;
   }else name=null;
  }else if(count===1)input={action:'maintain',source,request:'Add two independent indicators'};
  else if(['INSTALLED','STALLED'].includes(state.status)||count>13)name=null;
  else if(count===2)input={action:'save',submission:{summary:'Two indicators',work:[item('first'),item('second')]}};
  else if(count===3){name='write';input={path:join(state.workspace.source,'first.txt'),content:'done'};}
  else if(count===4)input={action:'save',submission:{work:[{id:'first',ready:true}]}};
  else if(count===5)input={action:'focus',item:'implementation:second'};
  else if(count===6){name='write';input={path:join(state.workspace.source,'second.txt'),content:'done'};}
  else if(count===7)input={action:'check'};
  else if(count===8)input={action:'save',submission:{work:[{id:'second',ready:true}]}};
  else if(count===9)input={action:'verify'};
  else if(state.nextCall?.action==='install')input={action:'install',approved:true};
  else name=null;
  appendFileSync(join(folder,'implementation-requests.jsonl'),JSON.stringify({count,state,name,input})+'\n');
  const message={role:'assistant',api:model.api,provider:selected.provider,model:selected.id,timestamp:Date.now(),content:name?[{type:'toolCall',id:'implementation-'+count,name,arguments:input}]:[{type:'text',text:'Fixture complete.'}],stopReason:name?'toolUse':'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  return {[Symbol.asyncIterator]:async function*(){yield {type:'start',partial:{...message,content:[]}};yield {type:'done',reason:message.stopReason,message};},result:async()=>message};
 };
 pi.registerCommand('implementation-local',{handler:async()=>{pi.registerProvider(model.provider,{api:model.api,baseUrl:'http://127.0.0.1/never-used',apiKey:'fixture-no-network',models:[model],streamSimple});await pi.setModel(model);}});
}
