import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './native-store.mjs';
import { sourceFiles } from './native-snapshot.mjs';
import { readObservations } from './workflow-observations.mjs';

function implementationProgress(record,work){
 const before=new Map(sourceFiles(join(record.root,'base')).map(([p,mode,digest])=>[p,mode+':'+digest]));
 const after=new Map(sourceFiles(record.source).map(([p,mode,digest])=>[p,mode+':'+digest]));
 const changes=[...new Set([...before.keys(),...after.keys()])].filter(p=>work.paths.some(root=>p===root||p.startsWith(root+'/'))&&before.get(p)!==after.get(p));
 const findings=(record.findings||[]).filter(f=>[record.focusId,...work.origins,record.batches.find(b=>b.status!=='verified')?.id].includes(f.itemId)).slice(-6);
 return {changes:changes.slice(0,24).map(path=>({path,status:!before.has(path)?'added':!after.has(path)?'removed':'modified'})),
  ...(changes.length>24?{moreChanges:true}:{}),
  findings:findings.map(f=>({...f,...(f.observations?.length?{fresh:readObservations(record.root,f.observations).every(o=>o.fresh)}:{})}))};
}

export function combineWork(items){
  const head={...items[0]};
  head.required=[...new Set(items.flatMap(b=>b.required))];head.files=[...new Set(items.flatMap(b=>b.files))];
  head.capabilities=items.flatMap(b=>b.capabilities||[b.capability]).filter(Boolean);
  head.packages=items.flatMap(b=>b.packages||[b.package]).filter(Boolean);
  head.repos=[...new Set(items.flatMap(b=>b.repos||[b.repo]).filter(Boolean))];head.runtime=items.find(b=>b.runtime)?.runtime;
  head.title=items.map(b=>b.title).join(' + ');return head;
}

export function groupWork(items,plan){
  // Only bounded, clean Markdown skill changes share a review. Unknown inputs,
  // conflicts, runtime, resources and executable companions keep their own item.
  const size=item=>{
    if(!item.id.startsWith('skill:')||!item.files.length)return Infinity;
    let bytes=0;
    for(const path of item.files){
      const file=plan?.files?.find(f=>f.path===path),diff=file?.review?.upstreamDiff||file?.review?.upstream;
      if(!path.endsWith('.md')||!file||!(file.merge==='CLEAN'||file.action==='APPLY')||!diff||!existsSync(diff))return Infinity;
      bytes+=statSync(diff).size;
    }
    return bytes;
  };
  const groups=[];let pending=[],bytes=0;
  const flush=()=>{if(pending.length)groups.push(pending.length===1?pending[0]:combineWork(pending));pending=[];bytes=0;};
  for(const item of items){
    const length=size(item);
    if(length>12000){flush();groups.push(item);continue;}
    if(pending.length&&(pending[0].repo!==item.repo||pending.length===4||bytes+length>12000))flush();
    pending.push(item);bytes+=length;
  }
  flush();return groups;
}

/** Exact bounded excerpts and original pointers, never a model-authored release summary. */
export function packetFor(record,response){
  if(record.execution==='change-list'&&!response.runtimeBaseline){
   const work=record.draft?.work?.find(w=>w.id===response.focus?.workId);
   const paths=[...response.decisions.flatMap(d=>[d.review?.upstreamDiff||d.review?.upstream,d.review?.localDiff]),...response.releaseNotes.map(n=>n.delta||n.path)].filter(Boolean);
   let budget=6000;
   const evidence=[...new Set(paths)].slice(0,4).flatMap(path=>{
    if(!existsSync(path)||!budget)return [];
    const bytes=readFileSync(path);if(bytes.includes(0))return [{path,binary:true}];
    const text=bytes.toString('utf8'),limit=Math.min(1800,budget);budget-=Math.min(text.length,limit);
    return [{path,text:text.slice(0,limit),...(text.length>limit?{more:true}:{})}];
   });
   return {
    scope:'Complete change list remains in the index. Focus any item in dependency order, save its partial decisions, then continue independent work.',
    index:response.changes,focus:response.focus,declaration:{path:join(record.source,'preset.json')},
    incoming:response.decisions.map(({path,skill,action,reason,inputs,merge,preservedFeatures,review})=>({path,skill,action,reason,inputs,merge,preservedFeatures,upstream:review?.upstreamDiff||review?.upstream,local:review?.localDiff})),
    capabilities:response.capabilities,packages:response.packages,
    notes:response.releaseNotes.map(({id,status,path,delta,source})=>({id,status,path,delta,source})),
    ...(existsSync(join(record.root,'base','components.json'))?{preservation:{path:join(record.root,'base','components.json')}}:{}),
    policy:response.skills.preset.contracts||{path:response.skills.preset.path},
    ...(work?{implementation:{id:work.id,goal:work.goal,paths:work.paths,dependencies:work.dependsOn||[],checks:work.checks,
      missingFact:work.missingFact,decisions:(record.draft.decisions||[]).filter(d=>work.origins.includes(d.id)),...implementationProgress(record,work),
      next:'Implement this outcome, check affected behavior, and save ready:true. Record a finite blocker if a named missing fact prevents it.'}}:{}),
    ...(evidence.length?{evidence}:{}),
   };
  }
  let budget=36000;
  const excerpt=(path,limit=5000)=>{
    if(!path||!existsSync(path))return undefined;
    const bytes=readFileSync(path);if(bytes.includes(0))return {path,binary:true};
    const text=bytes.toString('utf8'),length=Math.max(0,Math.min(limit,budget));budget-=Math.min(text.length,length);
    return {path,text:text.slice(0,length),...(text.length>length?{more:true}:{})};
  };
  const components=readJson(join(record.source,'components.json'),{});
  if(response.runtimeBaseline)return {scope:'Repair only the concrete loading failure; probe reruns the actual candidate. Other updates are queued separately.',declaration:{path:join(record.source,'preset.json')}};
  if(response.runtimeReviews?.length)return {
    scope:'Review only these exact Pi release-note ranges. Adopt/adapt when applicable; defer optional changes with reasons when unnecessary or behavior is ambiguous. Every range has its own required decision. Loading alone does not prove behavior compatibility.',
    declaration:{path:join(record.source,'preset.json')},
    notes:response.runtimeReviews.map(review=>({...review,...(review.path?{text:readFileSync(review.path,'utf8')}:{})})),
    preservation:{path:join(record.source,'components.json'),instruction:'Preserve local features. Inspect only the candidate resources affected by these entries; resourceCatalog lists their paths.'},
  };
  return {declaration:excerpt(join(record.source,'preset.json'),6500),
    localOwners:Object.fromEntries(Object.entries({...components.packages,...components.extensions}).filter(([,v])=>v&&typeof v==='object'&&v.localPath).map(([k,{localPath,preservedFeatures,adaptations}])=>[k,{localPath,preservedFeatures,adaptations}])),
    incoming:response.decisions.map(d=>({path:d.path,merge:d.merge,preservedFeatures:d.preservedFeatures,
      upstream:excerpt(d.review?.upstreamDiff||d.review?.upstream,2500),local:d.merge==='CLEAN'?undefined:excerpt(d.review?.localDiff,1500)})),
    notes:response.releaseNotes.map(n=>({id:n.id,status:n.status,source:n.source,excerpt:excerpt(n.path,5500),delta:excerpt(n.delta,6000)}))};
}
