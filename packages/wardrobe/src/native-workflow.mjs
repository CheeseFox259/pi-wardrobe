import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync, lstatSync, readdirSync, readlinkSync, linkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readJson, writeJson } from './native-store.mjs';
import { maintenancePaths, prepareMaintenance, checkMaintenance } from './native-maintenance.mjs';
import { publicSource, withLocalSnapshot, inspectPublicSource, sourceDigest } from './native-snapshot.mjs';
import { planPresetUpdate, applyUpdatePlan, advanceUpdateLineage, newSkillDecisions } from './preset-update.mjs';
import { currentPiCli, currentPiVersion, checkPreparedProfile, nativeEnv, reviewNativeImport, materializeNativePlan, promoteNativePlan } from './native-service.mjs';
import { packageRootFor } from './agent-files.mjs';
import { bindDevice } from './native-bindings.mjs';
import { prepareUpdateContext } from './update-context.mjs';
import { resourceTable, compileResources, restoreOwnedFields, validateMigrations, adoptNewSkills } from './workflow-resources.mjs';
import { executeCheck, validateCheck, isolatedEnvironment, nativeLoadCheck, workflowSkillCheck, changedBehaviorChecks } from './workflow-environment.mjs';
import { workflowContract, workflowHandle, nextWorkflowCall } from './workflow-contract.mjs';
import { combineWork, packetFor } from './workflow-packet.mjs';
import { checkNativeResourceExports } from './native-resource-exports.mjs';
import { writeWorkflowGuidance } from './workflow-guidance.mjs';
import { workflowUiCheck } from './workflow-ui.mjs';
import { commitWorkflow, loadWorkflowRecord } from './workflow-journal.mjs';
import { readObservations } from './workflow-observations.mjs';
import { workflowSkills } from './workflow-skills.mjs';
import { changeList, mergeReview } from './workflow-review.mjs';
import { describeFailure } from './diagnostics.mjs';
import { renderCapabilityReport, requireApprovedPlan, updateReviewTitle } from './workflow-proposal.mjs';
import {prepareImplementation,unfinishedImplementation,missingImplementationOrigins,implementationChecks,deliveryIdentity,implementationAdvice,finishedItem} from './workflow-implementation.mjs';
import { ensureWorkExecution, focusedWorkflowItem, availableWorkflowItems, missingWorkflowDecisions, blockedWorkflowItems, applyWorkflowSubmission, advanceWorkProgress, workRecoveryDue } from './workflow-execution.mjs';
export { sourceDigest } from './native-snapshot.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const terminal=new Set(['NO_UPDATE','REVIEWED','INSTALLED','BLOCKED','STALLED','WAITING_INPUT','PLAN_APPROVED','SUSPENDED_QUOTA','INTERRUPTED']);
const managedFiles=new Set(['components.json','manifest.json','package.json','preset.json']);
const editable=r=>r?.protocolVersion===3&&!terminal.has(r.status);
const save=(r,event={})=>Object.assign(r,commitWorkflow(r,{type:event.type||'workflow.checkpoint',opId:event.opId,payload:event.payload||{status:r.status,revision:r.revision}}));
function acceptedDelivery(record){
  delete record.recoveryStep;
  delete record.draft;
  record.progress={totalAssistantTurns:record.progress?.totalAssistantTurns||0,assistantTurns:0,sinceEvidenceProgress:0,sinceDeliveryProgress:0,recoveryIssuedAt:null,acceptedCount:record.accepted.length};
}

function workflowRecord(store,root) {
  const path=resolve(root||''),within=relative(store.root,path).split('\\').join('/');
  if(!/^(updates|maintenance)\//.test(within)||within.startsWith('../'))throw new Error('Unknown workflow');
  const record=loadWorkflowRecord(path);
  if(!record||record.root!==path)throw new Error('Workflow record missing');
  if(record.protocolVersion===2)throw Object.assign(new Error('Resume this saved candidate to migrate it to the current workflow.'),{code:'WORKFLOW_MIGRATION_REQUIRED',migration:{action:'resume',workflow:path}});
  if(record.protocolVersion!==3)throw Object.assign(new Error('This legacy workspace is retained as evidence. Start a new task from an installed preset.'),{code:'WORKFLOW_LEGACY'});
  return record;
}
function assertInputs(record) {
  if(record.piVersion!==currentPiVersion())throw Object.assign(new Error('Pi changed since preparation; start a new task from the installed preset.'),{code:'WORKFLOW_RUNTIME_CHANGED'});
  if(sourceDigest(join(record.root,'base'))!==record.baseDigest||hash(JSON.stringify(treeIdentity(join(record.root,'inputs'))))!==record.inputsDigest||record.plan&&hash(readFileSync(record.plan))!==record.planHash)
    throw Object.assign(new Error('Frozen inputs or update plan changed; prepare a new workflow.'),{code:'WORKFLOW_INPUT_CHANGED'});
}
function activeWorkflowRoot(base) {
  const pointer=readJson(join(base,'current-workflow.json'));
  if(!pointer)return base;
  const root=resolve(pointer.root||''),path=relative(base,root).split('\\').join('/');
  if(path!==''&&!/^runs\/[a-f0-9-]{36}$/.test(path))throw new Error('Invalid workflow pointer');
  return root;
}
export function currentWorkflowRoot(store,profile,mode='maintain'){return activeWorkflowRoot(maintenancePaths(store,profile,mode).root);}
function nextRoot(base,mode,request,inputDigest) {
  const root=activeWorkflowRoot(base),record=readJson(join(root,'workflow.json'));
  if(!existsSync(root))return root;
  if((editable(record)||['WAITING_INPUT','PLAN_APPROVED'].includes(record?.status)&&record.planReview)&&record.piVersion===currentPiVersion()){
    if(record.mode!==mode||mode==='maintain'&&record.request!==request)throw new Error('此预设已有未完成任务：'+record.request+'；'+root);
    if(inputDigest&&inputDigest!==record.inputDigest)throw new Error('来源已变化；未完成任务保留在：'+root);
    return root;
  }
  const next=join(base,'runs',randomUUID());writeJson(join(base,'current-workflow.json'),{root:next});return next;
}
async function locked(root,callback) {
  const lock=join(root,'.workflow-lock'),token=randomUUID(),pending=join(root,'.lock-'+token);
  const owner={pid:process.pid,token};
  writeJson(pending,owner);
  const acquire=()=>linkSync(pending,lock); // A complete owner becomes visible atomically.
  try{
    try{acquire();}catch(error){
      if(error.code!=='EEXIST')throw error;
      const info=lstatSync(lock),prior=readJson(info.isDirectory()?join(lock,'owner.json'):lock);
      let alive=false;if(prior?.pid){try{process.kill(prior.pid,0);alive=true;}catch(e){if(e.code!=='ESRCH')alive=true;}}
      if(alive)throw Object.assign(new Error('Workflow is busy; inspect details after the current operation finishes.'),{code:'WORKFLOW_BUSY'});
      rmSync(lock,{recursive:true,force:true});acquire();
    }
    try{return await callback();}finally{if(readJson(lock)?.token===token)rmSync(lock,{force:true});}
  }finally{rmSync(pending,{force:true});}
}

function batchesFor(plan,request) {
  if(!plan)return [{id:'maintain',title:request,required:[],files:[],status:'pending'}];
  const batches=[];
  if(plan.runtime){
    batches.push({id:'runtime',title:'Check candidate loading on Pi '+plan.runtime.installed,required:[],files:[],runtimeBaseline:true,runtime:plan.runtime});
    for(const review of plan.runtime.reviews)batches.push({id:review.id,title:review.title,required:[review.id],files:[],runtimeReviews:[review]});
  }
  for(const name of new Set(plan.files.map(f=>f.skill))){
    const files=plan.files.filter(f=>f.skill===name);
    batches.push({id:'skill:'+name,title:name==='preset'?'Preset changes':name,required:['skill:'+name],files:files.map(f=>f.path),repo:files[0]?.repo});
  }
  for(const capability of plan.capabilities){
    if(capability.kind==='new-skills')batches.push({id:'new-skills:'+capability.repo,title:'New skills ('+capability.paths.length+')',required:newSkillDecisions(capability).map(d=>d.id),files:[],repo:capability.repo,capability});
    else if(capability.kind==='source-update'&&plan.capabilities.some(c=>c.repo===capability.repo&&c.kind==='new-skills'))continue;
    else if(capability.kind==='preset-update'){
      const existing=batches.find(b=>b.repo===capability.repo);
      if(existing)existing.capabilities=[...(existing.capabilities||[]),capability];
      else batches.push({id:'capability:'+capability.kind+':'+(capability.skill||capability.repo),title:capability.kind,required:['capability:'+capability.kind+':'+(capability.skill||capability.repo)],files:[],repo:capability.repo,capability});
    }
    else batches.push({id:'capability:'+capability.kind+':'+(capability.skill||capability.repo),title:capability.kind,required:['capability:'+capability.kind+':'+(capability.skill||capability.repo)],files:[],repo:capability.repo,capability});
  }
  for(const pkg of plan.packages.filter(p=>p.changed))batches.push({id:'package:'+pkg.name,title:pkg.name,required:['package:'+pkg.name],files:[],package:pkg});
  if(request.trim())batches.push({id:'requested',title:'Requested integration',required:['request'],files:[]});
  return batches.map(b=>({...b,status:'pending'}));
}
const current=r=>r.batches.find(b=>b.status!=='verified');
function activateBatch(record) {
  const batch=current(record);if(!batch||batch.started)return;
  assertInputs(record);
  const plan=record.plan?readJson(record.plan):null;
  for(const item of plan?.files.filter(f=>batch.files.includes(f.path)&&(f.action==='APPLY'||f.merge==='CLEAN'))||[]){
    if(batch.activated?.includes(item.path))continue;
    if(managedFiles.has(item.path))continue;
    const path=join(record.source,item.path);mkdirSync(dirname(path),{recursive:true});cpSync(item.review.merged||item.review.upstream,path);chmodSync(path,(item.mergedMode||item.targetMode)==='100755'?0o755:0o644);
  }
  batch.activated=[...batch.files];batch.started=true;save(record);
}
function taskText(record){return [
  '# '+record.mode+' '+record.name,
  record.mode==='maintain'?record.request:'Judge the current incoming capabilities: adopt the original, adapt it for native Pi, or defer. Preserve local features.',
  workflowContract,
  'Choose only affected behavior checks ({command,args,reason}); the tool installs actual candidate dependencies and loads selected extensions. Resource declarations and lineage are compiled by the program. Native Pi owns models/auth and program upgrades.',
  'Save partial decisions and bounded submission.work while editing independent work. Link every requested outcome and required adaptation to its origins, goal, paths and checks. ready:true claims implementation; check runs affected checks without installation eligibility. Record a named missingFact before expanding investigation. Final verify checks complete coverage and current claims; repair its reported failures. Install only at READY_TO_INSTALL with existing user authorization. NO_UPDATE, REVIEWED and INSTALLED finish the task.',
].join('\n\n')+'\n';}
function handoff(record) {
  record.batches||=[];record.accepted||=[];record.resources||=[];
  const batch=current(record),plan=record.plan?readJson(record.plan):null,items=ensureWorkExecution(record),focus=focusedWorkflowItem(record);
  const pkg=readJson(join(record.source,'package.json'),{});
  writeJson(join(record.root,'resource-table.json'),record.resources);
  const focusedFiles=record.execution==='change-list'?focus?.files:batch?.files;
  const relevant=record.resources.filter(r=>record.mode==='maintain'||focusedFiles?.some(p=>p===r.path||p.startsWith(r.path+'/'))||r.kind==='extensions'&&(batch?.runtime||record.mode==='maintain'));
  const requestFile=join(record.root,'REQUEST.md'),scopedRequest=existsSync(requestFile);
  const allDecisions=batch&&plan?plan.files.filter(f=>batch.files.includes(f.path)).map(({path,skill,action,reason,inputs,review,preservedFeatures,merge})=>({path,skill,action,reason,inputs,review,preservedFeatures,merge})):[];
  const allCapabilities=(batch?.capabilities||[batch?.capability]).filter(Boolean).map(c=>Object.fromEntries(Object.entries(c).filter(([k])=>k!=='diff')));
  const allPackages=batch?.packages||(batch?.package?[batch.package]:[]),allRuntimeReviews=batch?.runtimeReviews;
  const allReleaseNotes=(plan?.releaseNotes||[]).filter(n=>batch?.runtime&&!batch.runtimeBaseline&&n.id==='runtime'||(batch?.packages||[batch?.package]).some(p=>p&&n.id==='package:'+p.name)||(batch?.repos||[batch?.repo]).some(repo=>repo&&(n.repo===repo||n.id==='upstream:'+repo)));
  const capabilityId=c=>'capability:'+c.kind+':'+(c.skill||c.repo);
  const focusedRequired=[...(focus?.required||[]),...(focus?.origins||[])];
  const capabilities=record.execution==='change-list'?(focus?allCapabilities.filter(c=>focusedRequired.includes(capabilityId(c))||focus.repo&&c.repo===focus.repo||focus.id==='new-skills:'+c.repo):[]):allCapabilities;
  const packages=record.execution==='change-list'?(focus?allPackages.filter(p=>focusedRequired.includes('package:'+p.name)):[]):allPackages;
  const runtimeReviews=record.execution==='change-list'&&focus?.id!=='runtime-review'?undefined:allRuntimeReviews;
  const releaseNotes=record.execution==='change-list'?(focus?allReleaseNotes.filter(n=>focus.id==='runtime-review'&&n.id==='runtime'||packages.some(p=>n.id==='package:'+p.name)||focus.repo&&(n.repo===focus.repo||n.id==='upstream:'+focus.repo)):[]):allReleaseNotes;
  const response={protocolVersion:3,status:record.status,kind:record.mode,execution:record.execution,request:record.execution==='change-list'||record.mode==='maintain'||batch?.id==='requested'||!scopedRequest?record.request:undefined,
    ...(record.request&&scopedRequest?{requestFile}:{}),modelRequired:record.status==='REVIEW_REQUIRED',handle:workflowHandle(record),nextCall:nextWorkflowCall(record,allDecisions),contract:workflowContract,
    workspace:{root:record.root,source:record.source},revision:record.revision,skills:workflowSkills(record),profile:record.profile?{id:record.profile,name:record.name}:undefined,
    ...(record.migratedFrom?{migratedFrom:record.migratedFrom}:{}),
    batch:batch&&{id:batch.id,title:batch.title,position:record.batches.indexOf(batch)+1,total:record.batches.length,remaining:record.batches.filter(b=>b.status!=='verified').length,completion:batch.runtimeBaseline?'Repair the loading failure and probe; the program records the result.':'Save focused decisions and affected checks; verify after complete coverage.'},
    completed:record.accepted.map(e=>({id:e.id,...(e.automatic?{automatic:e.automatic}:{}),summary:e.submission.summary.slice(0,400),decisions:e.submission.decisions.map(({id,action})=>({id,action}))})),
    findings:(record.findings||[]).slice(-24),baselineDiagnostics:record.baselineDiagnostics,
    progress:record.progress,stopReason:record.stopReason,items:items.map(item=>({...item,status:record.itemStates[item.id]?.status||'pending',...(record.itemStates[item.id]?.blocker?{blocker:record.itemStates[item.id].blocker}:{}),...(record.itemStates[item.id]?.previousBlocker?{previousBlocker:record.itemStates[item.id].previousBlocker}:{})})),saved:record.draft,
    focus:record.execution==='change-list'&&focus?{...focus,requiredDecisions:focus.required,status:record.itemStates[focus.id]?.status,...(record.itemStates[focus.id]?.blocker?{blocker:record.itemStates[focus.id].blocker}:{}),...(record.itemStates[focus.id]?.previousBlocker?{previousBlocker:record.itemStates[focus.id].previousBlocker}:{})}:undefined,
    recoveryStep:record.recoveryStep,planReview:record.planReview,requiredDecisions:batch?.required||[],resources:relevant,resolvedResources:record.execution==='change-list'||record.mode==='maintain'||batch?.id==='requested'?(record.resolvedResources||[]).filter(r=>r.kind==='extensions'):undefined,discoveryDiagnostics:record.discoveryDiagnostics,resourceCatalog:join(record.root,'resource-table.json'),
    decisions:record.execution==='change-list'?(focus?allDecisions.filter(item=>focus.files.includes(item.path)||focusedRequired.includes('skill:'+item.skill)):[]):allDecisions,
    runtime:record.execution==='change-list'&&focus?.id!=='runtime-review'?undefined:batch?.runtimeBaseline?{before:batch.runtime.before,installed:batch.runtime.installed,scope:'Loading only. Repair the reported failure, then probe; feature review and requested integration remain separate.'}:batch?.runtime,
    runtimeBaseline:batch?.runtimeBaseline,runtimeReviews,capabilities,packages,releaseNotes,
    context:{cwd:record.source,declaration:join(record.source,'preset.json'),...(record.planReview?.phase==='approved'?{localPackageAlias:Object.entries(readJson(join(record.source,'preset.json')).packages||{}).find(([,entry])=>entry.source==='.')?.[0]}:{}),entrypoints:Object.fromEntries(Object.entries(pkg.pi||{}).map(([kind])=>[kind,relevant.filter(r=>r.kind===kind).map(r=>r.path)])),
      pi:{version:record.piVersion,api:join(dirname(currentPiCli()),'core/extensions/types.d.ts'),docs:join(dirname(dirname(currentPiCli())),'docs')},
      wardrobe:{docs:join(dirname(import.meta.dirname),'README.md'),presentation:{event:'wardrobe:preset',payload:'{profile:{id,name,version},ui}',timing:'Subscribe before session_start; switches start a new runtime.',subscribe:'pi.events.on(event,listener) returns unsubscribe',defaultWidget:'wardrobe',clearDefault:'ui.setWidget("wardrobe", undefined)',nativeStatus:'ui.setStatus(key,text)',cleanup:'Unsubscribe on session_shutdown'}},
      verification:{isolation:'Disposable HOME/Pi without credentials. Checks run in the actual materialized candidate package with its exact dependencies.',cli:currentPiCli()}},
    task:join(record.root,'TASK.md'),next:record.status==='READY_TO_INSTALL'?'Call wardrobe_workflow install for this workflow; revision stays inactive.':batch?'Focus an item, edit as needed and save its decisions. Verify after complete coverage.':'Task finished.'};
  if(record.execution==='change-list'&&batch){
    const index=join(record.root,'changes.json');
    writeJson(index,{items:batch.items,decisions:allDecisions,runtimeReviews:allRuntimeReviews,capabilities:allCapabilities,packages:allPackages,releaseNotes:allReleaseNotes});
    response.changes=index;
  }
  if(batch)response.material=packetFor(record,response);
  return response;
}

export async function focusWorkflow(store,root,itemId){return locked(root,async()=>{
  const record=workflowRecord(store,root);assertInputs(record);if(!editable(record))throw Error('Resume this workflow before focusing an item');
  const items=ensureWorkExecution(record),item=items.find(candidate=>candidate.id===itemId);
  if(!item)throw Object.assign(Error('Unknown work item: '+itemId),{code:'WORKFLOW_ITEM_UNKNOWN'});
  const changed=record.focusId!==item.id;record.focusId=item.id;
  if(!finishedItem(record.itemStates[item.id])&&record.itemStates[item.id].status!=='blocked'&&!item.workId)record.itemStates[item.id].status='in_progress';
  if(changed){const prior=record.itemStates[item.id].progress||{};record.progress={...(record.progress||{}),nativeContinuations:prior.nativeContinuations||0,nativeCorrections:prior.nativeCorrections||0,consecutiveFailures:0,lastFailureSignature:undefined};}
  record.revision++;save(record,{type:'workflow.item-focused',payload:{itemId:item.id}});return handoff(record);
});}
function receiptKey(record,plan){return hash(JSON.stringify({base:record.baseDigest,pi:record.piVersion,repos:plan.repositories.map(r=>[r.repo,r.target]),packages:plan.packages.map(p=>[p.name,p.latest])}));}

export async function beginWorkflow(store,{profile,source,mode='update',request='',signal,review}) {
  if(!['update','maintain'].includes(mode))throw new Error('Unknown workflow mode');
  if(source&&!profile){
    source=resolve(source);const prepared=readJson(join(dirname(source),'workflow.json'));
    if(prepared?.source===source){const record=workflowRecord(store,prepared.root);if(record.mode!==mode)throw new Error('Continue the original '+record.mode+' workflow');assertInputs(record);reopenChanged(record);return handoff(record);}
  }
  if(mode==='maintain'&&!request.trim())throw new Error('请说明要修复的问题或增加的能力');
  const inputDigest=source?sourceDigest(resolve(source)):null;
  const base=profile?maintenancePaths(store,profile,mode).root:join(store.root,mode==='update'?'updates':'maintenance',hash(resolve(source||'')).slice(0,16));
  const root=nextRoot(base,mode,request,inputDigest),existing=readJson(join(root,'workflow.json'));
  if(existing){const record=workflowRecord(store,root);assertInputs(record);reopenChanged(record);return handoff(record);}
  let workspace;
  if(profile)workspace=await prepareMaintenance(store,{...profile,workflowRoot:root},{mode,request});
  else {
    source=resolve(source||'');if(!existsSync(join(source,'preset.json')))throw new Error('Import a standard preset source first.');
    mkdirSync(root,{recursive:true,mode:0o700});cpSync(source,join(root,'source'),{recursive:true,filter:publicSource});cpSync(source,join(root,'base'),{recursive:true,filter:publicSource});
    writeJson(join(root,'inventory.json'),{customSkills:readJson(join(source,'components.json'),{}).skills||{}});
    workspace={root,source:join(root,'source'),name:readJson(join(source,'preset.json')).name,origin:{kind:'local'},upstream:{kind:'local'}};
  }
  const record={...workspace,root:resolve(root),mode,request,inputDigest,name:workspace.name||profile?.name,profile:profile?.id||null,status:'REVIEW_REQUIRED',protocolVersion:3,workflowVersion:5,execution:'change-list',revision:0,piVersion:currentPiVersion(),accepted:[],resources:resourceTable(workspace.source),startupDefault:store.read().default};
  if(mode==='update'&&review==='human')record.planReview={phase:'draft'};
  inspectPublicSource(record.source);
  compileResources(record.source,record.resources);
  const available=readJson(join(root,'inventory.json'),{}).installedPackages||[];
  const own=Object.entries(readJson(join(record.source,'preset.json')).packages).find(([,v])=>v.source==='.')?.[0];
  const inventory=[{alias:own,installedPath:record.source},...available.filter(p=>p.alias!==own).map(p=>({alias:p.alias,installedPath:p.root}))];
  const known=new Set(inventory.map(p=>p.alias));
  record.resolvedResources=[];
  if(existsSync(join(dirname(currentPiCli()),'core/package-manager.js')))try{
    record.resolvedResources=await checkNativeResourceExports({plan:{installationSurfaces:inventory,resourceSelectors:record.resources.filter(r=>r.enabled&&known.has(r.package)).map(r=>({package:r.package,kind:r.kind,loaded:[r.path]}))},inventory,cli:currentPiCli(),inspectionRoot:join(root,'resource-discovery')});
  }catch(error){record.discoveryDiagnostics={code:error.code||'RESOURCE_DISCOVERY',message:error.message,resources:error.resources};}
  const expanded=record.resources.flatMap(r=>r.enabled&&record.resolvedResources.some(leaf=>leaf.package===r.package&&leaf.kind===r.kind&&leaf.selectors.includes(r.path))
    ?record.resolvedResources.filter(leaf=>leaf.package===r.package&&leaf.kind===r.kind&&leaf.selectors.includes(r.path)).map(({package:alias,kind,path})=>({package:alias,kind,path,enabled:true})):r);
  record.resources=[...new Map(expanded.map(r=>[JSON.stringify([r.package,r.kind,r.path]),r])).values()];compileResources(record.source,record.resources);
  rmSync(join(root,'base'),{recursive:true,force:true});cpSync(record.source,join(root,'base'),{recursive:true,filter:publicSource});
  record.baseDigest=sourceDigest(join(root,'base'));
  if(mode==='update'){
    const plan=await planPresetUpdate({source:record.source,cacheDir:join(store.root,'upstream-cache'),piVersion:record.piVersion,origin:record.upstream||record.origin,registry:nativeEnv(store).WARDROBE_REGISTRY});
    await prepareUpdateContext(plan,{root,piRoot:dirname(dirname(currentPiCli())),docsCache:join(store.root,'upstream-notes'),env:nativeEnv(store),profile});
    if(plan.status==='REVIEW_REQUIRED'){
      // Produce immutable three-way inputs, without exposing future safe changes in the candidate.
      const temp=join(root,'prepare-inputs');cpSync(record.source,temp,{recursive:true,filter:publicSource});
      try{applyUpdatePlan(plan,temp,join(root,'inputs'));}finally{rmSync(temp,{recursive:true,force:true});}
    }
    record.inputsDigest=hash(JSON.stringify(treeIdentity(join(root,'inputs'))));
    record.plan=join(root,'update-plan.json');writeJson(record.plan,plan);record.planHash=hash(readFileSync(record.plan));
    record.receipt=join(store.root,'review-receipts',receiptKey(record,plan)+'.json');
    record.batches=batchesFor(plan,request);
    if(plan.status==='NO_UPDATE')record.batches=record.batches.filter(batch=>batch.id==='requested');
    if(plan.status==='BLOCKED'||!record.batches.length||existsSync(record.receipt)&&!request.trim()){
      record.status=plan.status==='BLOCKED'?'BLOCKED':'NO_UPDATE';save(record);
      return {protocolVersion:3,status:record.status,modelRequired:false,message:record.status==='NO_UPDATE'?'无需更新':'更新来源不可用',blocked:plan.blocked,runtime:plan.runtime,metrics:plan.metrics,workspace:{root,source:record.source}};
    }
  }else {record.batches=batchesFor(null,request);record.inputsDigest=hash(JSON.stringify(null));}
  writeFileSync(join(root,'TASK.md'),taskText(record),{mode:0o600});
  if(request)writeFileSync(join(root,'REQUEST.md'),request,{mode:0o600});
  if(!current(record)?.runtimeBaseline)record.batches=changeList(record.batches,record.plan?readJson(record.plan):null);
  ensureWorkExecution(record);save(record);activateBatch(record);
  // A runtime change has a mandatory zero-model loading check. Other starts
  // remain plan-only; capability review never implies successful loading.
  if(current(record)?.runtimeBaseline)return locked(root,()=>completeRuntimeBaseline(store,record,signal));
  return handoff(record);
}

/** Resume a saved candidate. v2 is copied into a side-by-side v3 record so its
 * original journal, source and verification receipts remain immutable evidence. */
export async function proposeWorkflow(store,root,proposal,{confirm}={}){
  const pending=await locked(root,()=>{
    const record=workflowRecord(store,root);assertInputs(record);
    if(!editable(record)||record.planReview?.phase!=='draft'||current(record)?.runtimeBaseline)
      throw Object.assign(Error('Start an update in human review mode or resume its saved report.'),{code:'WORKFLOW_PROPOSAL_UNAVAILABLE'});
    const report=renderCapabilityReport(proposal);
    record.planReview={phase:'pending',report,sourceDigest:sourceDigest(record.source)};
    record.status='WAITING_INPUT';record.revision++;
    save(record,{type:'workflow.proposal-presented'});
    return handoff(record);
  });
  return confirmWorkflowProposal(store,root,pending,confirm);
}

async function confirmWorkflowProposal(store,root,pending,confirm){
  if(!confirm||await confirm(updateReviewTitle,pending.planReview.report)!==true)return pending;
  return locked(root,()=>{
    const record=workflowRecord(store,root);assertInputs(record);
    if(record.revision!==pending.revision||record.planReview?.phase!=='pending'||record.planReview.sourceDigest!==sourceDigest(record.source))
      throw Object.assign(Error('The proposal or candidate changed. Resume with revise:true to prepare a fresh report.'),{code:'WORKFLOW_PROPOSAL_STALE'});
    record.planReview={...record.planReview,phase:'approved'};
    record.status='PLAN_APPROVED';record.revision++;
    record.stopReason='The user confirmed the report. Start a separate implementation turn with resume.';
    save(record,{type:'workflow.proposal-approved'});
    return handoff(record);
  });
}

export async function resumeWorkflow(store,workflow,{confirm,revise=false}={}){
 const result=await locked(workflow,async()=>{
  const legacyRoot=resolve(workflow),within=relative(store.root,legacyRoot).replaceAll('\\','/');
  if(!/^(updates|maintenance)\//.test(within)||within.startsWith('../'))throw new Error('Unknown workflow');
  const legacy=loadWorkflowRecord(legacyRoot);
  if(legacy.protocolVersion===3){
    const pending=legacy.planReview?.phase==='pending',approved=legacy.status==='PLAN_APPROVED';
    if(!pending&&!(approved&&revise))return continueWorkflow(store,legacyRoot);
    assertInputs(legacy);
    if(!revise)return handoff(legacy);
    legacy.planReview={phase:'draft',previousReport:legacy.planReview.report};
    legacy.status='REVIEW_REQUIRED';delete legacy.stopReason;legacy.revision++;
    save(legacy,{type:'workflow.proposal-reopened'});
    return handoff(legacy);
  }
  if(legacy.protocolVersion!==2)throw Object.assign(new Error('This workflow version cannot be migrated.'),{code:'WORKFLOW_VERSION_UNSUPPORTED'});
  if(terminal.has(legacy.status)&&!current(legacy))throw Object.assign(new Error('This saved workflow is already finished.'),{code:'WORKFLOW_CLOSED'});
  const runtimeChanged=legacy.piVersion!==currentPiVersion();
  const root=join(store.root,'updates','migrated',randomUUID());mkdirSync(root,{recursive:true,mode:0o700});
  for(const name of ['source','base','inputs','checkpoints'])if(existsSync(join(legacyRoot,name)))cpSync(join(legacyRoot,name),join(root,name),{recursive:true,filter:name==='source'||name==='base'?publicSource:undefined});
  const record={...legacy,root,source:join(root,'source'),protocolVersion:3,workflowVersion:4,revision:(legacy.revision||0)+1,
    migratedFrom:{protocolVersion:2,root:legacyRoot,revision:legacy.revision||0,at:new Date().toISOString()},
    accepted:(legacy.accepted||[]).map(entry=>({...entry,checks:[],evidence:[]})),
    baseDigest:sourceDigest(join(root,'base')),inputsDigest:hash(JSON.stringify(treeIdentity(join(root,'inputs')))),
    checkpoint:existsSync(join(root,'checkpoints',String(legacy.revision)))?join(root,'checkpoints',String(legacy.revision)):undefined,
    status:'REVIEW_REQUIRED',piVersion:currentPiVersion(),...(runtimeChanged?{runtimeChangedFrom:legacy.piVersion}:{})};
  delete record.stage;delete record.pendingRegistrations;
  if(record.plan){record.plan=resolve(record.plan);record.planHash=hash(readFileSync(record.plan));}
  writeJson(join(root,'TASK.md'),taskText(record));save({...record,root},{type:'workflow.migrated',payload:{from:legacyRoot,fromRevision:legacy.revision||0,oldEvidenceInvalidated:true}});
  return handoff(loadWorkflowRecord(root));
 });
 return result.planReview?.phase==='pending'?confirmWorkflowProposal(store,workflow,result,confirm):result;
}

async function continueWorkflow(store,root){
  const record=workflowRecord(store,root);
  if(['NO_UPDATE','REVIEWED','INSTALLED'].includes(record.status))throw Object.assign(new Error('This workflow is already finished.'),{code:'WORKFLOW_CLOSED'});
  if(!current(record))throw Object.assign(new Error('There is no pending work to resume.'),{code:'WORKFLOW_CLOSED'});
  assertInputs(record);
  const startingImplementation=record.status==='PLAN_APPROVED';
  if(startingImplementation&&record.planReview?.sourceDigest&&record.planReview.sourceDigest!==sourceDigest(record.source))
    throw Object.assign(Error('The candidate changed after confirmation. Resume with revise:true to prepare a fresh report.'),{code:'WORKFLOW_PROPOSAL_STALE'});
  record.status='REVIEW_REQUIRED';delete record.stopReason;record.revision++;
  const items=ensureWorkExecution(record),retry=items.find(item=>item.id===record.pausedItemId&&record.itemStates[item.id]?.status==='blocked');
  if(startingImplementation)for(const item of items)delete record.itemStates[item.id].progress;
  if(retry){const prior=record.itemStates[retry.id];record.itemStates[retry.id]={...prior,status:'in_progress',previousBlocker:prior.blocker,blocker:undefined,progress:{turns:0,sinceActivity:0,sinceDelivery:0,recoveryIssuedAt:null}};record.focusId=retry.id;}
  delete record.pausedItemId;
  record.progress={...(record.progress||{}),assistantTurns:0,sinceEvidenceProgress:0,sinceDeliveryProgress:0,recoveryIssuedAt:null,recoveryMessage:null,repeatedFailureCount:0,nativeContinuations:0,nativeCorrections:0,consecutiveFailures:0,lastFailureSignature:undefined,unfocused:{turns:0,sinceActivity:0,sinceDelivery:0,recoveryIssuedAt:null}};
  record.continuations=(record.continuations||0)+1;save(record,{type:'workflow.resumed',payload:{continuation:record.continuations,status:record.status}});
  activateBatch(record);return handoff(record);
}

/** Persist one native assistant turn and apply per-focus activity and delivery policy. */
export async function recordWorkflowTurn(store,root,{newObservations=[],failureSignature=null,outcome='completed',errorText='',stopReason=''}={}){return locked(root,async()=>{
  const record=workflowRecord(store,root);if(!editable(record))return {status:record.status,progress:record.progress};
  const progress={assistantTurns:0,totalAssistantTurns:0,sinceEvidenceProgress:0,sinceDeliveryProgress:0,recoveryIssuedAt:null,acceptedCount:record.accepted.length,...record.progress};
  if(outcome==='aborted'){record.status='INTERRUPTED';record.stopReason='User cancelled the current model run';record.progress=progress;save(record,{type:'workflow.interrupted'});return {status:record.status,progress};}
  if(/(?:429|rate.?limit|quota|token plan.*limit|usage limit)/i.test(errorText)){record.status='SUSPENDED_QUOTA';record.stopReason='Provider quota requires native Pi recovery';record.progress=progress;save(record,{type:'workflow.quota-suspended'});return {status:record.status,progress};}
  progress.assistantTurns++;progress.totalAssistantTurns++;
  if(record.execution==='change-list'){
    const items=ensureWorkExecution(record),focus=focusedWorkflowItem(record),digest=hash(sourceDigest(record.source)+deliveryIdentity(record));
    const seen=progress.seenWork||[],delivered=!seen.includes(digest),active=delivered||newObservations.length>0;
    if(delivered){progress.seenWork=[...seen,digest].slice(-256);progress.nativeContinuations=0;progress.nativeCorrections=0;}
    progress.workDigest=digest;
    const prior=focus?record.itemStates[focus.id].progress||{}:progress.unfocused||{},currentProgress=advanceWorkProgress(prior,{active,delivered});
    currentProgress.nativeContinuations=progress.nativeContinuations||0;currentProgress.nativeCorrections=progress.nativeCorrections||0;
    if(focus)record.itemStates[focus.id].progress=currentProgress;else progress.unfocused=currentProgress;
    progress.sinceEvidenceProgress=currentProgress.sinceActivity;progress.sinceDeliveryProgress=currentProgress.sinceDelivery;progress.recoveryIssuedAt=currentProgress.recoveryIssuedAt;
    if(failureSignature){progress.consecutiveFailures=(progress.consecutiveFailures||0)+1;progress.lastFailureSignature=failureSignature;}else{progress.consecutiveFailures=0;delete progress.lastFailureSignature;}
    progress.recoveryMessage=failureSignature?'A tool call failed. Pi returns the native failure to the model; issue a corrected or different call instead of repeating unchanged input.':currentProgress.recoveryIssuedAt===null?null:focus?'The current focus has not produced durable work. '+implementationAdvice(record,focus)+' New observations alone do not reset delivery progress.':'No focus has produced durable work. Focus an available item, then save a concrete decision or candidate change; new observations alone do not reset delivery progress.';
    if(workRecoveryDue(currentProgress)){
      const stalled=focus?.id||null,next=availableWorkflowItems(record).find(item=>item.id!==stalled);
      // Investigation must not consume error correction. Neither budget is
      // renewed by successful reads, so alternating errors and reads is bounded.
      const budget=failureSignature?'nativeCorrections':'nativeContinuations';
      progress[budget]=(progress[budget]||0)+1;
      currentProgress[budget]=progress[budget];
      const correcting=stopReason==='toolUse'&&failureSignature&&progress.consecutiveFailures<3&&progress.nativeCorrections<=2;
      if(correcting||(!next&&!failureSignature&&stopReason==='toolUse'&&progress.nativeContinuations<=2)){
        record.progress=progress;save(record,{type:'workflow.recovery',payload:{itemId:stalled,status:record.status,failures:progress.consecutiveFailures}});
        return {status:record.status,progress,stopReason:record.stopReason};
      }
      record.progress=progress;
      if(pauseFocusedWork(record,{reason:'No candidate or saved-review delivery after bounded recovery',nextStep:'Resume this item with a concrete repair or decision, or focus independent work.'})){
        save(record,{type:'workflow.item-stalled',payload:{itemId:stalled,nextItemId:record.focusId,status:record.status}});
        return {...handoff(record),stopReason:record.stopReason};
      }
      record.status='STALLED';record.stopReason=focus?'No durable delivery after bounded recovery; no independent work remains':'No focused durable delivery after bounded recovery';
    }
    record.progress=progress;save(record,{type:record.status==='STALLED'?'workflow.stalled':'workflow.turn',payload:{itemId:focus?.id,status:record.status}});return {status:record.status,progress,stopReason:record.stopReason};
  }

  progress.sinceEvidenceProgress=newObservations.length?0:progress.sinceEvidenceProgress+1;
  if(record.accepted.length>progress.acceptedCount){progress.acceptedCount=record.accepted.length;progress.sinceDeliveryProgress=0;progress.recoveryIssuedAt=null;progress.recoveryMessage=null;progress.repeatedFailureCount=0;}
  else progress.sinceDeliveryProgress++;
  if(failureSignature){if(progress.lastFailureSignature===failureSignature)progress.repeatedFailureCount=(progress.repeatedFailureCount||0)+1;else{progress.lastFailureSignature=failureSignature;progress.repeatedFailureCount=1;}}
  else progress.repeatedFailureCount=0;
  if(progress.recoveryIssuedAt===null&&(progress.sinceEvidenceProgress>=8||progress.sinceDeliveryProgress>=16||progress.repeatedFailureCount>=3)){
    progress.recoveryIssuedAt=progress.assistantTurns;
    progress.recoveryMessage='No verified progress. Read a specific missing input, repair a concrete failure, or submit the current decisions. Candidate edits and observations are saved automatically.';
  }else if(progress.recoveryIssuedAt!==null&&progress.assistantTurns-progress.recoveryIssuedAt>=8){
    record.status='STALLED';record.stopReason='No accepted delivery after bounded recovery';progress.stalledAt=progress.assistantTurns;
  }
  record.progress=progress;save(record,{type:record.status==='STALLED'?'workflow.stalled':'workflow.turn',payload:{assistantTurns:progress.assistantTurns,sinceEvidenceProgress:progress.sinceEvidenceProgress,sinceDeliveryProgress:progress.sinceDeliveryProgress,recoveryIssuedAt:progress.recoveryIssuedAt,status:record.status}});
  return {status:record.status,progress,stopReason:record.stopReason};
});}

/** Run the zero-model candidate probe on demand without accepting decisions. */
export async function probeWorkflow(store,root,{signal}={}){return locked(root,async()=>{
  const record=workflowRecord(store,root);assertInputs(record);
  if(current(record)?.runtimeBaseline){if(!editable(record))throw new Error('Resume this workflow before probing');return completeRuntimeBaseline(store,record,signal);}
  requireApprovedPlan(record);
  const stage=await stageCandidate(store,record,{decisions:[],resources:[],migrations:[],checks:[]});record.stage=stage;
  const self=stage.plan.installationSurfaces.find(s=>s.source==='.'),attempt=stage.record.attempts.at(-1),entry=attempt.installed.find(e=>e.alias===self.alias);
  const cwd=packageRootFor(stage.plan,{...entry,installedPath:entry.installedRelative?join(attempt.agentDir,entry.installedRelative):entry.installedPath}),probeRoot=join(root,'probe');mkdirSync(probeRoot,{recursive:true});
  const outcome=await executeCheck(nativeLoadCheck(probeRoot,stage.profile.agentDir),cwd,join(root,'probe.log'),join(root,'probe-runtime'));
  record.baselineDiagnostics={status:outcome.code===0?'READY':'BLOCKED_DEPENDENCY',outcome};save(record,{type:'workflow.probed',payload:{status:record.baselineDiagnostics.status}});return handoff(record);
});}

function reopenChanged(record) {
  const proof=readJson(join(record.root,'verification.json'));
  if(record.status==='READY_TO_INSTALL'&&proof?.digest!==sourceDigest(record.source)){
    record.batches.push({id:'recheck:'+record.revision,title:'Review candidate edits since verification',required:[],files:[],status:'pending'});
    record.status='REVIEW_REQUIRED';delete record.draft;record.revision++;save(record);
  }
}
export async function workflowDetails(store,root,{merge}={}){return locked(root,async()=>{
  const record=workflowRecord(store,root);assertInputs(record);
  reopenChanged(record);
  if(merge){
    if(!merge.reason?.trim()||!Array.isArray(merge.batches)||!merge.batches.length)throw new Error('Merge requires pending batch IDs and a relationship reason');
    const head=current(record);if(!head)throw new Error('No pending batch');
    const selected=merge.batches.map(id=>record.batches.find(b=>b.id===id));
    if(selected.some(b=>!b||b.status==='verified'||b===head)||new Set(selected).size!==selected.length)throw new Error('Only distinct pending batches can join the current batch');
    if([head,...selected].some(b=>b.runtimeBaseline||b.runtimeReviews?.length))throw new Error('Runtime loading and bounded release-note reviews must remain separate work items');
    Object.assign(head,combineWork([head,...selected]),{mergeReason:merge.reason,started:false});
    record.batches=record.batches.filter(b=>!selected.includes(b));record.revision++;save(record);activateBatch(record);
  }
  return {...handoff(record),...(current(record)?{}:{items:record.batches.map(({id,title,status})=>({id,title,status}))}),installed:record.installed};
});}
export async function generateWorkflowGuidance(store,root,names){return locked(root,async()=>{
  const record=workflowRecord(store,root);assertInputs(record);
  requireApprovedPlan(record);
  if(!editable(record))throw Error('Start from an editable workflow');
  const resources=writeWorkflowGuidance(record,names);record.resources=compileResources(record.source,record.resources,resources);
  record.generatedGuidance=[...new Set([...(record.generatedGuidance||[]),...names])];save(record);
  return {...handoff(record),generatedGuidance:record.generatedGuidance};
});}

export async function saveWorkflowReview(store,root,submission,{replace=false}={}){return locked(root,async()=>{
  const record=workflowRecord(store,root);assertInputs(record);
  requireApprovedPlan(record);
  if(!editable(record))throw Error('Resume this workflow before saving');
  const batch=current(record);
  if(!batch)throw Error('The review is sealed. Save decisions and checks before final verification.');
  if(batch.runtimeBaseline)throw Error('Probe the runtime loading failure before saving a legacy review.');
  const draft=prepareImplementation(record,mergeReview(replace?{work:record.draft?.work||[]}:record.draft,submission),submission);
  validateSubmission({...batch,required:draft.decisions.map(d=>d.id)},draft,{partial:true});
  if(draft.decisions.some(d=>!batch.required.includes(d.id)))throw Error('Unknown decision ID in saved review');
  validateFileDecisions(record,batch,draft);
  compileResources(record.source,record.resources,draft.resources,{persist:false});
  delete record.resourceRepair;record.draft=draft;applyWorkflowSubmission(record,submission);save(record,{type:'workflow.review-saved'});return handoff(record);
});}

export async function checkpointWorkflow(store,root,handle,findings=[],opId,observationIds=[]){return locked(root,async()=>{
  const record=workflowRecord(store,root);assertInputs(record);
  if(!editable(record))throw Object.assign(new Error('Workflow is closed'),{code:'WORKFLOW_CLOSED'});
  if(handle!==workflowHandle(record))throw Object.assign(new Error('Use the current work item handle'),{code:'WORKFLOW_STALE_SUBMISSION'});
  if(!Array.isArray(findings)||findings.length>12)throw new Error('Checkpoint accepts at most 12 findings or questions');
  if(!Array.isArray(observationIds)||observationIds.length>8||observationIds.some(id=>typeof id!=='string'))throw new Error('Retrieve at most 8 observations by ID');
  const cited=[...new Set([...observationIds,...findings.flatMap(f=>Array.isArray(f.observations)?f.observations:[])])];
  let retrieved;
  try{retrieved=readObservations(root,cited);}catch(error){throw Object.assign(new Error('Observation index cannot be trusted: '+error.message),{code:error.code||'WORKFLOW_OBSERVATION_INVALID'});}
  const observations=new Map(retrieved.map(item=>[item.id,item]));
  for(const finding of findings){
    if(finding.claim!==undefined&&(!finding.claim.trim()||!Array.isArray(finding.observations)||!finding.observations.length||finding.observations.some(id=>!observations.get(id)?.fresh)))
      throw Object.assign(new Error('Each finding must cite current observation IDs'),{code:'WORKFLOW_OBSERVATION_REQUIRED'});
    if(finding.question!==undefined&&(!finding.question.trim()||!finding.nextStep?.trim()))throw new Error('Open questions require a finite next step');
    if(finding.claim===undefined&&finding.question===undefined)throw new Error('Checkpoint finding needs a claim or question');
  }
  record.findings=[...(record.findings||[]),...findings.map(f=>({...f,itemId:current(record)?.id,revision:record.revision,at:new Date().toISOString()}))].slice(-48);
  save(record,{type:'workflow.findings',opId,payload:{itemId:current(record)?.id,count:findings.length}});
  return {...handoff(record),checkpoint:{saved:findings.length,findings:record.findings.filter(f=>f.itemId===current(record)?.id),observations:observationIds.map(id=>{const observation=observations.get(id);return observation?{id,tool:observation.tool,toolCallId:observation.toolCallId,content:observation.content,fresh:observation.fresh,...(observation.error?{error:observation.error}:{})}:{id,fresh:false,error:'Observation is absent or no longer available'};})}};
});}

function pauseFocusedWork(record,blocker){
  ensureWorkExecution(record);const focus=focusedWorkflowItem(record),next=availableWorkflowItems(record).find(item=>item.id!==focus?.id);
  if(focus){
    if(record.itemStates[focus.id].status!=='blocked'){
      record.pausedItemId=focus.id;record.itemStates[focus.id]={...record.itemStates[focus.id],status:'blocked',blocker:{...blocker,origin:'delivery'}};
    }
    record.focusId=null;
  }
  if(!next)return false;
  record.focusId=next.id;record.itemStates[next.id]={...record.itemStates[next.id],status:'in_progress'};
  const progress=record.progress||={},recovered=record.itemStates[next.id].progress||{};
  progress.sinceEvidenceProgress=recovered.sinceActivity||0;progress.sinceDeliveryProgress=recovered.sinceDelivery||0;progress.recoveryIssuedAt=recovered.recoveryIssuedAt??null;progress.recoveryMessage=null;progress.nativeContinuations=recovered.nativeContinuations||0;progress.nativeCorrections=recovered.nativeCorrections||0;progress.consecutiveFailures=0;delete progress.lastFailureSignature;
  record.status='REVIEW_REQUIRED';delete record.stopReason;record.revision++;
  return true;
}

export async function pauseIncompleteWorkflow(store,root){return locked(root,async()=>{
  const record=workflowRecord(store,root);
  if(editable(record)){
    const blocker={reason:'Model settled twice without completing the current work item',nextStep:'Resume with a concrete decision, repair or finite blocker.'};
    if(pauseFocusedWork(record,blocker)){save(record,{type:'workflow.incomplete',payload:{nextItemId:record.focusId}});return handoff(record);}
    record.status='STALLED';record.stopReason=blocker.reason;
    save(record,{type:'workflow.incomplete'});
  }
  return {status:record.status,stopReason:record.stopReason};
});}

function validateSubmission(batch,submission,{partial=false}={}) {
  if(!submission||!partial&&(!submission.summary?.trim()||!Array.isArray(submission.decisions)||!Array.isArray(submission.checks)))throw new Error('Submit summary, decisions and affected checks');
  if(submission.decisions!==undefined&&!Array.isArray(submission.decisions)||submission.checks!==undefined&&!Array.isArray(submission.checks))throw new Error('Decisions and checks must be lists');
  const decisions=submission.decisions||[],checks=submission.checks||[];
  for(const id of batch.required)if(!decisions.some(d=>d.id===id&&['adopt','adapt','defer'].includes(d.action)&&d.reason?.trim()))throw new Error('Missing capability/local decision: '+id);
  if(decisions.some(d=>!batch.required.includes(d.id))||new Set(decisions.map(d=>d.id)).size!==decisions.length)throw new Error('Decisions must match the current batch only');
  if(decisions.some(d=>d.id==='request'&&d.action==='defer'))throw new Error('Explicit requested work is required. Repair it or leave the workflow pending; it cannot be deferred into completion.');
  if(batch.runtimeReviews?.some(r=>r.status!=='READY'&&decisions.some(d=>d.id===r.id&&d.action==='defer')))throw new Error('Missing runtime release evidence cannot be treated as an optional capability; resolve it before completing this review.');
  checks.forEach(validateCheck);
  if(submission.obligations!==undefined&&!Array.isArray(submission.obligations))throw new Error('Obligations must be a list');
  for(const obligation of submission.obligations||[])if(obligation.type!=='presentation'||!['statusline','composer'].includes(obligation.location)||obligation.contains!=='profile-name'||obligation.unique!==true||obligation.reload!==true)
    throw new Error('Presentation obligation must define profile-name, unique rendering and reload behavior');
}
function validateFileDecisions(record,batch,submission) {
  const plan=record.plan?readJson(record.plan):null;
  for(const path of batch.files){
    if(managedFiles.has(path))continue;
    const item=plan?.files.find(f=>f.path===path),decision=submission.decisions.find(d=>d.id==='skill:'+item?.skill);
    if(decision?.action!=='adopt')continue;
    const file=join(record.source,path),actual=existsSync(file)?readFileSync(file):null;
    // These are the possible program-prepared versions. Anything else is a
    // candidate edit; adopting the raw upstream file would discard that work.
    const versions=[join(record.root,'base',path),item.review?.upstream,item.review?.merged].filter(Boolean);
    if(versions.some(version=>{
      const bytes=version&&existsSync(version)?readFileSync(version):null;
      return actual===null?bytes===null:bytes!==null&&actual.equals(bytes);
    }))continue;
    throw Object.assign(new Error(`${decision.id}: ${path} contains candidate edits; use adapt to retain them. adopt copies the upstream original during verify. To replace the adaptation intentionally, first restore the reviewed local or upstream file.`),{
      code:'WORKFLOW_ADOPTION_CONFLICT',diagnostics:[{path,decisionId:decision.id,action:'adopt',recommendedAction:'adapt'}],
    });
  }
}
function applyFileDecisions(record,batch,submission) {
  const plan=record.plan?readJson(record.plan):null;
  const pkgFile=join(record.source,'preset.json'),definition=readJson(pkgFile),manifestFile=join(record.source,'manifest.json'),manifest=readJson(manifestFile);
  for(const p of plan?.packages||[]){
    const decision=submission.decisions.find(d=>d.id==='package:'+p.name);
    if(!decision||decision.action==='defer')continue;
    const before='npm:'+p.name+'@'+p.installed,after='npm:'+p.name+'@'+p.latest;
    for(const entry of Object.values(definition.packages||{}))if(entry.source===before)entry.source=after;
    for(const entry of manifest?.packages||[])if(entry.source===before)entry.source=after;
  }
  writeJson(pkgFile,definition);if(manifest)writeJson(manifestFile,manifest);
  for(const path of batch.files){
    const item=plan?.files.find(f=>f.path===path),decision=submission.decisions.find(d=>d.id==='skill:'+item?.skill);
    if(!decision||decision.action==='adapt'||managedFiles.has(path))continue;
    const from=decision.action==='defer'?join(record.root,'base',path):item.review?.upstream,to=join(record.source,path);
    if(from&&existsSync(from)){mkdirSync(dirname(to),{recursive:true});cpSync(from,to);if(decision.action==='adopt')chmodSync(to,item.targetMode==='100755'?0o755:0o644);}
    else rmSync(to,{force:true});
  }
}
function requiredCustom(record,currentMigrations=[]) {
  const inventory=readJson(join(record.root,'inventory.json'),{}),definition=readJson(join(record.source,'preset.json')),self=Object.keys(definition.packages||{}).find(k=>definition.packages[k].source==='.');
  const migrations=[...record.accepted.flatMap(e=>e.submission.migrations||[]),...currentMigrations];
  return Object.entries(inventory.customSkills||{}).filter(([,s])=>s.type==='custom'&&s.enabled!==false).map(([name,s])=>{
    let path=s.localPath||`skills/${name}/SKILL.md`;
    for(const move of migrations)if(move.from.includes(path)){
      const entries=move.to.filter(p=>p.endsWith('/SKILL.md'));if(entries.length!==1)throw new Error('Custom skill entry migration needs exactly one SKILL.md target: '+path);
      path=entries[0];
    }
    return {package:self,kind:'skills',loaded:[path]};
  });
}

function treeIdentity(path) {
  if(!existsSync(path))return null;
  const info=lstatSync(path);
  if(info.isSymbolicLink())return ['link',readlinkSync(path)];
  if(info.isDirectory())return readdirSync(path).sort().filter(n=>n!=='.git').map(n=>[n,treeIdentity(join(path,n))]);
  return hash(readFileSync(path));
}
function evidenceScope(record,batch,submission) {
  if(record.mode==='maintain'||batch.runtime||!batch.files.length)return ['.'];
  const paths=new Set(['package.json','preset.json','components.json']);
  const resources=record.resources||[];
  const rootsFor=path=>resources.filter(resource=>resource.enabled&&(path===resource.path||path.startsWith(resource.path+'/')))
    .sort((a,b)=>b.path.length-a.path.length).slice(0,1).map(resource=>resource.path);
  for(const path of batch.files){const roots=rootsFor(path);for(const root of roots)paths.add(root);if(!roots.length)paths.add(path);}
  for(const resource of submission.resources||[]){if(resource.enabled!==false)paths.add(resource.path);if(resource.oldPath)paths.add(resource.oldPath);}
  for(const m of submission.migrations||[])for(const p of [...m.from,...m.to])paths.add(p);
  for(const check of submission.checks)for(const arg of check.args)if(!arg.startsWith('-')&&existsSync(join(record.source,arg)))paths.add(arg);
  return [...paths].sort();
}
function evidenceKey(record,stage,check,scope) {
  if(scope.includes('.'))scope=['.'];
  return hash(JSON.stringify({check:{command:check.command,args:check.args},pi:record.piVersion,node:process.version,dependencies:stage.dependencies,
    inputs:scope.map(p=>[p,p==='.'?sourceDigest(stage.packageRoot):treeIdentity(join(stage.packageRoot,p))])}));
}
async function stageCandidate(store,record,submission) {
  const finalized=join(record.root,'finalized');rmSync(finalized,{recursive:true,force:true});cpSync(record.source,finalized,{recursive:true,filter:publicSource});
  const registrations=[...record.accepted.flatMap(e=>e.registrations||[]),...(record.pendingRegistrations||[])];
  if(registrations.length){const components=readJson(join(finalized,'components.json'),{});components.skills||={};for(const {name,...skill} of registrations)components.skills[name]=skill;writeJson(join(finalized,'components.json'),components);}
  if(record.plan)await advanceUpdateLineage(finalized,readJson(record.plan),[...record.accepted.flatMap(e=>e.submission.decisions),...submission.decisions]);
  const migration=readJson(join(finalized,'migration.json'));
  if(migration?.checksums){for(const path of Object.keys(migration.checksums))if(existsSync(join(finalized,path)))migration.checksums[path]=hash(readFileSync(join(finalized,path)));else delete migration.checksums[path];writeJson(join(finalized,'migration.json'),migration);}
  const components=readJson(join(finalized,'components.json'),{});
  for(const [name,skill] of Object.entries(components.skills||{}))if(skill.type==='custom')for(const move of [...record.accepted.flatMap(e=>e.submission.migrations||[]),...(submission.migrations||[])])if(move.from.includes(skill.localPath||`skills/${name}/SKILL.md`))skill.localPath=move.to.find(p=>p.endsWith('/SKILL.md'))||skill.localPath;
  if(Object.keys(components).length)writeJson(join(finalized,'components.json'),components);
  inspectPublicSource(finalized);
  const digest=sourceDigest(finalized);
  if(record.stage?.digest===digest){checkPreparedProfile(record.stage.profile);return record.stage;}
  const stage=await withLocalSnapshot(join(record.root,'snapshots'),finalized,async locator=>{
    const reviewed=await reviewNativeImport(store,locator,'preset.json');
    return materializeNativePlan(store,reviewed.plan,{source:record.upstream||record.origin,parent:record.profile,requiredResources:requiredCustom(record,submission.migrations),env:isolatedEnvironment(join(record.root,'install-environment')),reuseStage:record.stage});
  },isolatedEnvironment(join(record.root,'snapshot-environment')));
  const attempt=stage.record.attempts.at(-1),self=stage.plan.installationSurfaces.find(s=>s.source==='.'),entry=attempt.installed.find(e=>e.alias===self.alias);
  const packageRoot=packageRootFor(stage.plan,{...entry,installedPath:entry.installedRelative?join(attempt.agentDir,entry.installedRelative):entry.installedPath});
  const external=Object.fromEntries(Object.entries(attempt.lock.code.packages).filter(([name])=>!name.includes(': '+self.alias+' (')));
  return {...stage,digest,packageRoot,dependencies:hash(JSON.stringify({external,self:treeIdentity(join(packageRoot,'node_modules'))}))};
}

export async function verifyWorkflow(store,root,options={}) {return locked(root,()=>verifyLocked(store,root,options));}

/** Exact affected checks before final coverage; never seals or installs a revision. */
export async function checkWorkflowImplementation(store,root,{item,signal}={}){return locked(root,async()=>{
  const record=workflowRecord(store,root);assertInputs(record);
  requireApprovedPlan(record);
  if(!editable(record))throw Error('Resume this workflow before checking implementation');
  const work=record.draft?.work?.find(w=>'implementation:'+w.id===(item||record.focusId));
  if(!work?.checks?.length)throw Object.assign(Error('Focus an implementation item with affected checks before check'),{code:'WORKFLOW_CHECK_REQUIRED'});
  try{
  signal?.throwIfAborted();
  const submission=mergeReview(record.draft,{}),batch=current(record);
  restoreOwnedFields(record.source,join(root,'base'),{piVersion:record.piVersion});
  validateFileDecisions(record,batch,submission);applyFileDecisions(record,batch,submission);
  let adopted={resources:submission.resources||[],registrations:[]};
  for(const capability of batch.capabilities||[batch.capability])if(capability){const result=await adoptNewSkills(record.source,{capability},{...submission,resources:adopted.resources});adopted={resources:result.resources,registrations:[...adopted.registrations,...result.registrations]};}
  record.pendingRegistrations=adopted.registrations;
  compileResources(record.source,record.resources,adopted.resources);
  const stage=await stageCandidate(store,record,submission);record.stage=stage;
  const before=sourceDigest(stage.packageRoot),candidateBefore=sourceDigest(record.source),checks=[];
  const evidence=[...(record.partialEvidence||[])];
  for(const [index,check] of work.checks.entries()){
    validateCheck(check);const scope=['.'],key=evidenceKey(record,stage,check,scope);
    const prior=evidence.find(e=>e.key===key&&e.outcome.code===0&&!e.outcome.timedOut&&!e.outcome.cancelled);
    const outcome=prior?{...prior.outcome,reused:true}:await executeCheck(check,stage.packageRoot,join(root,'partial-'+work.id+'-'+index+'.log'),join(root,'partial-checks',work.id,String(index)),signal,{},stage.profile.agentDir);
    if(outcome.cancelled)throw new DOMException('Partial check cancelled','AbortError');
    checks.push(outcome);
    const existing=evidence.findIndex(e=>JSON.stringify([e.check.command,e.check.args])===JSON.stringify([check.command,check.args]));
    if(existing>=0)evidence.splice(existing,1);
    evidence.push({check,scope,key,outcome});
  }
  if(sourceDigest(stage.packageRoot)!==before||sourceDigest(record.source)!==candidateBefore)throw Error('Checks changed candidate code; restore and check again');
  checkPreparedProfile(stage.profile);
  const passed=checks.every(c=>c.code===0&&!c.timedOut&&!c.cancelled);
  record.partialEvidence=evidence;
  if(!passed)delete work.claim;
  record.partialCheck={item:'implementation:'+work.id,passed,checks};
  save(record,{type:'workflow.implementation-checked',payload:{item:work.id,passed}});
  return {...handoff(record),partialCheck:record.partialCheck};
  }catch(error){
    // A cancelled or contaminated stage cannot contribute reusable evidence.
    delete work.claim;delete record.stage;record.partialEvidence=[];
    record.partialCheck={item:'implementation:'+work.id,passed:false,checks:[],error:error.message,cancelled:error.name==='AbortError'};
    if(error.name==='AbortError'){record.status='INTERRUPTED';record.stopReason='Partial check cancelled; implementation preserved without a completion claim';}
    save(record,{type:error.name==='AbortError'?'workflow.interrupted':'workflow.implementation-check-failed',payload:{item:work.id,message:error.message}});
    return {...handoff(record),partialCheck:record.partialCheck,...(error.name==='AbortError'?{}:{status:'ERROR',code:'WORKFLOW_PARTIAL_CHECK_FAILED',error:error.message})};
  }
});}

async function completeRuntimeBaseline(store,record,signal){
  const batch=current(record);
  assertInputs(record);restoreOwnedFields(record.source,join(record.root,'base'),{piVersion:record.piVersion});const digest=sourceDigest(record.source);
  try{
    signal?.throwIfAborted();
    const stage=await stageCandidate(store,record,{decisions:[],resources:[],migrations:[],checks:[]});record.stage=stage;
    const before=sourceDigest(stage.packageRoot),probeRoot=join(record.root,'probe');mkdirSync(probeRoot,{recursive:true});
    const outcome=await executeCheck(nativeLoadCheck(probeRoot,stage.profile.agentDir),stage.packageRoot,join(record.root,'probe.log'),join(record.root,'probe-runtime'),signal);
    if(outcome.cancelled)throw new DOMException('Runtime loading cancelled','AbortError');
    if(sourceDigest(stage.packageRoot)!==before||sourceDigest(record.source)!==digest)throw new Error('Loading check changed candidate code; restore it before retrying');
    checkPreparedProfile(stage.profile);
    record.baselineDiagnostics={status:outcome.code===0&&!outcome.timedOut?'READY':'BLOCKED_DEPENDENCY',outcome};
  }catch(error){
    if(error.name==='AbortError'){record.status='INTERRUPTED';record.stopReason='Runtime loading cancelled; candidate preserved';save(record,{type:'workflow.interrupted'});return handoff(record);}
    record.baselineDiagnostics={status:'BLOCKED_DEPENDENCY',message:error.message,...(error.staging?{failure:error.staging.attempts.at(-1)?.failure}:{}),...(error.resources?{resources:error.resources}:{})};
  }
  if(record.baselineDiagnostics.status==='READY'){
    batch.status='verified';record.revision++;
    record.accepted.push({id:batch.id,automatic:'runtime-load',digest,submission:{summary:'Candidate loads on Pi '+record.piVersion+'. Feature and behavior review remains pending.',decisions:[],checks:[]},checks:[record.baselineDiagnostics.outcome],evidence:[]});
    acceptedDelivery(record);save(record,{type:'runtime.loaded'});
    if(record.execution==='change-list'){record.batches=changeList(record.batches,readJson(record.plan));ensureWorkExecution(record);save(record,{type:'workflow.execution-ready'});}
    activateBatch(record);return handoff(record);
  }
  if(record.execution==='change-list'){record.batches=changeList(record.batches,readJson(record.plan));ensureWorkExecution(record);activateBatch(record);}
  save(record,{type:'runtime.load-failed'});return handoff(record);
}

function verificationFailure(record,batch,checks,{digest,submissionHash,files:affectedFiles,resourceChange}){
  const root=record.root,result={status:'CHECK_FAILED',modelRequired:true,checks,next:'Fix the reported batch failures, then verify.'};writeJson(join(root,'verification.json'),{...result,ok:false,digest,submissionHash});
  if(record.execution!=='change-list')return result;
  const id='verification-repair',files=affectedFiles||[...new Set(checks.filter(check=>check.code!==0||check.timedOut).flatMap(check=>(check.args||[]).filter(arg=>!arg.startsWith('-')&&/\.(?:mjs|js|ts|md)$/.test(arg))))];
  batch.required=[...new Set([...batch.required,id])];batch.items||=[];
  const prior=batch.items.find(item=>item.id===id);if(prior)prior.files=[...new Set([...prior.files,...files])];else batch.items.push({id,title:'Repair failed verification',required:[id],files});
  if(record.draft)record.draft.decisions=(record.draft.decisions||[]).filter(decision=>decision.id!==id);
  record.itemStates[id]={status:'in_progress',progress:{turns:0,sinceActivity:0,sinceDelivery:0,recoveryIssuedAt:null}};record.focusId=id;record.status='CHECK_FAILED';record.resourceRepair=resourceChange;record.revision++;
  save(record,{type:'workflow.verification-failed',payload:{itemId:id,failed:checks.filter(check=>check.code!==0||check.timedOut).length}});
  const repair={item:id,failures:checks.filter(check=>check.code!==0||check.timedOut).map(({reason,command,args,code,timedOut,log,tail,resourceChange})=>({reason,command,args,code,timedOut,log,tail,resourceChange}))};
  const response={...handoff(record),modelRequired:true,checks,repair,next:'Repair the focused verification failures, save the repair decision, then verify.'};
  if(resourceChange)return {...response,next:`Correct resources[${resourceChange.index}] in the complete saved draft, save with replace:true, then verify.`};
  return response;
}

function preflightFailure(record,batch,submission,error,{files=['package.json'],reason='Verification preflight failed'}={}){
  const outcome=verificationFailure(record,batch,[{reason,code:1,timedOut:false,tail:describeFailure(error),resourceChange:error.resourceChange}],{digest:sourceDigest(record.source),submissionHash:hash(JSON.stringify(submission)),files,resourceChange:error.resourceChange});
  return {...outcome,error:error.message,...(error.code?{code:error.code}:{}),...(error.diagnostics?{diagnostics:error.diagnostics}:{}),...(error.references?{references:error.references}:{}),
    ...(error.staging?{operation:'materialize',failure:error.staging.attempts.at(-1)?.failure,attempt:error.staging.attempts.at(-1)?.agentDir}:{})};
}

async function verifyLocked(store,root,{signal,batch:batchId,revision,submission}={}) {
  const incoming=submission||{};
  signal?.throwIfAborted();const record=workflowRecord(store,root);assertInputs(record);
  if(!current(record)?.runtimeBaseline)requireApprovedPlan(record);
  reopenChanged(record);
  if(!editable(record))throw new Error('Workflow is closed; start from an installed preset');
  const batch=current(record);
  if(batchId!==undefined&&batchId!==batch?.id||revision!==undefined&&revision!==record.revision){
    const prior=record.accepted.find(e=>e.id===batchId&&JSON.stringify(e.submission)===JSON.stringify(submission));
    return {...handoff(record),code:prior?'WORKFLOW_ALREADY_VERIFIED':'WORKFLOW_STALE_SUBMISSION'};
  }
  if(!batch)return handoff(record);
  if(batch.runtimeBaseline)return completeRuntimeBaseline(store,record,signal);
  // Compatibility for existing native --verify callers; new model instructions use structured input.
  const legacySubmission=!submission&&readJson(join(root,'result.json'));
  if(legacySubmission)submission=legacySubmission;
  else if(record.execution==='change-list'||record.draft)submission=mergeReview(record.draft,submission||{});
  if(record.execution==='change-list'){
    submission=prepareImplementation(record,submission,incoming);
    const preview={...record,draft:submission,itemStates:Object.fromEntries(Object.entries(record.itemStates||{}).map(([id,state])=>[id,{...state}]))};
    applyWorkflowSubmission(preview,submission);
    const missingDecisions=missingWorkflowDecisions(preview),blockedItems=blockedWorkflowItems(preview);
    const implementation=unfinishedImplementation(preview),missingImplementation=missingImplementationOrigins(preview);
    if(missingDecisions.length||blockedItems.length||implementation.length||missingImplementation.length)return {...handoff(record),status:'ERROR',code:'WORKFLOW_INCOMPLETE',incomplete:{missingDecisions,blockedItems:blockedItems.map(item=>item.id),details:blockedItems,implementation,missingImplementation},next:'Focus an incomplete or blocked item, save its resolution, then verify.'};
    validateSubmission({...batch,required:submission.decisions.map(decision=>decision.id)},submission);
    if(submission.decisions.some(decision=>!batch.required.includes(decision.id)))throw Error('Unknown decision ID in saved review');
    validateFileDecisions(record,batch,submission);
    record.draft=submission;applyWorkflowSubmission(record,submission);save(record,{type:'workflow.review-submitted'});
  }
  submission.checks=[...new Map([...submission.checks,...implementationChecks(submission)].map(c=>[JSON.stringify([c.command,c.args]),c])).values()];
  validateSubmission(batch,submission);
  validateFileDecisions(record,batch,submission);
  restoreOwnedFields(record.source,join(root,'base'),{piVersion:record.piVersion});
  const moves=record.accepted.flatMap(e=>e.submission.migrations||[]).concat(submission.migrations||[]);
  const mappings=validateMigrations(record.source,join(root,'base'),moves);
  applyFileDecisions(record,batch,submission);
  let adopted={resources:submission.resources||[],registrations:[]};
  for(const capability of batch.capabilities||[batch.capability])if(capability){const item=await adoptNewSkills(record.source,{capability},{...submission,resources:adopted.resources});adopted={resources:item.resources,registrations:[...adopted.registrations,...item.registrations]};}
  record.pendingRegistrations=adopted.registrations;
  let nextResources;try{nextResources=compileResources(record.source,record.resources,adopted.resources);}catch(error){
    return preflightFailure(record,batch,submission,error,{reason:'Resource compilation failed',files:['preset.json','package.json']});
  }
  writeFileSync(join(root,'REPORT.md'),[...record.accepted.map(e=>e.submission.summary),submission.summary].join('\n\n')+'\n');
  try{checkMaintenance(store,{id:record.profile||'source',workflowRoot:root},null,{mappings});}catch(error){
    return preflightFailure(record,batch,submission,error,{files:error.references?.length?error.references.map(reference=>reference.file):['components.json','manifest.json']});
  }
  const digest=sourceDigest(record.source),submissionHash=hash(JSON.stringify(submission));
  const cached=readJson(join(root,'verification.json'));
  if(cached?.digest===digest&&cached.submissionHash===submissionHash&&cached.status==='CHECK_FAILED')return verificationFailure(record,batch,cached.checks,{digest,submissionHash});
  record.status='REVIEW_REQUIRED';save(record);writeJson(join(root,'verification.json'),{ok:false,status:'RUNNING',digest});
  const priorSnapshot=record.checkpoint||join(root,'base');
  const unchangedReview=submission.decisions.length&&(submission.decisions.every(d=>d.action==='defer')||batch.required.every(id=>id.startsWith('runtime-review')));
  if(unchangedReview&&record.baselineDiagnostics?.status!=='BLOCKED_DEPENDENCY'&&!submission.checks.length&&!submission.obligations?.length&&digest===sourceDigest(priorSnapshot)&&
    (record.batches.some(b=>b!==batch&&b.status!=='verified')||digest===record.baseDigest)){
    batch.status='verified';record.accepted.push({id:batch.id,submission,digest,evidence:[],checks:[]});record.revision++;record.resources=nextResources;acceptedDelivery(record);
    const checkpoint=join(root,'checkpoints',String(record.revision));mkdirSync(dirname(checkpoint),{recursive:true});cpSync(record.source,checkpoint,{recursive:true,filter:publicSource});record.checkpoint=checkpoint;
    record.status=current(record)?'REVIEW_REQUIRED':'REVIEWED';
    if(record.status==='REVIEWED'&&record.receipt)writeJson(record.receipt,{reviewed:true,decisions:record.accepted.flatMap(e=>e.submission.decisions)});
    save(record);activateBatch(record);return handoff(record);
  }
  let stage;try{stage=await stageCandidate(store,record,submission);}catch(error){
    return preflightFailure(record,batch,submission,error,{files:error.references?.length?error.references.map(reference=>reference.file):['preset.json','package.json']});
  }
  record.stage=stage;save(record);
  record.resolvedResources=stage.resources||record.resolvedResources;
  const self=stage.plan.installationSurfaces.find(s=>s.source==='.'),entry=stage.record.attempts.at(-1).installed.find(e=>e.alias===self.alias),attempt=stage.record.attempts.at(-1);
  const cwd=packageRootFor(stage.plan,{...entry,installedPath:entry.installedRelative?join(attempt.agentDir,entry.installedRelative):entry.installedPath});
  const before=sourceDigest(cwd),checks=[],evidence=[],scope=evidenceScope(record,batch,submission);
  const grouped=new Map();
  const automatic=[workflowSkillCheck(root,record.source,join(root,'base')),...changedBehaviorChecks(record.source,join(root,'base'))];
  for(const obligation of submission.obligations||[])automatic.push(workflowUiCheck(root,stage.profile,{location:obligation.location}));
  for(const item of [...record.accepted.flatMap(e=>e.evidence||[]),...automatic.map(check=>({check,scope})),...submission.checks.map(check=>({check,scope}))]){
    const id=hash(JSON.stringify({command:item.check.command,args:item.check.args})),prior=grouped.get(id);
    if(!prior)grouped.set(id,item);
    else grouped.set(id,{...prior,scope:[...new Set([...prior.scope,...item.scope])].sort()});
  }
  const selected=[{check:nativeLoadCheck(root,stage.profile.agentDir),scope:['.']},...grouped.values()];
  try{for(const [index,item] of selected.entries()){
    const {check}=item;
    const key=evidenceKey(record,stage,check,item.scope);
    const cached=[item,...(record.partialEvidence||[])].find(e=>e.key===key&&e.outcome?.code===0&&!e.outcome.timedOut&&!e.outcome.cancelled);
    const outcome=cached?{...cached.outcome,reused:true}:await executeCheck(check,cwd,join(root,'check-'+record.revision+'-'+index+'.log'),join(root,'checks',String(index)),signal,{},stage.profile.agentDir);
    checks.push(outcome);if(index>0)evidence.push({check,scope:item.scope,key,outcome});
    if(outcome.cancelled)throw new DOMException('Verification cancelled','AbortError');
  }}catch(error){writeJson(join(root,'verification.json'),{ok:false,status:error.name==='AbortError'?'CANCELLED':'ERROR',checks});throw error;}
  try{if(sourceDigest(cwd)!==before||sourceDigest(record.source)!==digest)throw new Error('Checks changed candidate code; restore and submit again');checkPreparedProfile(stage.profile);}catch(error){
    return preflightFailure(record,batch,submission,error,{files:error.references?.length?error.references.map(reference=>reference.file):['components.json','manifest.json','package.json']});
  }
  if(checks.some(c=>c.code!==0||c.timedOut))return verificationFailure(record,batch,checks,{digest,submissionHash});
  batch.status='verified';record.resources=nextResources;record.accepted.push({id:batch.id,submission,digest,checks,evidence,registrations:adopted.registrations});delete record.pendingRegistrations;record.revision++;acceptedDelivery(record);
  const checkpoint=join(root,'checkpoints',String(record.revision));mkdirSync(dirname(checkpoint),{recursive:true});cpSync(record.source,checkpoint,{recursive:true,filter:publicSource});record.checkpoint=checkpoint;
  record.status=current(record)?'REVIEW_REQUIRED':sourceDigest(record.source)===record.baseDigest?'REVIEWED':'READY_TO_INSTALL';
  if(record.status==='REVIEWED'&&record.receipt)writeJson(record.receipt,{reviewed:true,pi:record.piVersion,decisions:record.accepted.flatMap(e=>e.submission.decisions)});
  writeJson(join(root,'verification.json'),{ok:true,status:record.status,digest,stage:stage.digest,submissionHash,pi:record.piVersion,checks});save(record);
  activateBatch(record);return {...handoff(record),checks:checks.map(({command,args,code,reused})=>({command,args,code,...(reused?{reused:true}:{})}))};
}

export async function installWorkflow(store,root,{approved=false,confirm}={}) {return locked(root,async()=>{
  const record=workflowRecord(store,root);
  requireApprovedPlan(record);
  if(record.status==='INSTALLED'){const profile=store.read().profiles[record.installed];checkPreparedProfile(profile);return installedReceipt(store,record,profile);}
  assertInputs(record);const proof=readJson(join(root,'verification.json'));
  if(record.status!=='READY_TO_INSTALL'||!proof?.ok||proof.digest!==sourceDigest(record.source)||proof.stage!==record.stage?.digest)throw new Error('Verification missing or stale; verify the current candidate');
  if(sourceDigest(join(root,'finalized'))!==proof.stage)throw new Error('Sealed candidate changed; verify again');
  checkPreparedProfile(record.stage.profile);
  if(!approved&&!await confirm?.(readJson(join(record.source,'preset.json'))))return {status:'APPROVAL_REQUIRED',modelRequired:false};
  const config=store.read(),installed={...record.stage.profile,kind:'derivative',authored:true,presetKey:record.profile?config.profiles[record.profile]?.presetKey:record.stage.profile.presetKey,maintenance:{base:record.profile,workspace:root,upstream:record.upstream||record.origin}};
  promoteNativePlan(store,{profile:installed});
  for(const requirement of installed.deviceBindings||[])if(record.bindingValues?.[requirement.id])bindDevice(store,installed,requirement.id,record.bindingValues[requirement.id]);
  record.status='INSTALLED';record.installed=installed.id;save(record);
  return installedReceipt(store,record,installed);
});}

function installedReceipt(store,record,profile){
  const checks=record.accepted.flatMap(e=>e.checks||[]).map(({reason,code,reused})=>({reason,code,...(reused?{reused:true}:{})}));
  return {status:'INSTALLED',modelRequired:false,profile:{id:profile.id,name:profile.name,version:profile.version},active:false,
    receipt:{sourceDigest:sourceDigest(record.source),artifactDigest:record.stage.digest,defaultUnchanged:store.read().default===record.startupDefault,
      checks,decisions:record.accepted.flatMap(e=>e.submission.decisions),resources:record.accepted.flatMap(e=>e.submission.resources||[]),
      recover:'/wardrobe use '+profile.id},next:'Finished. Report the receipt briefly.'};
}
