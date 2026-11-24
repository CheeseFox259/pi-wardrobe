import {implementationItems,implementationStates,finishedItem,missingImplementationOrigins} from './workflow-implementation.mjs';

function currentBatch(record){
  return record.batches?.find(batch=>batch.status!=='verified');
}

export function workflowItems(record){
  const batch=currentBatch(record);
  if(!batch)return [];
  return [...(batch.items?.length?batch.items:[{id:batch.id,title:batch.title,required:batch.required||[],files:batch.files||[],repo:batch.repo}]),...implementationItems(record)];
}

export function ensureWorkExecution(record){
  const items=workflowItems(record),saved=new Set((record.draft?.decisions||[]).map(decision=>decision.id)),states=implementationStates(record);
  record.itemStates||={};
  for(const item of items){
    const prior=record.itemStates[item.id]||{},complete=item.required.length?item.required.every(id=>saved.has(id)):Boolean(record.draft?.summary);
    const related=(record.draft?.work||[]).filter(w=>w.origins.some(id=>id===item.id||item.required.includes(id)));
    const status=item.workId?states.get(item.workId):
      complete&&!(item.id==='requested'&&missingImplementationOrigins(record).length)&&related.every(w=>states.get(w.id)==='ready')?'decided':prior.status==='in_progress'?'in_progress':'pending';
    record.itemStates[item.id]={...prior,status:prior.status==='blocked'?'blocked':status};
  }
  for(const id of Object.keys(record.itemStates))if(!items.some(item=>item.id===id))delete record.itemStates[id];
  if(record.focusId===undefined||record.focusId!==null&&!items.some(item=>item.id===record.focusId))record.focusId=items.find(item=>!finishedItem(record.itemStates[item.id])&&record.itemStates[item.id].status!=='blocked')?.id||items[0]?.id||null;
  return items;
}

export function focusedWorkflowItem(record){
  return workflowItems(record).find(item=>item.id===record.focusId);
}

/** Recovery can hand off to actionable work, never to its unfinished parent or dependent. */
export function availableWorkflowItems(record){
  const saved=new Set((record.draft?.decisions||[]).map(d=>d.id));
  return workflowItems(record).filter(item=>{
    if(finishedItem(record.itemStates?.[item.id])||record.itemStates?.[item.id]?.status==='blocked')return false;
    if(item.workId)return item.dependencies.every(id=>record.itemStates?.['implementation:'+id]?.status==='ready');
    const children=(record.draft?.work||[]).filter(w=>w.origins.some(id=>id===item.id||item.required.includes(id)));
    return !children.length||item.required.some(id=>!saved.has(id));
  });
}

export function missingWorkflowDecisions(record){
  const batch=currentBatch(record),saved=new Set((record.draft?.decisions||[]).map(decision=>decision.id));
  return (batch?.required||[]).filter(id=>!saved.has(id));
}

export function blockedWorkflowItems(record){
  return workflowItems(record).filter(item=>record.itemStates?.[item.id]?.status==='blocked').map(item=>({id:item.id,...record.itemStates[item.id].blocker}));
}

export function applyWorkflowSubmission(record,submission={}){
  const items=ensureWorkExecution(record),ids=new Set(items.map(item=>item.id));
  const submitted=new Set((submission.decisions||[]).map(decision=>decision.id)),saved=new Set((record.draft?.decisions||[]).map(decision=>decision.id));
  for(const item of items){
    const state=record.itemStates[item.id];
    const workDelivery=(submission.work||[]).some(w=>w.ready===true&&(item.workId===w.id||(record.draft.work.find(entry=>entry.id===w.id)?.origins||[]).some(id=>id===item.id||item.required.includes(id))));
    if(state.status!=='blocked'||state.blocker?.origin!=='delivery'||!(workDelivery||item.required.some(id=>submitted.has(id)))||!item.required.every(id=>saved.has(id)))continue;
    record.itemStates[item.id]={...state,status:'pending',previousBlocker:state.blocker,blocker:undefined};
    if(record.pausedItemId===item.id)delete record.pausedItemId;
  }
  for(const id of submission.resolvedBlockers||[]){
    if(!ids.has(id))throw Object.assign(Error('Unknown work item: '+id),{code:'WORKFLOW_ITEM_UNKNOWN'});
    record.itemStates[id]={...record.itemStates[id],status:'pending',blocker:undefined};
    if(record.pausedItemId===id)delete record.pausedItemId;
  }
  for(const blocker of submission.blockers||[]){
    if(!ids.has(blocker.item))throw Object.assign(Error('Unknown work item: '+blocker.item),{code:'WORKFLOW_ITEM_UNKNOWN'});
    if(!blocker.reason?.trim()||!blocker.nextStep?.trim())throw Error('A blocker requires a reason and finite next step');
    record.itemStates[blocker.item]={...record.itemStates[blocker.item],status:'blocked',blocker:{reason:blocker.reason,nextStep:blocker.nextStep,...(blocker.needsUser?{needsUser:true}:{})}};
    if(record.pausedItemId===blocker.item)delete record.pausedItemId;
    if(record.focusId===blocker.item)record.focusId=null;
  }
  ensureWorkExecution(record);
  if(record.focusId&&(finishedItem(record.itemStates[record.focusId])||record.itemStates[record.focusId]?.status==='blocked'))record.focusId=null;
}

export function advanceWorkProgress(prior={}, {active,delivered}){
  const turns=(prior.turns||0)+1,sinceActivity=active?0:(prior.sinceActivity||0)+1,sinceDelivery=delivered?0:(prior.sinceDelivery||0)+1;
  let recoveryIssuedAt=delivered?null:(prior.recoveryIssuedAt??null);
  if(recoveryIssuedAt===null&&(sinceActivity>=8||sinceDelivery>=8))recoveryIssuedAt=turns;
  return {turns,sinceActivity,sinceDelivery,recoveryIssuedAt};
}

export function workRecoveryDue(progress){
  return progress.recoveryIssuedAt!==null&&progress.turns-progress.recoveryIssuedAt>=8;
}
