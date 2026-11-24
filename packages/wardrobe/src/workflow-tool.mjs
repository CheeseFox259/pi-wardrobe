import { resolve } from 'node:path';
import { workflowView } from './workflow-view.mjs';
import { workflowInput } from './workflow-contract.mjs';
import { workflowContextFor } from './workflow-context.mjs';


export function registerWorkflowTool(pi, store) {
  const scope=workflowContextFor(pi,store);
  pi.registerTool({
    name: 'wardrobe_workflow', label: 'Wardrobe',
    promptSnippet: 'Manage preset normalization/import, incremental updates and focused fixes with verified installation.',
    promptGuidelines: ['For preset work, call wardrobe_workflow first. Its returned candidate, changed inputs and TASK.md are sufficient; avoid a separate repository inventory or legacy installer.'],
    description: 'Start update or maintain once. Shared method and preset component policy load together. Decompose compound work in submission.work while saving decisions; focus implementation:<id> for goal, paths, dependencies and checks. save records partial work and finite blockers; ready:true is an implementation claim, not verification. check runs exact affected checks before complete coverage. details restores the ledger. verify checks coverage, current claims, blockers, real dependencies and affected behavior. Install only at READY_TO_INSTALL with authorization. lookup provides dependency docs. Models/auth stay native Pi.',
    parameters: {
      type: 'object', properties: {
        action: { type: 'string', enum: ['normalize','update','maintain','focus','check','verify','install','import','details','lookup','guidance','probe','resume','save','propose'] },
        review: { type:'string',enum:['human'],description:'Update: present a brief capability report and wait for native user confirmation before implementation.' },
        revise: {type:'boolean',description:'Reopen a pending or approved report for revision before implementation starts.'},
        proposal: {type:'object',properties:{
          summary:{type:'string',maxLength:160,description:'Optional overview of several outcomes. Omit for a single outcome.'},validation:{type:'string',maxLength:220,description:'One sentence on how the visible result and its main preservation constraint will be checked.'},question:{type:'string',maxLength:180,description:'Optional choice for the user to confirm or send back for revision.'},
          changes:{type:'array',minItems:1,maxItems:6,description:'One row per user-visible outcome. Keep supporting file and registration work in its outcome.',items:{type:'object',properties:{
            component:{type:'string',maxLength:48},effect:{type:'string',maxLength:110},recommendation:{type:'string',enum:['adopt','adapt','defer','preserve']},reason:{type:'string',maxLength:110},
          },required:['component','effect','recommendation'],additionalProperties:false}},
        },required:['changes','validation'],additionalProperties:false},
        item: { type:'string',description:'focus: work item ID from the complete change list' },
        skills: { type:'array',items:{type:'string',enum:['update','maintain']},description:'guidance: generate standard workflow skills in the editable candidate; preserve companion files.' },
        profile: { type: 'string', description: 'Installed preset ID; defaults to current preset. For update/maintain, choose profile or source.' },
        source: { type: 'string', description: 'Preset source directory for normalize/import/update/maintain, not the working directory. Omit for an installed profile. For lookup: package keyword, or exact npm:<name>@<version>.' },
        request: { type: 'string', description: 'Concrete maintain request, or optional explicit resource integration requirement accompanying update' },
        submission: { type: 'object', description: 'Review submission (save may contain partial decisions and item blockers; verify requires full coverage): summary, decisions, resources, migrations, affected checks, blockers, resolvedBlockers, and typed obligations.', properties: {
          work:{type:'array',description:'Bounded implementation items. Declare goal, originating requirement/decision IDs, affected paths, dependencies and checks once; update by id. ready:true claims current path contents are implemented, not verified. Record missingFact before broadening investigation.',items:{type:'object',properties:{
            id:{type:'string'},origins:{type:'array',items:{type:'string'}},goal:{type:'string'},paths:{type:'array',items:{type:'string'}},dependsOn:{type:'array',items:{type:'string'}},ready:{type:'boolean'},
            checks:{type:'array',items:{type:'object',properties:{command:{type:'string'},args:{type:'array',items:{type:'string'}},reason:{type:'string'},broadReason:{type:'string'}},required:['command','args','reason'],additionalProperties:false}},
            missingFact:{type:['object','null'],properties:{question:{type:'string'},why:{type:'string'},nextStep:{type:'string'}},required:['question','why','nextStep'],additionalProperties:false},
          },required:['id'],additionalProperties:false}},
          summary:{type:'string'},decisions:{type:'array',items:{type:'object',properties:{id:{type:'string'},action:{type:'string',enum:['adopt','adapt','defer']},reason:{type:'string'}},required:['id','action','reason'],additionalProperties:false}},
          resources:{type:'array',items:{type:'object',properties:{action:{type:'string',enum:['add','replace','enable','disable','retire']},package:{type:'string',description:'Alias in preset.json packages, such as self or addon-7; not an npm/git source. retire may name a removed alias for an existing workflow catalog resource.'},kind:{type:'string',enum:['extensions','skills','prompts','themes']},path:{type:'string',description:'Safe relative resource path'},oldPath:{type:'string',description:'For replace: the previous safe relative resource path, not a package source'},enabled:{type:'boolean'},upstreamPath:{type:'string'}},required:['action','package','kind','path'],additionalProperties:false}},
          migrations:{type:'array',items:{type:'object',properties:{from:{type:'array',items:{type:'string'}},to:{type:'array',items:{type:'string'}},reason:{type:'string'}},required:['from','to','reason'],additionalProperties:false}},
          obligations:{type:'array',items:{type:'object',properties:{type:{type:'string',enum:['presentation']},location:{type:'string',enum:['statusline','composer']},contains:{type:'string',enum:['profile-name']},unique:{type:'boolean'},reload:{type:'boolean'}},required:['type','location','contains','unique','reload'],additionalProperties:false}},
          checks:{type:'array',items:{type:'object',properties:{command:{type:'string'},args:{type:'array',items:{type:'string'}},reason:{type:'string'},broadReason:{type:'string'}},required:['command','args','reason'],additionalProperties:false}},
          blockers:{type:'array',items:{type:'object',properties:{item:{type:'string'},reason:{type:'string'},nextStep:{type:'string'},needsUser:{type:'boolean'}},required:['item','reason','nextStep'],additionalProperties:false}},
          resolvedBlockers:{type:'array',items:{type:'string'}},
        },additionalProperties:false },
        approved: { type: 'boolean', description: 'Only when the user already authorized installation' },
        replace: { type:'boolean',description:'save only: replace review fields while preserving declared work obligations. Use to remove obsolete decisions, resources or checks.' },
      }, required: ['action'], additionalProperties: false,
    },
    async execute(_id, input, _signal, _update, ctx) {
      try {
        if(['update','maintain'].includes(input.action)){
          scope.start();
          pi.appendEntry('wardrobe.workflow',{action:input.action,status:'STARTING'});
        }
        input=workflowInput(store,await scope.bind(input,ctx));
        if(['update','maintain'].includes(input.action)&&input.profile&&input.source)
          throw Object.assign(new Error('Choose profile for an installed preset or source for a local preset directory. Do not pass both; retry without source to use the specified profile.'),{
            code:'WORKFLOW_TARGET_CONFLICT',nextCall:{action:input.action,profile:input.profile,...(input.request?{request:input.request}:{})},
          });
        const [{beginWorkflow,proposeWorkflow,focusWorkflow,checkWorkflowImplementation,verifyWorkflow,installWorkflow,workflowDetails,generateWorkflowGuidance,checkpointWorkflow,probeWorkflow,resumeWorkflow,saveWorkflowReview},{importLocal},{normalizePresetSource},{nativeReviewSummary},{nativeEnv},{lookupResource}]=await Promise.all([
          import('./native-workflow.mjs'), import('./native-authoring.mjs'), import('./native-normalize.mjs'),
          import('./native-review.mjs'), import('./native-service.mjs'), import('./resource-lookup.mjs'),
        ]);
        const config=store.read(),id=input.profile||process.env.WARDROBE_NATIVE_PROFILE||config.default;
        const profile=config.profiles[id];let result;
        const confirm=ctx.hasUI!==false&&ctx.ui?.confirm?(title,body)=>ctx.ui.confirm(title,body):undefined;
        if(input.action==='normalize'&&!input.source)throw new Error('normalize requires source: the legacy directory containing manifest.json');
        if(input.action==='focus')result=await focusWorkflow(store,input.workflow,input.item);
        else if(input.action==='check')result=await checkWorkflowImplementation(store,input.workflow,{item:input.item,signal:_signal});
        else if(input.action==='save')result=await saveWorkflowReview(store,input.workflow,input.submission,{replace:input.replace});
        else if(input.action==='guidance')result=await generateWorkflowGuidance(store,input.workflow,input.skills);
        else if(input.action==='checkpoint')result=await checkpointWorkflow(store,input.workflow,input.handle,input.findings||[],input.opId,input.observationIds||[]);
        else if(input.action==='probe')result=await probeWorkflow(store,input.workflow,{signal:_signal});
        else if(input.action==='propose')result=await proposeWorkflow(store,input.workflow,input.proposal,{confirm});
        else if(input.action==='resume')result=await resumeWorkflow(store,input.workflow,{confirm,revise:input.revise});
        else if(input.action==='lookup')result=await lookupResource(store,input.source,nativeEnv(store),{query:input.request});
        else if(input.action==='normalize')result=await normalizePresetSource(store,resolve(ctx.cwd,input.source||'.'));
        else if(input.action==='details')result=input.workflow?await workflowDetails(store,input.workflow,{merge:input.merge}):{status:'DETAILS',profile:profile&&{id:profile.id,name:profile.name,version:profile.version,agentDir:profile.agentDir},presets:Object.values(config.profiles).map(({id,name,version})=>({id,name,version}))};
        else if(input.action==='verify')result=await verifyWorkflow(store,input.workflow,{signal:_signal,batch:input.batch,revision:input.revision,submission:input.submission});
        else if(input.action==='install')result=await installWorkflow(store,input.workflow,{approved:input.approved});
        else if(input.action==='import'){
          if(!input.source)throw new Error('Standard local source directory required');
          let reviewed;
          const installed=await importLocal(store,resolve(ctx.cwd,input.source),{confirm:async plan=>{reviewed=plan;return input.approved===true},onProgress:entry=>_update?.({content:[{type:'text',text:'安装 '+entry.current+'/'+entry.total+' · '+entry.alias}],details:{progress:entry}})});
          result=installed?{status:'IMPORTED',profile:{id:installed.id,name:installed.name,version:installed.version},active:false,next:'Preset already imported and installed. Do not call install. Proceed with next requested step.'}:{status:'APPROVAL_REQUIRED',review:nativeReviewSummary(reviewed),next:'Retry import with approved:true only if the user has authorized installation; otherwise request approval of this review.'};
        } else {
          if(!input.source&&!profile)throw new Error('Select a preset or standard source directory');
          result=await beginWorkflow(store,{profile:input.source?null:profile,source:input.source&&resolve(ctx.cwd,input.source),mode:input.action,request:input.request||'',signal:_signal,review:input.review});
        }
        pi.appendEntry('wardrobe.workflow', {action:input.action,status:result.status,workflow:result.workspace?.root||input.workflow,profile:result.profile?.id});
        scope.accept(result);
        return {content:[{type:'text',text:JSON.stringify(workflowView(result,{action:input.action}))}],details:result};
      }catch(error){
        const details={status:error.name==='AbortError'?'CANCELLED':'ERROR',message:error.message,
          ...(error.code?{code:error.code}:{}),
          ...(error.code==='WORKFLOW_TARGET_CONFLICT'?{nextCall:error.nextCall}:{}),
          ...(error.code==='SKILL_REFERENCE_MISSING'?{references:error.references}:{}),
          ...(error.code==='RESOURCE_EXPORT_MISSING'?{resources:error.resources}:{}),
          ...(error.staging?{operation:'materialize',failure:error.staging.attempts.at(-1)?.failure,attempt:error.staging.attempts.at(-1)?.agentDir}:{}),
          ...(error.diagnostics?{diagnostics:error.diagnostics}:{})};
        Object.assign(details,scope.recovery());
        scope.accept(details);
        return {isError:true,content:[{type:'text',text:JSON.stringify(workflowView(details,{action:input.action}))}],details};
      }
    },
  });
}
