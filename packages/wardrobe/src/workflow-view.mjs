import {implementUpdateNext,proposeUpdateNext} from './workflow-proposal.mjs';

/** The model decides behavior; workflow coordinates stay in the native session. */
export function workflowView(result,{action}={}) {
  if(!result||typeof result!=='object')return result;
  const {handle,revision,protocolVersion,contract,findings,recoveryStep,progress,completed,workspace,nextCall,checkpoint,decisions,context,...view}=result;
  if(workspace)view.workspace={source:workspace.source};
  if(nextCall){const {handle,workflow,batch,revision,...call}=nextCall;view.nextCall=call;}
  if(completed)view.completed=Array.isArray(completed)?{count:completed.length,last:completed.at(-1)?.summary}:completed;
  if(decisions?.length)view.decisions=decisions.map(({inputs,review,...decision})=>({...decision,...(review?{review}:{} )}));
  if(context)view.context={pi:context.pi,verification:context.verification,...(context.localPackageAlias?{localPackageAlias:context.localPackageAlias}:{}),...(action==='details'||result.runtime||result.kind==='maintain'||result.focus?.id==='requested'||result.focus?.kind==='implementation'?{wardrobe:context.wardrobe}: {})};
  if(result.execution==='change-list'&&!result.runtimeBaseline){
    delete view.decisions;delete view.runtimeReviews;delete view.releaseNotes;delete view.resolvedResources;delete view.resources;
    delete view.capabilities;delete view.packages;delete view.batch;
    view.items=result.items?.map(({id,title,required,files,status,kind,dependencies,blocker,previousBlocker})=>({id,title,required,files:typeof files==='number'?files:files?.length||0,status,...(kind?{kind,dependencies}:{}),...(blocker?{blocker}:{}),...(previousBlocker?{previousBlocker}:{})}));
    if(result.runtime)view.runtime={before:result.runtime.before,installed:result.runtime.installed};
  }
  const documentReview=result.kind==='update'&&!result.runtime&&!result.packages?.length&&!result.capabilities?.length&&
    result.requiredDecisions?.length&&result.requiredDecisions.every(id=>id.startsWith('skill:'))&&
    decisions?.length&&decisions.every(item=>item.path.endsWith('.md'));
  if(documentReview&&view.material){
    const material=view.material;
    view.material={...material,declaration:material.declaration&&{path:material.declaration.path},
      notes:material.notes?.map(note=>({...note,excerpt:note.excerpt&&{path:note.excerpt.path},delta:note.delta&&{path:note.delta.path}}))};
    delete view.material.localOwners;delete view.resolvedResources;
  }
  if(progress?.recoveryMessage)view.recovery=progress.recoveryMessage;
  if(result.status==='READY_TO_INSTALL')view.next='Install with existing authorization. The revision remains inactive.';
  else if(result.status==='CHECK_FAILED'&&result.repair)view.next='Repair the focused verification failures, save the repair decision, then verify.';
  else if(result.runtimeBaseline)view.next='Repair the concrete loading failure, then probe. The program accepts only a successful native load.';
  else if(result.execution==='change-list')view.next='Work in dependency order using changes; save partial decisions. Verify complete coverage and affected behavior, then install.';
  else if(result.batch)view.next='Edit the candidate if needed, then submit the current decisions with verify.';
  if(result.planReview?.phase==='draft'&&!result.runtimeBaseline)view.next=proposeUpdateNext;
  if(result.planReview?.phase==='pending')view.next='The report is saved. Resume to show it again, or use resume with revise:true when the user requests a revised proposal.';
  if(result.status==='PLAN_APPROVED')view.next='The user approved this exact report in the Pi dialog. Report that it is approved and end this turn. Start implementation in a separate turn with resume.';
  if(result.planReview?.phase==='approved'&&result.status==='REVIEW_REQUIRED'&&!result.runtimeBaseline)view.next=implementUpdateNext;
  if(view.baselineDiagnostics?.status==='READY')delete view.baselineDiagnostics;
  // Success logs are stored on disk. Only failures need diagnostic content.
  if(view.checks)view.checks=view.checks.map(check=>check.code===0?{reason:check.reason,code:0,reused:check.reused}:check);
  if(view.partialCheck?.checks)view.partialCheck={...view.partialCheck,checks:view.partialCheck.checks.map(check=>check.code===0?{reason:check.reason,code:0,reused:check.reused}:check)};
  // Starting/resuming and details restore the full frozen method, policy and ledger.
  // Routine calls acknowledge progress without replaying that growing history.
  if(['focus','save','check','verify','probe','checkpoint'].includes(action)){
    if(view.skills)view.skills=Object.fromEntries(Object.entries(view.skills).map(([name,{body,...reference}])=>[name,reference]));
    if(view.saved){
      const {decisions=[],checks=[],resources=[],migrations=[],work=[],...saved}=view.saved;
      view.saved={...saved,decisions:decisions.map(({id,action})=>({id,action})),work:work.map(({id,goal,paths,dependsOn,missingFact})=>({id,goal,paths,dependsOn,missingFact})),counts:{decisions:decisions.length,checks:checks.length,resources:resources.length,migrations:migrations.length,work:work.length}};
    }
    if(view.repair?.failures&&view.checks)view.repair={...view.repair,failures:view.repair.failures.map(failure=>
      view.checks.some(check=>Object.keys(failure).every(key=>JSON.stringify(check[key])===JSON.stringify(failure[key])))
        ?{command:failure.command,args:failure.args,code:failure.code,log:failure.log}:failure)};
    if(view.skills||view.saved||view.repair)view.detailsCall={action:'details'};
  }
  return view;
}
