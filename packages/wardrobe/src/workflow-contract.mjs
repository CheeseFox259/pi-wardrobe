import { resolve, relative } from 'node:path';
import { loadWorkflowRecord } from './workflow-journal.mjs';
import { missingWorkflowDecisions, availableWorkflowItems } from './workflow-execution.mjs';
import {unfinishedImplementation,missingImplementationOrigins} from './workflow-implementation.mjs';

export const workflowContract = 'Edit only workspace.source. Start update/maintain once. Use the complete item list and focus(item) to choose work order and focused evidence; focusing never gates independent saves. Find files with native shell tools; read actual files and use lookup for needed dependency documentation. Follow skills.shared with skills.preset product policy. Save partial decisions and bounded submission.work (id, origins, goal, paths, checks, optional dependsOn/missingFact) via nextCall. Link every compound outcome and necessary adaptation; ready:true claims current implementation, while check runs affected checks without installation eligibility. Record a named missingFact before broadening investigation; ordinary related reads and edits need no extra management calls. Explicit requested work cannot be deferred into completion. Program-owned loading checks prove loading only. Candidate state and the decision ledger are durable; raw observations are not delivery. Failed tools stay in Pi’s native agent loop: read the error and issue a corrected or different call rather than repeating unchanged input. Verify after complete decisions, current implementation claims and blocker resolution. CHECK_FAILED opens verification-repair: edit the candidate using its focused failures and save that repair decision before verifying again. Install at READY_TO_INSTALL with existing authorization. NO_UPDATE/REVIEWED/INSTALLED finish; paused states preserve unfinished work. Models/auth remain native Pi.';

export function workflowHandle(record) {
  return 'w3.'+Buffer.from(JSON.stringify([record.root,record.revision,record.batches.find(b=>b.status!=='verified')?.id||null])).toString('base64url');
}

export function workflowInput(store, input) {
  if(input.handle){
    let tuple;
    try{tuple=JSON.parse(Buffer.from(input.handle.slice(3),'base64url').toString());}catch{}
    if(input.handle.startsWith('w2.')){
      const legacyPath=Array.isArray(tuple)&&typeof tuple[0]==='string'?resolve(tuple[0]):null;
      const within=legacyPath?relative(store.root,legacyPath).replaceAll('\\','/'):'';
      if(!legacyPath||!(/^(updates|maintenance)\//.test(within))||within.startsWith('../'))throw Object.assign(Error('Legacy workflow handle is invalid.'),{code:'WORKFLOW_HANDLE_INVALID'});
      const legacy=loadWorkflowRecord(legacyPath);
      if(legacy?.protocolVersion===2&&input.action==='resume')return {...input,workflow:legacyPath,legacyWorkflow:legacyPath};
      if(legacy?.protocolVersion===2)throw Object.assign(Error('Resume this saved candidate to migrate it to the current workflow.'),{code:'WORKFLOW_MIGRATION_REQUIRED',migration:{action:'resume',workflow:legacyPath}});
      throw Object.assign(Error('Legacy workflow handle is invalid.'),{code:'WORKFLOW_HANDLE_INVALID'});
    }
    if(!input.handle.startsWith('w3.')||!Array.isArray(tuple)||tuple.length!==3||typeof tuple[0]!=='string'||!Number.isInteger(tuple[1]))
      throw Object.assign(Error('Use the handle returned by the current work item.'),{code:'WORKFLOW_HANDLE_INVALID'});
    const within=relative(store.root,resolve(tuple[0])).replaceAll('\\','/');
    if(!/^(updates|maintenance)\//.test(within)||within.startsWith('../'))throw Object.assign(Error('Unknown workflow handle'),{code:'WORKFLOW_HANDLE_INVALID'});
    input={...input,workflow:tuple[0],revision:tuple[1],batch:tuple[2]};
    if(['install','guidance','checkpoint','resume','save','focus','check','propose'].includes(input.action)){
      const record=loadWorkflowRecord(tuple[0]);
      if(record.revision!==tuple[1]||record.batches.find(b=>b.status!=='verified')?.id!==(tuple[2]??undefined))
        throw Object.assign(Error('Work item has advanced; use the latest nextCall.'),{code:'WORKFLOW_STALE_SUBMISSION'});
    }
  }
  if(['verify','install','guidance','checkpoint','resume','probe','save','focus','check','propose'].includes(input.action)&&!input.workflow)
    throw Object.assign(Error('Start update or maintain in this session before '+input.action+'.'),{code:'WORKFLOW_INPUT_REQUIRED'});
  return input;
}

export function nextWorkflowCall(record,files=[]) {
  const handle=workflowHandle(record),batch=record.batches.find(b=>b.status!=='verified');
  if(['STALLED','WAITING_INPUT','PLAN_APPROVED','BLOCKED_DEPENDENCY','SUSPENDED_QUOTA','INTERRUPTED'].includes(record.status))return {action:'resume',handle};
  if(record.status==='READY_TO_INSTALL')return {action:'install',handle};
  if(!batch)return undefined;
  if(batch.runtimeBaseline)return {action:'probe',handle};
  if(record.planReview?.phase==='draft')return {action:'propose',handle};
  if(record.execution==='change-list'){
    const outstanding=missingWorkflowDecisions(record).length>0||missingImplementationOrigins(record).length>0||unfinishedImplementation(record).length>0||Object.values(record.itemStates||{}).some(item=>item.status==='blocked');
    if(batch.items?.length&&!record.focusId&&outstanding){
      const all=[...batch.items,...(record.draft?.work||[]).map(w=>({id:'implementation:'+w.id,required:[]}))];
      const available=availableWorkflowItems(record);
      const item=available.find(item=>item.workId)||available[0]||all.find(item=>record.itemStates?.[item.id]?.status==='blocked');
      if(item)return {action:'focus',handle,item:item.id};
    }
    if(outstanding){
      if(record.focusId?.startsWith('implementation:')){const w=record.draft.work.find(w=>'implementation:'+w.id===record.focusId),state=record.itemStates[record.focusId];return {action:'save',handle,submission:{work:[{id:w.id,ready:true}],...(state.status==='blocked'&&!state.blocker?.needsUser?{resolvedBlockers:[record.focusId]}:{})}};}
      const focus=batch.items?.find(item=>item.id===record.focusId),decisions=(focus?.required||[]).map(id=>record.draft?.decisions?.find(decision=>decision.id===id)||({id,action:id==='request'||id==='verification-repair'||files.some(file=>'skill:'+file.skill===id&&file.action==='REVIEW')?'adapt':'adopt',reason:id==='verification-repair'?'Repair the reported verification failures and rerun the affected checks':''}));
      if(record.resourceRepair&&focus?.id==='verification-repair')return {action:'save',handle,replace:true,submission:{...record.draft,decisions:[...(record.draft?.decisions||[]),...decisions]}};
      const state=record.itemStates?.[focus?.id];
      return {action:'save',handle,submission:{decisions,...(focus?.id==='requested'&&missingImplementationOrigins(record).length?{work:[{id:'requested',origins:['request'],goal:record.request,paths:[],checks:[]}]}:{}),...(state?.status==='blocked'&&!state.blocker?.needsUser?{resolvedBlockers:[focus.id]}:{})}};
    }
    return {action:'verify',handle};
  }
  return {action:'verify',handle,submission:{summary:'',decisions:batch.required.map(id=>({id,reason:''})),resources:[],migrations:[],checks:[]}};
}
