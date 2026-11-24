import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {sourceFiles} from './native-snapshot.mjs';
import {resolvePackagePath} from './git-source.mjs';
import {validateCheck} from './workflow-environment.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const checkInputs=values=>(values||[]).map(({command,args})=>({command,args}));
const fail=(message)=>{throw Object.assign(Error(message),{code:'WORKFLOW_IMPLEMENTATION_INVALID'});};
export const implementationId=id=>'implementation:'+id;
export const finishedItem=state=>['decided','ready','verified'].includes(state?.status);

const claimContext=(record,work=record.draft?.work||[])=>({files:sourceFiles(record.source),work,identities:new Map(),states:new Map()});

function claimIdentity(record,work,context){
 context||=claimContext(record);
 if(context.identities.has(work.id))return context.identities.get(work.id);
 const paths=[...work.paths,'preset.json','package.json','package-lock.json'];
 const identity=hash({goal:work.goal,origins:work.origins,paths:work.paths,checks:checkInputs(work.checks),
  dependencies:(work.dependsOn||[]).map(id=>[id,claimIdentity(record,context.work.find(w=>w.id===id),context)]),
  files:context.files.filter(([p])=>paths.some(root=>p===root||p.startsWith(root+'/')))});
 context.identities.set(work.id,identity);return identity;
}

/** Normalize an entire proposed ledger before committing any part of a save. */
export function prepareImplementation(record,draft,submission={}){
 const batch=record.batches.find(b=>b.status!=='verified');
 const origins=new Set([...(batch?.required||[]),...(batch?.items||[batch]).filter(Boolean).map(i=>i.id)]);
 const incoming=submission.work||[];
 if(!Array.isArray(incoming)||!Array.isArray(draft.work||[]))fail('work must be a list');
 const fields=new Set(['id','origins','goal','paths','checks','dependsOn','ready','missingFact']);
 for(const work of incoming)if(!work||Object.keys(work).some(k=>!fields.has(k)))fail('Use work fields id, origins, goal, paths, checks, dependsOn, ready and missingFact');
 if(new Set(incoming.map(w=>w.id)).size!==incoming.length)fail('A save can update each implementation ID once');
 const known=new Map((record.draft?.work||[]).map(w=>[w.id,w]));
 const work=(draft.work||[]).map(value=>({...value})),byId=new Map(work.map(w=>[w.id,w]));
 for(const w of work){
  if(typeof w.id!=='string'||!/^[-a-zA-Z0-9_]{1,80}$/.test(w.id)||!w.goal?.trim())fail('Each implementation needs a stable ID and concrete goal');
  if(!Array.isArray(w.origins)||!w.origins.length||w.origins.some(id=>!origins.has(id)))fail('Implementation '+w.id+' must reference existing requirement/decision IDs');
  if(known.has(w.id)&&JSON.stringify(w.origins)!==JSON.stringify(known.get(w.id).origins))fail('Preserve the origins of implementation '+w.id);
  if(!Array.isArray(w.paths)||!w.paths.length)fail('Implementation '+w.id+' needs affected relative paths');
  for(const path of w.paths){
   if(typeof path!=='string'||path.startsWith('/')||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..'))fail('Implementation paths must be safe relative paths');
   let parent=path;while(!existsSync(join(record.source,parent)))parent=dirname(parent);
   resolvePackagePath(record.source,parent,'/work/paths');
  }
  if(!Array.isArray(w.checks))fail('Implementation '+w.id+' needs an affected check plan');
  for(const check of w.checks)validateCheck(check);
  if(w.ready!==undefined&&typeof w.ready!=='boolean')fail('ready must be boolean');
  if(!Array.isArray(w.dependsOn||[])||(w.dependsOn||[]).some(id=>!byId.has(id)||id===w.id))fail('Implementation dependencies must name other implementation IDs');
  if(w.missingFact!==undefined&&w.missingFact!==null&&(!w.missingFact.question?.trim()||!w.missingFact.why?.trim()||!w.missingFact.nextStep?.trim()))fail('A missing fact needs question, why it changes this decision, and a finite nextStep');
  const update=incoming.find(item=>item.id===w.id);
  if(update?.ready===true&&!w.checks.length)fail('A ready implementation needs affected behavior checks');
  else if(update?.ready===false)delete w.claim;
 }
 const visited=new Set(),visiting=new Set();
 const visit=id=>{if(visiting.has(id))fail('Implementation dependency cycle at '+id);if(visited.has(id))return;visiting.add(id);for(const dep of byId.get(id).dependsOn||[])visit(dep);visiting.delete(id);visited.add(id);};
 for(const w of work)visit(w.id);
 const context=claimContext(record,work);
 for(const w of work)if(incoming.find(item=>item.id===w.id)?.ready===true)w.claim=claimIdentity(record,w,context);
 return {...draft,work};
}

export function implementationState(record,work,context){
 context||=claimContext(record);
 if(context.states.has(work.id))return context.states.get(work.id);
 if(!work.claim)return 'pending';
 if(work.claim!==claimIdentity(record,work,context))return 'stale';
 const state=(work.dependsOn||[]).every(id=>{
  const dependency=record.draft.work.find(w=>w.id===id);
  return dependency&&implementationState(record,dependency,context)==='ready';
 })?'ready':'waiting';
 context.states.set(work.id,state);return state;
}

export function implementationStates(record){
 if(!record.draft?.work?.length)return new Map();
 const context=claimContext(record);
 return new Map(context.work.map(w=>[w.id,implementationState(record,w,context)]));
}

export function implementationItems(record){return (record.draft?.work||[]).map(w=>({
 id:implementationId(w.id),kind:'implementation',title:w.goal,required:[],files:w.paths,
 workId:w.id,origins:w.origins,dependencies:w.dependsOn||[],checks:w.checks,missingFact:w.missingFact,
}));}

export function unfinishedImplementation(record){const states=implementationStates(record);return (record.draft?.work||[]).filter(w=>states.get(w.id)!=='ready').map(w=>({id:implementationId(w.id),goal:w.goal,status:states.get(w.id),missingFact:w.missingFact}));}

export function missingImplementationOrigins(record){
 const batch=record.batches.find(b=>b.status!=='verified');
 return (record.workflowVersion>=5&&record.mode==='update'&&batch?.required?.includes('request')&&
  !(record.draft?.work||[]).some(w=>w.origins.includes('request')||w.origins.includes('requested')))?['request']:[];
}

export function implementationChecks(submission){return (submission.work||[]).flatMap(w=>w.checks||[]);}

/** Narrative and investigation changes are durable, but do not renew delivery. */
export function deliveryIdentity(record){
 const draft=record.draft||{};
 return hash({decisions:(draft.decisions||[]).map(({id,action})=>({id,action})),resources:draft.resources,migrations:(draft.migrations||[]).map(({from,to})=>({from,to})),
  checks:checkInputs(draft.checks),obligations:draft.obligations,work:(draft.work||[]).map(({id,origins,paths,dependsOn,claim,checks:plan})=>({id,origins,paths,dependsOn,claimed:Boolean(claim),checks:checkInputs(plan)})),
  checked:(record.partialEvidence||[]).filter(e=>e.outcome.code===0&&!e.outcome.timedOut&&!e.outcome.cancelled).map(e=>e.key)});
}

export function implementationAdvice(record,item){
 if(item?.workId){
  const w=record.draft.work.find(w=>w.id===item.workId),state=implementationState(record,w);
  return w.missingFact?`Resolve ${w.missingFact.question}; ${w.missingFact.nextStep}. Then implement: ${w.goal}.`:
   state==='stale'?`Candidate inputs changed. Review ${w.paths.join(', ')}, renew the implementation claim and run its affected checks.`:
   `Implement ${w.goal} in ${w.paths.join(', ')}; save work ${w.id} with ready:true and its affected checks, or record a finite blocker.`;
 }
 return 'Save the focused decision and declare any necessary adaptations as bounded work with origins, goal, paths and checks. Resolve a named missing fact or record a finite blocker.';
}
