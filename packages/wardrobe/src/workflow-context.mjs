import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { workflowContract } from './workflow-contract.mjs';
import { sourceFiles } from './native-snapshot.mjs';
import { captureObservations, readObservations, recentObservations } from './workflow-observations.mjs';
import { readingView } from './workflow-reading.mjs';
import { workflowView } from './workflow-view.mjs';
import { loadWorkflowRecord } from './workflow-journal.mjs';
import { implementUpdateNext, proposeUpdateNext } from './workflow-proposal.mjs';

const scopes=new WeakMap();
const closed=new Set(['NO_UPDATE','REVIEWED','INSTALLED','STALLED','WAITING_INPUT','PLAN_APPROVED','BLOCKED','BLOCKED_DEPENDENCY','SUSPENDED_QUOTA','INTERRUPTED']);
const finished=new Set(['NO_UPDATE','REVIEWED','INSTALLED']);
const coreTools=new Set(['read','bash','edit','write','wardrobe_workflow']);
const identity=m=>m.toolCallId?'tool:'+m.toolCallId:createHash('sha256').update(JSON.stringify(m)).digest('hex');
const isConstraint=m=>['user','compactionSummary','branchSummary'].includes(m.role)||m.role==='custom'&&!/^wardrobe\.|agent-summary$/.test(m.customType||'');

/** A temporary, append-only model view. Native session history is untouched. */
export function workflowContextFor(pi,store){
  if(scopes.has(pi))return scopes.get(pi);
  let reads=readingView(),bound=null,active=null,cursor=null,summary=null,epoch=0,history=[],constraints=[],snapshot=null,pendingEpoch='start',lastDelta=null,settleRetried=false;
  const clear=()=>{reads=readingView();active=null;cursor=null;summary=null;epoch=0;history=[];constraints=[];snapshot=null;pendingEpoch='start';lastDelta=null;settleRetried=false;};
  const scope={
    start(){bound=null;clear();},
    recovery(){return active&&!closed.has(active.status)?{handle:active.handle,nextCall:active.nextCall}:{};},
    async bind(input,ctx){
      if(input.handle||input.workflow||!['verify','install','details','probe','guidance','checkpoint','resume','save','focus','check','propose'].includes(input.action))return input;
      const branch=ctx?.sessionManager?.getBranch?.();
      const entry=branch?.filter(e=>e.type==='custom'&&e.customType==='wardrobe.workflow'&&(e.data?.workflow||['update','maintain'].includes(e.data?.action))).at(-1);
      if(branch&&entry?.data.workflow!==bound?.root){bound=null;clear();}
      if(!active&&(entry?.data.workflow||bound?.root)){
        const root=entry?.data.workflow||bound.root,within=relative(store.root,resolve(root)).replaceAll('\\','/');
        if(/^(updates|maintenance)\//.test(within)&&!within.startsWith('../')){
          const record=loadWorkflowRecord(root);
          if(record?.protocolVersion===3){
            // Restore full runtime state before dispatch so failed submissions
            // still participate in context recovery and no-progress accounting.
            const {workflowDetails}=await import('./native-workflow.mjs');
            scope.accept(await workflowDetails(store,root));
          }
        }
      }
      if(input.action==='details'&&input.profile&&input.profile!==active?.profile?.id)return input;
      return bound?{...input,handle:bound.handle}:input;
    },
    accept(result){
      if(!result)return;
      if(result.workspace&&result.handle){
        if(active?.handle!==result.handle){pendingEpoch='item';settleRetried=false;}
        else if(JSON.stringify(active?.saved)!==JSON.stringify(result.saved))settleRetried=false;
        active=result;bound={root:result.workspace.root,handle:result.handle};
      }else if(result.workspace){bound=null;clear();}
      else if(active&&closed.has(result.status))active={...active,...result};
      else if(active&&['ERROR','CHECK_FAILED'].includes(result.status))active={...active,lastFailure:result};
    },
  };
  scopes.set(pi,scope);
  pi.on?.('context_with_system',(event,ctx)=>{
    if(!active)return;
    const messages=event.messages,terminal=closed.has(active.status);
    const nativeSummary=messages.findLast(m=>['compactionSummary','branchSummary'].includes(m.role));
    const summaryKey=nativeSummary?identity(nativeSummary):null;
    let from=cursor===null?-1:messages.findIndex(m=>identity(m)===cursor);
    if(!pendingEpoch&&(from<0||summaryKey!==summary))pendingEpoch='native-context-rebuilt';
    summary=summaryKey;
    if(pendingEpoch){
      // Keep the real workflow call/result pair when entering from a tool. A
      // synthetic state alone made the model repeatedly doubt whether it ran.
      const resultIndex=messages.findLastIndex(m=>m.role==='toolResult'&&m.toolName==='wardrobe_workflow'&&m.content?.some(c=>{
        if(c.type!=='text')return false;
        try{const value=JSON.parse(c.text);return value.workspace?.source===active.workspace?.source&&value.status===active.status&&(active.execution==='change-list'||value.batch?.id===active.batch?.id);}catch{return false;}
      }));
      const callId=resultIndex>=0?messages[resultIndex].toolCallId:null;
      const callIndex=callId?messages.findLastIndex(m=>m.role==='assistant'&&m.content?.some(c=>c.type==='toolCall'&&c.id===callId)):-1;
      from=callIndex>=0?callIndex:pendingEpoch==='native-context-rebuilt'?Math.max(0,messages.findLastIndex(m=>['compactionSummary','branchSummary'].includes(m.role))+1):messages.length;
      constraints=messages.slice(0,from).filter(isConstraint);
      history=[];reads=readingView();epoch++;lastDelta=null;
      // The real result already carries material. Do not duplicate that whole
      // packet in a synthetic frame on every new item.
      const state=workflowView(callIndex>=0?{...active,status:active.status,batch:active.batch,nextCall:active.nextCall}:active);
      snapshot={role:'user',content:[{type:'text',text:'Current Wardrobe work item (authoritative program state):\n'+JSON.stringify({...state,epoch,lifecycle:{started:true},workingChanges:workingChanges(active),...(callIndex<0&&!nativeSummary&&active.workspace?.root?{recentObservations:recentObservations(active.workspace.root).map(({tool,content,fresh})=>({tool,content,fresh}))}:{})})}]};
      pi.appendEntry?.('wardrobe.epoch',{handle:active.handle,batch:active.batch?.id,epoch,reason:pendingEpoch});pendingEpoch=null;
    }else from++;
    const added=messages.slice(from).filter(m=>m.role!=='system');
    captureObservations(active.workspace?.root,added,{source:active.workspace?.source,cwd:process.cwd()});
    history.push(...added.map(m=>archiveLargeResult(reads.project(m,ctx?.cwd||process.cwd()),active,store)));
    cursor=messages.length?identity(messages.at(-1)):'empty';
    // No administrative checkpoint is required. Preserve native history within
    // an item; item transitions retain accepted state and the current edits.
    const delta={status:active.status,nextCall:workflowView(active).nextCall,focus:active.focus,items:workflowView(active).items,stopReason:active.stopReason,workingChanges:workingChanges(active),
      ...(active.progress?.recoveryIssuedAt!=null?{recovery:workflowView(active).recovery}:{})};
    const key=JSON.stringify(delta);
    if(key!==lastDelta){
      history.push({role:'user',content:[{type:'text',text:'Wardrobe state delta:\n'+key}]});lastDelta=key;
    }
    const allowed=new Set(terminal?[]:active.planReview?.phase==='draft'?['read','wardrobe_workflow']:coreTools);
    const systems=messages.filter(m=>m.role==='system').map(m=>{
      const sections={...m.sections};delete sections.agent_browser;delete sections.skills;
      if(typeof sections.tools==='string')sections.tools=sections.tools.split('\n').filter(line=>!/^\s*-\s/.test(line)||[...allowed].some(name=>line.trimStart().startsWith('- '+name+':'))).join('\n');
      sections.wardrobe=terminal
        ? 'Report the current Wardrobe status and end this turn.'
        : active.planReview?.phase==='draft'&&!active.runtimeBaseline
          ? proposeUpdateNext
          : active.planReview?.phase==='approved'&&active.status==='REVIEW_REQUIRED'&&!active.runtimeBaseline
            ? implementUpdateNext
            : workflowContract;
      return {...m,...(m.sections?{sections}:{}),...(m.toolsAdded?{toolsAdded:m.toolsAdded.filter(t=>allowed.has(t.name))}:{})};
    });
    const selected=[...systems,...constraints,snapshot,...history];
    pi.appendEntry?.('wardrobe.context',{handle:active.handle,batch:active.batch?.id,epoch,sourceMessages:messages.length,selectedMessages:selected.length,chars:JSON.stringify(selected).length});
    return {messages:selected};
  });
  pi.on?.('tool_call',async(event,ctx)=>{
    if(!active)return;
    if(closed.has(active.status))return {block:true,terminate:true,reason:finished.has(active.status)?'Workflow finished. Report its receipt.':'Workflow paused: '+active.status+'. Candidate preserved; explicit resume is required.'};
    if(active.planReview?.phase==='draft'&&event.toolName!=='read'&&
      !(event.toolName==='wardrobe_workflow'&&['focus','details','lookup','propose','probe'].includes(event.input?.action)))
      return {block:true,reason:'Read the supplied review material and present the capability report with propose. Implementation starts after human confirmation.'};
    const command=event.input?.command||'',file=event.input?.path||'';
    if(event.toolName==='bash'&&/(?:node\s+--test\s+(?:["']?\*|$)|npm\s+(?:run\s+)?test\b)/m.test(command))return {block:true,reason:'Use verify for native and workflow checks; submit exact affected test paths only for uncovered behavior.'};
    const implementation=import.meta.dirname,relativeImplementation=relative(ctx?.cwd||process.cwd(),implementation).replaceAll('\\','/');
    if((event.toolName==='read'&&resolve(ctx?.cwd||process.cwd(),file).startsWith(implementation+'/'))||(event.toolName==='bash'&&[implementation,relativeImplementation].filter(Boolean).some(prefix=>command.includes(prefix+'/'))))return {block:true,reason:'Use the public workflow contract or lookup; edit the candidate using nextCall.'};
  });
  pi.on?.('turn_end',async event=>{
    if(!active?.workspace?.root||event.message?.role!=='assistant')return;
    const turnMessages=[event.message,...(event.toolResults||[])],created=captureObservations(active.workspace.root,turnMessages,{source:active.workspace.source,cwd:process.cwd()});
    // A new shell result advances investigation even though its dependencies
    // cannot be revalidated later. Reusable evidence still requires freshness.
    const fresh=readObservations(active.workspace.root,created).filter(item=>item.fresh||item.tool==='bash'&&!item.error).map(item=>item.id);
    const errors=(event.toolResults||[]).filter(item=>item.isError||item.details?.isError);
    const failureSignature=errors.length?JSON.stringify(errors.map(item=>{let value=item.details;try{value||=JSON.parse(item.content?.find(c=>c.type==='text')?.text);}catch{}return [item.toolName,value?.code||value?.status||'TOOL_ERROR'];})):null;
    const providerErrorText=event.outcome==='error'&&event.message.stopReason==='error'?event.message.errorMessage||'':'';
    const {recordWorkflowTurn}=await import('./native-workflow.mjs');
    const result=await recordWorkflowTurn(store,active.workspace.root,{newObservations:fresh,failureSignature,outcome:event.outcome,errorText:providerErrorText,stopReason:event.message.stopReason});
    if(result.workspace&&result.handle)scope.accept(result);
    else active={...active,status:result.status,progress:result.progress,stopReason:result.stopReason};
  });
  pi.on?.('agent_before_settle',async event=>{
    if(!active||closed.has(active.status)||event.outcome!=='completed')return;
    if(!settleRetried){
      settleRetried=true;
      const message=active.progress?.consecutiveFailures?'The last tool call failed. Read its native error result and issue a corrected or different call; do not repeat unchanged input.':'Work is still unsubmitted. Repair a concrete failure or submit explicit decisions. The candidate is saved automatically.';
      return {entries:[{type:'custom_message',customType:'wardrobe.recovery',content:JSON.stringify({status:active.status,nextCall:workflowView(active).nextCall,requiredDecisions:active.requiredDecisions,message}),display:false}],continue:true};
    }
    const {pauseIncompleteWorkflow}=await import('./native-workflow.mjs');
    const result=await pauseIncompleteWorkflow(store,active.workspace.root);
    if(result.workspace&&result.handle){
      scope.accept(result);
      return {entries:[{type:'custom_message',customType:'wardrobe.recovery',content:JSON.stringify({status:active.status,nextCall:workflowView(active).nextCall,focus:active.focus,message:'The previous item is paused. Continue the independent focused item; resolve saved blockers before final verification.'}),display:false}],continue:true};
    }
    active={...active,...result};
  });
  // Pi emits agent_end before agent_before_settle. Release only after settlement.
  pi.on?.('agent_settled',clear);
  for(const event of ['session_start','session_shutdown','session_tree'])pi.on?.(event,()=>{bound=null;clear();});
  return scope;
}

function workingChanges(active){
  const source=active.workspace?.source,root=active.workspace?.root;
  if(!source||!existsSync(source))return {files:[]};
  try{
    const base=join(root,'base'),before=new Map(existsSync(base)?sourceFiles(base).map(([p,...identity])=>[p,JSON.stringify(identity)]):[]);
    const after=new Map(sourceFiles(source).map(([p,...identity])=>[p,JSON.stringify(identity)]));
    const files=[...new Set([...before.keys(),...after.keys()])].sort().filter(p=>before.get(p)!==after.get(p)).map(path=>({path,change:!before.has(path)?'added':!after.has(path)?'deleted':'modified'}));
    const file=join(root,'working-changes.json');writeFileSync(file,JSON.stringify(files),{mode:0o600});
    return {files:files.slice(0,32),total:files.length,fullList:file,next:'These edits are already present. Read current candidate files only when needed; verify seals their exact contents.'};
  }catch(error){return {error:error.message,next:'Correct the candidate source before verification.'};}
}

function archiveLargeResult(message,active,store){
  if(message.role!=='toolResult'||!Array.isArray(message.content))return message;
  if(message.toolName==='wardrobe_workflow')return {...message,content:message.content.map(part=>{if(part.type!=='text')return part;try{return {...part,text:JSON.stringify(workflowView(JSON.parse(part.text)))};}catch{return part;}})};
  const text=message.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  if(text.length<=12000||message.toolName==='read')return message;
  const folder=join(active.workspace?.root||store.root,'observations'),id=createHash('sha256').update(text).digest('hex');
  mkdirSync(folder,{recursive:true,mode:0o700});const file=join(folder,id+'.txt');
  if(!existsSync(file))writeFileSync(file,text,{mode:0o600});
  const content=[{type:'text',text:text.slice(0,6000)+'\n[Full result: '+file+'; read a needed range.]\n'+text.slice(-1500)},...message.content.filter(c=>c.type!=='text')];
  return {...message,content};
}
