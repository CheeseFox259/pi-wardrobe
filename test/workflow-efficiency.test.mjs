import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { useHarness } from './support/harness.mjs';
import { NativeStore, writeJson } from '../packages/wardrobe/src/native-store.mjs';
import { registerWorkflowTool } from '../packages/wardrobe/src/workflow-tool.mjs';

const harness=useHarness('workflow-efficiency');

test('a workflow handle supplies exact calls and a verified receipt without learning storage paths',async()=>{
  const h=harness(),source=join(h.sandbox.work,'source');mkdirSync(source);
  writeJson(join(source,'package.json'),{name:'efficient',version:'1.0.0',type:'module',pi:{}});
  writeJson(join(source,'preset.json'),{schemaVersion:1,id:'efficient/demo',name:'Efficient',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[]});
  const old=process.env.WARDROBE_PI_CLI;process.env.WARDROBE_PI_CLI=h.runtime.cliPath;
  try{
    const store=new NativeStore(h.sandbox.seedAgent('handle'));let tool;
    registerWorkflowTool({registerTool:t=>tool=t,appendEntry(){}},store);
    const call=async input=>(await tool.execute('test',input,undefined,undefined,{cwd:h.sandbox.project})).details;
    assert.equal((await call({action:'verify'})).code,'WORKFLOW_INPUT_REQUIRED');
    const ready=await call({action:'maintain',source,request:'Add one local instruction'});
    assert.ok(ready.handle);assert.equal(ready.nextCall.handle,ready.handle);
    assert.equal(ready.nextCall.action,'verify');
    const missing=await call({action:'verify'});
    assert.match(missing.message,/Submit summary/);
    assert.equal(missing.nextCall.handle,ready.handle,'recoverable input errors carry the exact current call');
    const nested=join(ready.workspace.source,'global/skills/maintain');mkdirSync(nested,{recursive:true});
    writeFileSync(join(nested,'SKILL.md'),'---\nname: maintain\ndescription: Custom maintenance\n---\nAlways preserve our custom workflow owner.\n');
    writeJson(join(ready.workspace.source,'components.json'),{skills:{maintain:{type:'custom',localPath:'global/skills/maintain/SKILL.md'}}});
    const guidance=await call({action:'guidance',handle:ready.handle,skills:['update','maintain']});
    assert.equal(guidance.status,'REVIEW_REQUIRED',JSON.stringify(guidance));
    assert.match(readFileSync(join(ready.workspace.source,'skills/update/SKILL.md'),'utf8'),/NO_UPDATE/);
    assert.equal(JSON.parse(readFileSync(join(ready.workspace.source,'components.json'),'utf8')).skills.update.workflowRole,'update');
    assert.equal(existsSync(join(ready.workspace.source,'skills/maintain/SKILL.md')),false);
    const entry=readFileSync(join(nested,'SKILL.md'),'utf8');
    assert.match(entry,/skills\.shared.*skills\.preset/);
    assert.doesNotMatch(entry,/Always preserve our custom workflow owner/,'previous execution prose is not injected as active policy');
    const archive=entry.match(/\((legacy-workflow-[a-f0-9]+\.md)\)/)?.[1];
    assert.ok(archive);assert.match(readFileSync(join(nested,archive),'utf8'),/Always preserve our custom workflow owner/);
    writeFileSync(join(nested,'SKILL.md'),entry+'\nKeep the later local choice.\n');
    await call({action:'guidance',skills:['maintain']});
    const regenerated=readFileSync(join(nested,'SKILL.md'),'utf8');
    const laterArchive=regenerated.match(/\((legacy-workflow-[a-f0-9]+\.md)\)/)?.[1];
    assert.match(readFileSync(join(nested,laterArchive),'utf8'),/Keep the later local choice/);
    assert.match(readFileSync(join(nested,archive),'utf8'),/Always preserve our custom workflow owner/);
    await call({action:'guidance',skills:['maintain']});
    assert.equal(readFileSync(join(nested,'SKILL.md'),'utf8'),regenerated,'unchanged delegate regeneration is stable');
    writeFileSync(join(ready.workspace.source,'instruction.md'),'Preserve our workflow.\n');
    const verified=await call({...ready.nextCall,submission:{...ready.nextCall.submission,summary:'Add instruction',checks:[]}});
    assert.equal(verified.status,'READY_TO_INSTALL',JSON.stringify(verified));
    const stale=await call({...ready.nextCall,submission:{summary:'Wrong old work',decisions:[],checks:[]}});
    assert.equal(stale.code,'WORKFLOW_STALE_SUBMISSION');
    assert.equal((await call({action:'install',handle:ready.handle,approved:true})).code,'WORKFLOW_STALE_SUBMISSION','old work item cannot authorize a different verified revision');
    const installed=await call({...verified.nextCall,approved:true});
    assert.equal(installed.status,'INSTALLED',JSON.stringify(installed));
    assert.equal(installed.modelRequired,false);assert.equal(installed.receipt.defaultUnchanged,true);
    assert.ok(installed.receipt.sourceDigest);assert.ok(installed.receipt.checks.length);
    assert.equal(readFileSync(join(ready.workspace.source,'instruction.md'),'utf8'),'Preserve our workflow.\n');
    assert.equal(store.read().default,null);
  }finally{if(old===undefined)delete process.env.WARDROBE_PI_CLI;else process.env.WARDROBE_PI_CLI=old;}
});

test('checkpoint preserves cited findings in the durable workflow record and rejects unknown evidence IDs',async()=>{
  const h=harness(),source=join(h.sandbox.work,'checkpoint-source');mkdirSync(source);
  writeJson(join(source,'package.json'),{name:'checkpoint',version:'1.0.0',type:'module',pi:{}});
  writeJson(join(source,'preset.json'),{schemaVersion:1,id:'checkpoint/demo',name:'Checkpoint',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[]});
  const old=process.env.WARDROBE_PI_CLI;process.env.WARDROBE_PI_CLI=h.runtime.cliPath;
  try{
    let tool;registerWorkflowTool({registerTool:t=>tool=t,appendEntry(){}},new NativeStore(h.sandbox.seedAgent('checkpoint')));
    const call=async input=>(await tool.execute('test',input,undefined,undefined,{cwd:h.sandbox.project})).details;
    const step=await call({action:'maintain',source,request:'Keep the local entry point.'});
    const {captureObservations}=await import('../packages/wardrobe/src/workflow-observations.mjs');
    const id=captureObservations(step.workspace.root,[{role:'assistant',content:[{type:'toolCall',id:'read-42',name:'read',arguments:{path:join(step.workspace.source,'package.json')}}]},{role:'toolResult',toolName:'read',toolCallId:'read-42',content:[{type:'text',text:'The local package exports the required entry point.'}]}],{source:step.workspace.source})[0];
    const invalid=await call({action:'checkpoint',handle:step.handle,findings:[{claim:'Unsupported fact',observations:['missing']}]});
    assert.equal(invalid.code,'WORKFLOW_OBSERVATION_REQUIRED');
    const finding={claim:'The entry point is local and must remain available.',observations:[id],status:'tentative'};
    const saved=await call({action:'checkpoint',handle:step.handle,findings:[finding],opId:'finding-1'});
    assert.equal(saved.checkpoint.saved,1);
    const duplicate=await call({action:'checkpoint',handle:step.handle,findings:[{...finding,claim:'Changed on retry'}],opId:'finding-1'});
    assert.equal(duplicate.checkpoint.findings.length,1,'retrying the same operation ID does not append another finding');
    const {loadWorkflowRecord}=await import('../packages/wardrobe/src/workflow-journal.mjs');
    const record=loadWorkflowRecord(step.workspace.root);
    assert.equal(record.findings[0].claim,'The entry point is local and must remain available.');
    assert.deepEqual(record.findings[0].observations,[id]);
  }finally{if(old===undefined)delete process.env.WARDROBE_PI_CLI;else process.env.WARDROBE_PI_CLI=old;}
});

test('native settlement offers one bounded continuation and preserves an incomplete candidate on a second settlement',async()=>{
  const h=harness(),source=join(h.sandbox.work,'settle-source');mkdirSync(source);
  writeJson(join(source,'package.json'),{name:'settle',version:'1.0.0',pi:{}});
  writeJson(join(source,'preset.json'),{schemaVersion:1,id:'settle/demo',name:'Settle',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[]});
  const old=process.env.WARDROBE_PI_CLI;process.env.WARDROBE_PI_CLI=h.runtime.cliPath;
  try{
    const store=new NativeStore(h.sandbox.seedAgent('settle')),handlers=new Map();let tool;
    registerWorkflowTool({on:(name,handler)=>handlers.set(name,handler),registerTool:value=>tool=value,appendEntry(){}},store);
    const step=(await tool.execute('settle',{action:'maintain',source,request:'Add an instruction'},undefined,undefined,{cwd:h.sandbox.project})).details;
    writeFileSync(join(step.workspace.source,'unsubmitted.md'),'Preserve this candidate edit.\n');
    assert.equal(await handlers.get('agent_before_settle')({outcome:'aborted'}),undefined,'cancellation must never trigger an automatic request');
    assert.equal(handlers.has('agent_end'),false,'state survives the lower-level end event');
    assert.equal((await handlers.get('agent_before_settle')({outcome:'completed'})).continue,true);
    assert.equal(await handlers.get('agent_before_settle')({outcome:'completed'}),undefined);
    const {loadWorkflowRecord}=await import('../packages/wardrobe/src/workflow-journal.mjs');
    assert.equal(loadWorkflowRecord(step.workspace.root).status,'STALLED');
    assert.match(readFileSync(join(step.workspace.source,'unsubmitted.md'),'utf8'),/Preserve this candidate edit/);
    handlers.get('agent_settled')();
    assert.equal(handlers.get('context_with_system')({messages:[]}),undefined,'normal conversation is released after final settlement');
  }finally{if(old===undefined)delete process.env.WARDROBE_PI_CLI;else process.env.WARDROBE_PI_CLI=old;}
});

test('explicit resume migrates an open v2 candidate side by side and invalidates its verification evidence',async()=>{
  const h=harness(),dir=h.sandbox.seedAgent('resume-v2'),store=new NativeStore(dir),legacyRoot=join(store.root,'updates','legacy');
  const old=process.env.WARDROBE_PI_CLI;process.env.WARDROBE_PI_CLI=h.runtime.cliPath;
  try{
  mkdirSync(join(legacyRoot,'source'),{recursive:true});mkdirSync(join(legacyRoot,'base'),{recursive:true});
  writeFileSync(join(legacyRoot,'source','feature.md'),'unsubmitted edit\n');writeFileSync(join(legacyRoot,'base','feature.md'),'base\n');
  const record={root:legacyRoot,source:join(legacyRoot,'source'),baseDigest:'legacy-digest',inputDigest:'legacy-input',inputsDigest:'legacy-inputs',mode:'update',request:'Keep the feature',name:'Legacy',profile:null,status:'REVIEW_REQUIRED',protocolVersion:2,revision:4,piVersion:'1.0.4',accepted:[{id:'prior',submission:{summary:'accepted earlier',decisions:[]},checks:[{code:0}],evidence:[{key:'old',outcome:{code:0}}]}],batches:[{id:'pending',title:'Pending',required:['pending'],files:[],status:'pending'}],resources:[]};
  writeJson(join(legacyRoot,'workflow.json'),record);
  const {resumeWorkflow}=await import('../packages/wardrobe/src/native-workflow.mjs'),resumed=await resumeWorkflow(store,legacyRoot);
  assert.equal(resumed.protocolVersion,3);assert.equal(resumed.migratedFrom.root,legacyRoot);assert.notEqual(resumed.workspace.root,legacyRoot);
  assert.equal(readFileSync(join(resumed.workspace.source,'feature.md'),'utf8'),'unsubmitted edit\n');
  assert.equal(resumed.completed[0].summary,'accepted earlier');
  const {loadWorkflowRecord}=await import('../packages/wardrobe/src/workflow-journal.mjs'),migrated=loadWorkflowRecord(resumed.workspace.root);
  assert.deepEqual(migrated.accepted[0].checks,[]);assert.deepEqual(migrated.accepted[0].evidence,[]);
  assert.equal(loadWorkflowRecord(legacyRoot).protocolVersion,2,'the original record remains available as evidence');
  }finally{if(old===undefined)delete process.env.WARDROBE_PI_CLI;else process.env.WARDROBE_PI_CLI=old;}
});

test('native turn accounting issues one recovery checkpoint, stalls at the frozen boundary, and resumes explicitly',async()=>{
  const h=harness(),dir=h.sandbox.seedAgent('progress'),store=new NativeStore(dir),root=join(store.root,'maintenance','progress');mkdirSync(root,{recursive:true});
  const old=process.env.WARDROBE_PI_CLI;process.env.WARDROBE_PI_CLI=h.runtime.cliPath;
  try{
    mkdirSync(join(root,'source'),{recursive:true});mkdirSync(join(root,'base'),{recursive:true});
    const {sourceDigest}=await import('../packages/wardrobe/src/native-snapshot.mjs');
    writeJson(join(root,'workflow.json'),{root,source:join(root,'source'),baseDigest:sourceDigest(join(root,'base')),inputsDigest:'74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',protocolVersion:3,workflowVersion:3,revision:0,piVersion:h.runtime.version,mode:'maintain',status:'REVIEW_REQUIRED',accepted:[],batches:[{id:'item',required:['item'],files:[],status:'pending'}]});
    const {recordWorkflowTurn,resumeWorkflow}=await import('../packages/wardrobe/src/native-workflow.mjs');
    for(let i=0;i<7;i++)assert.equal((await recordWorkflowTurn(store,root)).status,'REVIEW_REQUIRED');
    const recovery=await recordWorkflowTurn(store,root);assert.equal(recovery.status,'REVIEW_REQUIRED');assert.ok(recovery.progress.recoveryMessage);
    assert.match(recovery.progress.recoveryMessage,/submit the current decisions/);
    assert.match(recovery.progress.recoveryMessage,/saved automatically/);
    for(let i=0;i<7;i++)assert.equal((await recordWorkflowTurn(store,root)).status,'REVIEW_REQUIRED');
    assert.equal((await recordWorkflowTurn(store,root)).status,'STALLED');
    const resumed=await resumeWorkflow(store,root);assert.equal(resumed.status,'REVIEW_REQUIRED');
    const quota=await recordWorkflowTurn(store,root,{outcome:'error',errorText:'429 Token Plan usage limit'});assert.equal(quota.status,'SUSPENDED_QUOTA');
    const continued=await resumeWorkflow(store,root);assert.equal(continued.status,'REVIEW_REQUIRED');
  }finally{if(old===undefined)delete process.env.WARDROBE_PI_CLI;else process.env.WARDROBE_PI_CLI=old;}
});

test('quota suspension uses provider errors, not ordinary failed tool output',async()=>{
  const h=harness(),store=new NativeStore(h.sandbox.seedAgent('quota-classification')),root=join(store.root,'updates','quota-classification'),source=join(root,'source');
  mkdirSync(source,{recursive:true});mkdirSync(join(root,'base'));
  const {sourceDigest}=await import('../packages/wardrobe/src/native-snapshot.mjs');
  writeJson(join(root,'workflow.json'),{root,source,baseDigest:sourceDigest(join(root,'base')),inputsDigest:'74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',protocolVersion:3,workflowVersion:3,revision:0,piVersion:h.runtime.version,mode:'update',status:'REVIEW_REQUIRED',accepted:[],batches:[{id:'runtime',required:['runtime'],files:[],status:'pending'}]});
  const handlers=new Map();
  const {workflowContextFor}=await import('../packages/wardrobe/src/workflow-context.mjs');
  workflowContextFor({on:(event,handler)=>handlers.set(event,handler)},store).accept({status:'REVIEW_REQUIRED',handle:'quota-classification',workspace:{root,source},batch:{id:'runtime'},request:'Review the native runtime update.'});
  await handlers.get('turn_end')({outcome:'completed',message:{role:'assistant',stopReason:'toolUse',content:[{type:'toolCall',id:'package-list',name:'bash',arguments:{command:'npm list'}}]},toolResults:[{role:'toolResult',toolName:'bash',toolCallId:'package-list',isError:true,content:[{type:'text',text:'express-rate-limit\nCommand exited with code 1'}]}]});
  const {loadWorkflowRecord}=await import('../packages/wardrobe/src/workflow-journal.mjs');
  const record=loadWorkflowRecord(root);
  assert.equal(record.status,'REVIEW_REQUIRED');
  assert.equal(record.progress.assistantTurns,1);
  await handlers.get('turn_end')({outcome:'error',message:{role:'assistant',stopReason:'error',errorMessage:'HTTP 429: Token Plan usage limit',content:[]},toolResults:[]});
  assert.equal(loadWorkflowRecord(root).status,'SUSPENDED_QUOTA');
});

test('workflow context keeps uncheckpointed investigation and actual edited files at the soft threshold',async()=>{
  const h=harness(),root=join(h.sandbox.work,'durable-context'),source=join(root,'source');
  mkdirSync(source,{recursive:true});mkdirSync(join(root,'base'));
  writeFileSync(join(source,'feature.mjs'),'export const enabled=true;\n');
  writeFileSync(join(root,'base/feature.mjs'),'export const enabled=false;\n');
  const handlers=new Map(),pi={on:(name,fn)=>handlers.set(name,fn)};
  const {workflowContextFor}=await import('../packages/wardrobe/src/workflow-context.mjs');
  const scope=workflowContextFor(pi,new NativeStore(h.sandbox.seedAgent('durable-context')));
  scope.accept({status:'REVIEW_REQUIRED',handle:'durable',workspace:{root,source},batch:{id:'change'},request:'Preserve the custom feature.'});
  const user={role:'user',content:'Keep native models and the custom feature.',timestamp:1};
  handlers.get('context_with_system')({messages:[user]});
  const old={role:'assistant',timestamp:2,content:[{type:'text',text:'STALE_EXPLORATION'}]};
  const recent=Array.from({length:12},(_,i)=>({role:'assistant',timestamp:10+i,content:[{type:'text',text:'Read relevant public interface '+i}]}));
  const result=handlers.get('context_with_system')({messages:[user,old,...recent]});
  assert.match(JSON.stringify(result),/STALE_EXPLORATION/,'unsubmitted investigation remains until a durable checkpoint');
  const delta=JSON.parse(result.messages.findLast(m=>m.role==='user'&&m.content?.[0]?.text?.startsWith('Wardrobe state delta:')).content[0].text.split('\n').slice(1).join('\n'));
  assert.equal(delta.checkpointRequired,undefined,'context length never creates an administrative barrier');
  const frame=result.messages.find(m=>m.role==='user'&&JSON.stringify(m.content).includes('authoritative program state'));
  const state=JSON.parse(frame.content[0].text.split('\n').slice(1).join('\n'));
  assert.deepEqual(state.workingChanges.files.map(f=>({path:f.path,change:f.change})),[{path:'feature.mjs',change:'modified'}]);
  assert.equal(readFileSync(join(source,'feature.mjs'),'utf8'),'export const enabled=true;\n');
});

test('workflow context preserves user constraints, resets old batches and restores normal tools after completion',async()=>{
  const h=harness(),handlers=new Map();const pi={on:(event,fn)=>handlers.set(event,fn)};
  const { workflowContextFor }=await import('../packages/wardrobe/src/workflow-context.mjs');
  const scope=workflowContextFor(pi,new NativeStore(h.sandbox.seedAgent('context')));
  const normal=[{role:'system',sections:{rules:'Keep project rules.',agent_browser:'Large browser handbook'},toolsAdded:[{name:'read'},{name:'agent_browser'}]},{role:'user',content:'Preserve local alpha; installation is authorized.'}];
  assert.equal(handlers.get('context_with_system')({messages:normal}),undefined);
  scope.accept({status:'REVIEW_REQUIRED',handle:'first',workspace:{root:h.sandbox.work,source:h.sandbox.project},batch:{id:'alpha'},request:'Upgrade without losing alpha'});
  const managerCwd=new URL('../packages/wardrobe/',import.meta.url).pathname;
  assert.equal((await handlers.get('tool_call')({toolName:'bash',input:{command:'cat src/agent-files.mjs'}},{cwd:managerCwd}))?.block,true,'relative manager source reads use the actual install location');
  const old={role:'assistant',content:[{type:'text',text:'OLD_BATCH_DIAGNOSIS'}]};
  const user={role:'user',content:'Also preserve beta.'},summary={role:'compactionSummary',content:'Prior user required keeping gamma.'};
  const first=handlers.get('context_with_system')({messages:[...normal,old,user,summary]});
  assert.match(JSON.stringify(first),/Also preserve beta/);assert.match(JSON.stringify(first),/Preserve local alpha/);
  assert.doesNotMatch(JSON.stringify(first),/Large browser handbook/);
  assert.match(JSON.stringify(first),/Keep project rules/);
  assert.match(JSON.stringify(first),/keeping gamma/);
  const rewritten=handlers.get('context_with_system')({messages:[normal[0],summary,{role:'assistant',timestamp:20,content:[{type:'toolCall',id:'new-read',name:'read',arguments:{path:'file'}}]},{role:'toolResult',toolName:'read',toolCallId:'new-read',content:[{type:'text',text:'NEW_TOOL_EVIDENCE'}]}]});
  assert.match(JSON.stringify(rewritten),/NEW_TOOL_EVIDENCE/);
  scope.accept({status:'REVIEW_REQUIRED',handle:'next',workspace:{root:h.sandbox.work,source:h.sandbox.project},batch:{id:'beta'}});
  const second=handlers.get('context_with_system')({messages:[...normal,old,user]});
  assert.doesNotMatch(JSON.stringify(second),/OLD_BATCH_DIAGNOSIS/);
  scope.accept({status:'INSTALLED',modelRequired:false,receipt:{checks:[{code:0}]}});
  const end=handlers.get('context_with_system')({messages:normal});
  assert.equal(end.messages.find(m=>m.role==='system').toolsAdded.length,0);
  handlers.get('agent_settled')();
  assert.equal(handlers.get('context_with_system')({messages:normal}),undefined);
  scope.accept({status:'REVIEW_REQUIRED',handle:'unfinished',workspace:{root:h.sandbox.work,source:h.sandbox.project},batch:{id:'beta'}});
  handlers.get('agent_settled')();
  assert.equal(handlers.get('context_with_system')({messages:normal}),undefined,'an unfinished task is durable but must not constrain the next user conversation');
});

test('focus changes retain the decision ledger and constraints without treating prior exploration as progress',async()=>{
  const h=harness(),handlers=new Map(),pi={on:(event,fn)=>handlers.set(event,fn)};
  const {workflowContextFor}=await import('../packages/wardrobe/src/workflow-context.mjs');
  const scope=workflowContextFor(pi,new NativeStore(h.sandbox.seedAgent('focus-context'))),normal=[{role:'system',sections:{rules:'Keep native models.'}},{role:'user',content:'Preserve the local method.'}];
  const saved={summary:'Alpha decided',decisions:[{id:'skill:alpha',action:'adopt',reason:'Independent evidence'}],checks:[]};
  scope.accept({status:'REVIEW_REQUIRED',execution:'change-list',handle:'focus-alpha',workspace:{root:h.sandbox.work,source:h.sandbox.project},focus:{id:'alpha'},items:[{id:'alpha',status:'decided'},{id:'beta',status:'pending'}],saved});
  handlers.get('context_with_system')({messages:[...normal,{role:'assistant',content:[{type:'text',text:'OLD_INVESTIGATION_NOT_A_DECISION'}]}]});
  scope.accept({status:'REVIEW_REQUIRED',execution:'change-list',handle:'focus-beta',workspace:{root:h.sandbox.work,source:h.sandbox.project},focus:{id:'beta'},items:[{id:'alpha',status:'decided'},{id:'beta',status:'in_progress'}],saved});
  const projected=handlers.get('context_with_system')({messages:normal}),text=JSON.stringify(projected),frame=projected.messages.find(m=>m.role==='user'&&m.content?.[0]?.text?.startsWith('Current Wardrobe work item'));
  const state=JSON.parse(frame.content[0].text.split('\n').slice(1).join('\n'));
  assert.equal(state.focus.id,'beta');assert.equal(state.saved.summary,'Alpha decided');assert.equal(state.saved.decisions[0].id,'skill:alpha');assert.equal(state.items[0].status,'decided');
  assert.match(text,/Preserve the local method/);assert.doesNotMatch(text,/OLD_INVESTIGATION_NOT_A_DECISION/);
});

test('nonoverlapping upstream text is merged mechanically while capability decisions remain required',async()=>{
  const h=harness(),source=join(h.sandbox.work,'merge-source');
  const original='---\nname: local\ndescription: Local method\n---\nUpstream old rule.\n\nSection one.\n\nSection two.\n\nLocal old rule.\n';
  const script='echo upstream-old\n\n# spacer one\n\n# spacer two\n\necho local-old\n';
  const upstream=await h.gitRepo('merge-upstream',[{message:'base',files:{'skills/local/SKILL.md':original,'skills/local/run.sh':script}},{message:'new rule',files:{'skills/local/SKILL.md':original.replace('Upstream old','Upstream new'),'skills/local/run.sh':script.replace('upstream-old','upstream-new')}}]);
  const repo=upstream.sourceAt(upstream.commits[0]).slice(4).replace(/@[a-f0-9]{40}$/,'');
  mkdirSync(join(source,'skills/local'),{recursive:true});
  writeFileSync(join(source,'skills/local/SKILL.md'),original.replace('Local old','Local custom'));
  writeFileSync(join(source,'skills/local/run.sh'),script.replace('local-old','local-custom'));chmodSync(join(source,'skills/local/run.sh'),0o755);
  writeJson(join(source,'package.json'),{name:'merge-work',version:'1.0.0',pi:{skills:['skills/local/SKILL.md']}});
  writeJson(join(source,'preset.json'),{schemaVersion:1,id:'merge/work',name:'Merge',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[{package:'self',kind:'skills',include:['skills/local/SKILL.md']}]});
  writeJson(join(source,'manifest.json'),{piVersion:h.runtime.version});
  writeJson(join(source,'components.json'),{upstreams:{fixture:{repo,pinnedRef:upstream.commits[0]}},skills:{local:{type:'override',upstream:'fixture',baseRef:upstream.commits[0],localPath:'skills/local/SKILL.md',upstreamRelPath:'skills/local/SKILL.md'}}});
  const old=process.env.WARDROBE_PI_CLI;process.env.WARDROBE_PI_CLI=h.runtime.cliPath;
  try{
    let tool;registerWorkflowTool({registerTool:t=>tool=t,appendEntry(){}},new NativeStore(h.sandbox.seedAgent('merge')));
    const result=(await tool.execute('test',{action:'update',source},undefined,undefined,{cwd:h.sandbox.project})).details;
    const text=readFileSync(join(result.workspace.source,'skills/local/SKILL.md'),'utf8');
    assert.match(text,/Upstream new rule/);assert.match(text,/Local custom rule/);
    assert.deepEqual(result.requiredDecisions,['skill:local']);
    assert.equal(result.decisions[0].merge,'CLEAN');
    assert.ok(statSync(join(result.workspace.source,'skills/local/run.sh')).mode&0o111,'local executable mode survives unrelated upstream text');
  }finally{if(old===undefined)delete process.env.WARDROBE_PI_CLI;else process.env.WARDROBE_PI_CLI=old;}
});

test('verify collects session-start warnings and workflow-skill defects before installing',async()=>{
  const h=harness(),source=join(h.sandbox.work,'startup-source');mkdirSync(join(source,'extensions'),{recursive:true});
  writeJson(join(source,'package.json'),{name:'startup-check',version:'1.0.0',type:'module',pi:{extensions:['extensions/main.mjs']}});
  writeJson(join(source,'preset.json'),{schemaVersion:1,id:'startup/check',name:'Startup',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[{package:'self',kind:'extensions',include:['extensions/main.mjs']}]});
  writeFileSync(join(source,'extensions/main.mjs'),'export default pi=>{};\n');
  const old=process.env.WARDROBE_PI_CLI;process.env.WARDROBE_PI_CLI=h.runtime.cliPath;
  try{
    const store=new NativeStore(h.sandbox.seedAgent('startup'));let tool;registerWorkflowTool({registerTool:t=>tool=t,appendEntry(){}},store);
    const call=async input=>(await tool.execute('test',input,undefined,undefined,{cwd:h.sandbox.project})).details;
    const step=await call({action:'maintain',source,request:'Change the extension and add a preset update skill'}),candidate=step.workspace.source;
    writeFileSync(join(candidate,'extensions/main.mjs'),"export default pi=>pi.on('session_start',(_e,ctx)=>ctx.ui.notify('Fixture owner clash','warning'));\n");
    mkdirSync(join(candidate,'skills/update'),{recursive:true});writeFileSync(join(candidate,'skills/update/SKILL.md'),'---\nname: update\ndescription: Upgrade this preset\n---\nUse a generic manual workflow.\n');
    writeJson(join(candidate,'components.json'),{skills:{update:{type:'custom',localPath:'skills/update/SKILL.md',workflowRole:'update'}}});
    const submission={summary:'New extension and workflow',decisions:[],resources:[{action:'add',package:'self',kind:'skills',path:'skills/update/SKILL.md'}],checks:[]};
    const result=await call({action:'verify',handle:step.handle,submission});
    assert.equal(result.status,'CHECK_FAILED',JSON.stringify(result));
    const errors=JSON.stringify(result.checks.filter(c=>c.code!==0));
    assert.match(errors,/Fixture owner clash/);assert.match(errors,/WORKFLOW_SKILL_CONTRACT/);
    assert.equal(Object.keys(store.read().profiles).length,0);
  }finally{if(old===undefined)delete process.env.WARDROBE_PI_CLI;else process.env.WARDROBE_PI_CLI=old;}
});

test('verify automatically runs newly changed behavior tests without selecting unrelated old suites',async()=>{
  const h=harness(),source=join(h.sandbox.work,'affected-source');mkdirSync(source);
  writeJson(join(source,'package.json'),{name:'affected-check',version:'1.0.0',type:'module',pi:{}});
  writeJson(join(source,'preset.json'),{schemaVersion:1,id:'affected/check',name:'Affected',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[]});
  writeFileSync(join(source,'unrelated.test.mjs'),"throw Error('Unrelated old suite must not run');\n");
  const old=process.env.WARDROBE_PI_CLI;process.env.WARDROBE_PI_CLI=h.runtime.cliPath;
  try{
    let tool;registerWorkflowTool({registerTool:t=>tool=t,appendEntry(){}},new NativeStore(h.sandbox.seedAgent('affected')));
    const call=async input=>(await tool.execute('test',input,undefined,undefined,{cwd:h.sandbox.project})).details;
    const step=await call({action:'maintain',source,request:'Add one covered behavior'});
    writeFileSync(join(step.workspace.source,'feature.test.mjs'),"import {test} from 'node:test';test('feature',()=>{throw Error('Affected failure');});\n");
    let result=await call({...step.nextCall,submission:{summary:'New behavior',decisions:[],checks:[]}});
    assert.equal(result.status,'CHECK_FAILED',JSON.stringify(result));
    assert.match(JSON.stringify(result.checks),/Affected failure/);
    assert.doesNotMatch(JSON.stringify(result.checks),/Unrelated old suite must not run/);
    writeFileSync(join(step.workspace.source,'feature.test.mjs'),"import {test} from 'node:test';test('feature',()=>{});\n");
    await call({action:'save',submission:{summary:'Correct the new behavior',decisions:[{id:'verification-repair',action:'adapt',reason:'Corrected the affected behavior test'}],checks:[]}});
    result=await call({action:'verify'});
    assert.equal(result.status,'READY_TO_INSTALL',JSON.stringify(result));
  }finally{if(old===undefined)delete process.env.WARDROBE_PI_CLI;else process.env.WARDROBE_PI_CLI=old;}
});

test('the native Pi provider sees the scoped workflow prompt and retains its native model',async()=>{
  const h=harness(),agent='native-context',dir=h.sandbox.seedAgent(agent),source=join(h.sandbox.work,'native-source');
  mkdirSync(source);writeJson(join(source,'package.json'),{name:'native-context',version:'1.0.0',pi:{}});
  writeJson(join(source,'preset.json'),{schemaVersion:1,id:'native/context',name:'Native',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[]});
  await h.pi.runOk(agent,['install',join(process.cwd(),'packages/wardrobe')]);
  const session=await h.pi.rpc(agent),file=join(dir,'fixture-request.jsonl');
  try{
    await session.command('fixture-use-local');
    const before=(await session.request('get_state')).data.model;
    await session.command('wardrobe maintain --source '+JSON.stringify(source)+' --request '+JSON.stringify('Keep our local constraints and add one instruction.'));
    const deadline=Date.now()+10000;
    while(!existsSync(file)){assert.ok(Date.now()<deadline,session.stderr);await new Promise(r=>setTimeout(r,20));}
    const request=JSON.parse(readFileSync(file,'utf8').trim().split('\n').at(-1));
    assert.match(request.systemPrompt,/Install at READY_TO_INSTALL/);
    assert.equal(request.model,before.provider+'/'+before.id);
  }finally{await session.close();}
});

test('statusline maintenance must pass native interactive rendering and reload before installation',async()=>{
  const h=harness(),source=join(h.sandbox.work,'ui-source');mkdirSync(join(source,'extensions'),{recursive:true});
  writeJson(join(source,'package.json'),{name:'ui-check',version:'1.0.0',type:'module',pi:{extensions:['extensions/identity.mjs']},
    wardrobe:{deviceBindings:[{id:'mcp',name:'Local MCP configuration',kind:'file',target:'mcp.json',required:true}]}});
  writeJson(join(source,'preset.json'),{schemaVersion:1,id:'ui/check',name:'UniqueUIProbe',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[{package:'self',kind:'extensions',include:['extensions/identity.mjs']}]});
  writeFileSync(join(source,'extensions/identity.mjs'),'export default pi=>{};\n');
  const old=process.env.WARDROBE_PI_CLI;process.env.WARDROBE_PI_CLI=h.runtime.cliPath;
  try{
    let tool;registerWorkflowTool({registerTool:t=>tool=t,appendEntry(){}},new NativeStore(h.sandbox.seedAgent('ui-check')));
    const call=async input=>(await tool.execute('test',input,undefined,undefined,{cwd:h.sandbox.project})).details;
    const step=await call({action:'maintain',source,request:'Move preset identity into the statusline'});
    const file=join(step.workspace.source,'extensions/identity.mjs');
    writeFileSync(file,"export default pi=>pi.events.on('wardrobe:preset',({profile,ui})=>ui.setStatus('identity',profile.name));\n");
    const input={...step.nextCall,submission:{summary:'Statusline identity',decisions:[],obligations:[{type:'presentation',location:'statusline',contains:'profile-name',unique:true,reload:true}],checks:[]}};
    let result=await call(input);assert.equal(result.status,'CHECK_FAILED',JSON.stringify(result));
    assert.match(JSON.stringify(result.checks),/identity must appear once/);
    writeFileSync(file,"export default pi=>pi.events.on('wardrobe:preset',({profile,ui})=>{ui.setWidget('wardrobe',undefined);ui.setStatus('identity',profile.name);});\n");
    await call({action:'save',submission:{summary:'Repair statusline identity',decisions:[{id:'verification-repair',action:'adapt',reason:'Clear the competing widget and retain one identity status'}],checks:[]}});
    result=await call({action:'verify'});assert.equal(result.status,'READY_TO_INSTALL',JSON.stringify(result));
  }finally{if(old===undefined)delete process.env.WARDROBE_PI_CLI;else process.env.WARDROBE_PI_CLI=old;}
});

test('workflow evidence remains addressable across a soft checkpoint request',async()=>{
  const h=harness(),root=join(h.sandbox.work,'evidence-context'),source=join(root,'source');
  mkdirSync(source,{recursive:true});mkdirSync(join(root,'base'));
  const handlers=new Map(),pi={on:(name,fn)=>handlers.set(name,fn)};
  const {workflowContextFor}=await import('../packages/wardrobe/src/workflow-context.mjs');
  const scope=workflowContextFor(pi,new NativeStore(h.sandbox.seedAgent('evidence-context')));
  scope.accept({status:'REVIEW_REQUIRED',handle:'durable-evidence',workspace:{root,source},batch:{id:'capability'},request:'Preserve the documented API.'});
  const user={role:'user',content:'Use the documented upstream API.',timestamp:1};
  const evidence={role:'toolResult',toolName:'read',toolCallId:'doc-call',content:[{type:'text',text:'UPSTREAM_API_FACT: initialize with pi.events.on'}]};
  handlers.get('context_with_system')({messages:[user]});
  const later=Array.from({length:12},(_,i)=>({role:'assistant',timestamp:10+i,content:[{type:'text',text:'Later independent investigation '+i}]}));
  const result=handlers.get('context_with_system')({messages:[user,{role:'assistant',timestamp:2,content:[{type:'toolCall',id:'doc-call',name:'read',arguments:{path:'docs/api.md'}}]},evidence,...later]});
  assert.match(JSON.stringify(result),/UPSTREAM_API_FACT/);
  assert.ok(existsSync(join(root,'memory','observations.jsonl')),'workflow keeps private durable observation records');
    const state=JSON.parse(result.messages.findLast(m=>m.role==='user'&&JSON.stringify(m.content).includes('Wardrobe state delta:')).content[0].text.split('\n').slice(1).join('\n'));
    assert.equal(state.observationIds,undefined,'private archive keys do not become model parameters');
    const id=JSON.parse(readFileSync(join(root,'memory','observations.jsonl'),'utf8').trim()).id,archived=await import('../packages/wardrobe/src/workflow-observations.mjs');
    const fresh=archived.readObservations(root,[id])[0];assert.equal(fresh.fresh,false,'an unparsed shell/read reference is not treated as verified freshness');
    const observationPath=join(root,'memory','observations',id+'.json');writeFileSync(observationPath,JSON.stringify({id,content:'tampered',contentHash:'bad'}));
    assert.equal(archived.readObservations(root,[id])[0].fresh,false,'observation integrity detects edits');
});
