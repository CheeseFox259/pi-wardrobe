import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {useHarness} from './support/harness.mjs';
import {NativeStore,writeJson} from '../packages/wardrobe/src/native-store.mjs';
import {registerWorkflowTool} from '../packages/wardrobe/src/workflow-tool.mjs';

const harness=useHarness('implementation');
async function setup(t){
 const h=harness(),source=join(h.sandbox.work,t.name.replace(/\W/g,'').slice(0,35));mkdirSync(source);
 writeJson(join(source,'package.json'),{name:'implementation',version:'1.0.0',type:'module',pi:{}});
 writeJson(join(source,'preset.json'),{schemaVersion:1,id:'implementation/demo',name:'Demo',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[]});
 const old=process.env.WARDROBE_PI_CLI;process.env.WARDROBE_PI_CLI=h.runtime.cliPath;
 t.after(()=>{if(old===undefined)delete process.env.WARDROBE_PI_CLI;else process.env.WARDROBE_PI_CLI=old;});
 const store=new NativeStore(h.sandbox.seedAgent('implementation'));let tool;const handlers=new Map();
 registerWorkflowTool({registerTool:value=>tool=value,appendEntry(){},on:(name,fn)=>handlers.set(name,fn)},store);
 const call=async input=>(await tool.execute('implementation',input,undefined,undefined,{cwd:h.sandbox.project})).details;
 return {store,source,call,handlers,step:await call({action:'maintain',source,request:'Add model inheritance and a distinct status indicator'})};
}
const change=(id,extra={})=>({id,origins:['maintain'],goal:'Deliver '+id,paths:[id+'.txt'],checks:[{command:'node',args:['-e',`require('node:assert/strict').equal(require('node:fs').readFileSync('${id}.txt','utf8'),'done')`],reason:'Confirm '+id+' behavior'}],...extra});

test('compound maintenance preserves unfinished implementation through focus, verify and install',async t=>{
 const {call,step,store}=await setup(t);
 const plan=await call({action:'save',submission:{summary:'Two bounded changes',work:[change('models'),change('status',{dependsOn:['models']})]}});
 assert.equal(plan.items.filter(i=>i.kind==='implementation').length,2,JSON.stringify(plan));
 assert.equal((await call({action:'verify'})).code,'WORKFLOW_INCOMPLETE');
 assert.equal((await call({action:'install',approved:true})).status,'ERROR');
 const blocked=await call({action:'focus',item:'implementation:status'});
 assert.deepEqual(blocked.focus.dependencies,['models']);
 writeFileSync(join(step.workspace.source,'models.txt'),'done');
 await call({action:'save',submission:{work:[change('models',{ready:true})]}});
 assert.equal((await call({action:'details'})).items.find(i=>i.id==='implementation:models').status,'ready');
 writeFileSync(join(step.workspace.source,'status.txt'),'done');
 const saved=await call({action:'save',submission:{work:[change('status',{dependsOn:['models'],ready:true})]}});
 assert.equal(saved.items.find(i=>i.id==='implementation:models').status,'ready','independent edits retain a path-scoped claim');
 const verified=await call({action:'verify'});assert.equal(verified.status,'READY_TO_INSTALL',JSON.stringify(verified));
 const installed=await call({action:'install',approved:true});assert.equal(installed.status,'INSTALLED',JSON.stringify(installed));assert.equal(installed.active,false);assert.equal(store.read().default,null);
});

test('invalid plans are atomic and a saved claim expires when its affected implementation changes',async t=>{
 const {call,step}=await setup(t);
 await call({action:'save',submission:{summary:'Bounded work',work:[change('models')]}});
 for(const work of [[change('bad',{origins:['unknown']})],[change('bad',{paths:['../outside']})],[change('a',{dependsOn:['b']}),change('b',{dependsOn:['a']})]]){
  const rejected=await call({action:'save',submission:{summary:'Invalid plan',work}});
  assert.equal(rejected.code,'WORKFLOW_IMPLEMENTATION_INVALID',JSON.stringify(rejected));
  assert.deepEqual((await call({action:'details'})).saved.work.map(w=>w.id),['models']);
 }
 writeFileSync(join(step.workspace.source,'models.txt'),'done');
 await call({action:'save',submission:{work:[{id:'models',ready:true}]}});
 writeFileSync(join(step.workspace.source,'models.txt'),'regression');
 const stale=await call({action:'verify'});assert.equal(stale.code,'WORKFLOW_INCOMPLETE');assert.equal(stale.incomplete.implementation[0].status,'stale');
 await call({action:'save',replace:true,submission:{summary:'Replace review narrative',checks:[]}});
 assert.equal((await call({action:'details'})).saved.work.length,1,'replacing review cannot erase required implementation');
});

test('partial behavior checks use staged dependencies and never grant installation eligibility',async t=>{
 const {call,step}=await setup(t);
 await call({action:'save',submission:{summary:'Implement models',work:[change('models')]}});
 await call({action:'focus',item:'implementation:models'});
 const failed=await call({action:'check'});assert.equal(failed.partialCheck.passed,false,JSON.stringify(failed));
 assert.notEqual(failed.status,'READY_TO_INSTALL');assert.equal((await call({action:'install',approved:true})).status,'ERROR');
 writeFileSync(join(step.workspace.source,'models.txt'),'done');
 const passed=await call({action:'check'});assert.equal(passed.partialCheck.passed,true,JSON.stringify(passed));
 assert.notEqual(passed.status,'READY_TO_INSTALL');
 assert.equal((await call({action:'check'})).partialCheck.checks[0].reused,true);
 await call({action:'save',submission:{work:[{id:'models',ready:true}]}});
 const verified=await call({action:'verify'});assert.equal(verified.status,'READY_TO_INSTALL',JSON.stringify(verified));
 assert.ok(verified.checks.some(c=>c.args?.includes('-e')&&c.reused),'matching final verification reuses the exact partial behavior evidence');
});

test('narrative saves do not renew delivery and recovery names the actual outstanding change',async t=>{
 const {call,handlers}=await setup(t);
 await call({action:'save',submission:{summary:'Plan',work:[change('models')]}});
 await call({action:'focus',item:'implementation:models'});
 const turn=()=>handlers.get('turn_end')({outcome:'completed',message:{role:'assistant',stopReason:'toolUse',content:[]},toolResults:[]});
 await turn();
 for(let i=0;i<9;i++){
  await call({action:'save',submission:{summary:'Still investigating '+i,work:[{id:'models',missingFact:{question:'Which API '+i,why:'Needed for model inheritance',nextStep:'Read the installed public API'}}]}});
  await turn();
 }
 const state=await call({action:'details'});assert.ok(state.progress.sinceDeliveryProgress>=8,JSON.stringify(state.progress));
 assert.match(state.progress.recoveryMessage,/models|inheritance/);
 assert.match(state.focus.missingFact.question,/Which API/);
});

test('model-visible focus and a fresh tool instance recover actionable implementation context',async t=>{
 const {call,step,store}=await setup(t);
 await call({action:'save',submission:{summary:'Plan',work:[change('models',{missingFact:{question:'Which selected model is inherited?',why:'Determine native inheritance',nextStep:'Read the public Pi session API'}})]}});
 writeFileSync(join(step.workspace.source,'models.txt'),'done');
 let tool;registerWorkflowTool({registerTool:value=>tool=value,appendEntry(){}},store);
 const response=await tool.execute('restored',{action:'focus',workflow:step.workspace.root,item:'implementation:models'},undefined,undefined,{cwd:step.workspace.source});
 const view=JSON.parse(response.content[0].text);
 assert.equal(view.focus.title,'Deliver models');assert.deepEqual(view.focus.files,['models.txt']);
 assert.equal(view.material.implementation.missingFact.question,'Which selected model is inherited?');
 assert.deepEqual(view.material.implementation.changes,[{path:'models.txt',status:'added'}]);
 assert.equal(view.items.find(i=>i.id==='implementation:models').kind,'implementation');
 assert.ok(view.context.wardrobe.docs,'public integration API remains available to implementation');
 assert.deepEqual(view.nextCall.submission.work,[{id:'models',ready:true}]);
});

test('an explicit update decision alone cannot discharge the requested implementation',async t=>{
 const {call,source}=await setup(t);
 writeJson(join(source,'manifest.json'),{piVersion:harness().runtime.version});
 const step=await call({action:'update',source,request:'Add models inheritance'});
 await call({action:'save',submission:{summary:'Choose native inheritance',decisions:[{id:'request',action:'adapt',reason:'Implement native inheritance'}]}});
 const pending=await call({action:'verify'});
 assert.equal(pending.code,'WORKFLOW_INCOMPLETE',JSON.stringify(pending));
 assert.deepEqual(pending.incomplete.missingImplementation,['request']);
 const next=await call({action:'focus',item:'requested'});
 assert.equal(next.nextCall.submission.work[0].origins[0],'request');
 writeFileSync(join(step.workspace.source,'models.txt'),'done');
 await call({action:'save',submission:{work:[change('models',{origins:['request'],ready:true})]}});
 assert.equal((await call({action:'verify'})).status,'READY_TO_INSTALL');
});

test('dependency edits invalidate downstream claims and partial evidence follows candidate inputs',async t=>{
 const {call,step}=await setup(t);
 writeFileSync(join(step.workspace.source,'models.txt'),'done');writeFileSync(join(step.workspace.source,'status.txt'),'done');
 await call({action:'save',submission:{summary:'Both implemented',work:[change('models',{ready:true}),change('status',{dependsOn:['models'],ready:true})]}});
 await call({action:'focus',item:'implementation:status'});
 assert.equal((await call({action:'check'})).partialCheck.passed,true);
 writeFileSync(join(step.workspace.source,'models.txt'),'new');
 const state=await call({action:'details'});
 assert.equal(state.items.find(i=>i.id==='implementation:status').status,'stale');
 const rechecked=await call({action:'check'});assert.equal(rechecked.partialCheck.passed,true);
 assert.notEqual(rechecked.partialCheck.checks[0].reused,true,'candidate changes require actual check execution');
});

test('implementation delivery preserves explicit user blockers until they are resolved',async t=>{
 const {call,step}=await setup(t);
 await call({action:'save',submission:{summary:'Plan',work:[change('models')],blockers:[{item:'maintain',reason:'User choice required',nextStep:'Wait for the selected behavior',needsUser:true}]}});
 writeFileSync(join(step.workspace.source,'models.txt'),'done');
 await call({action:'save',submission:{work:[{id:'models',ready:true}]}});
 const rejected=await call({action:'verify'});assert.equal(rejected.code,'WORKFLOW_INCOMPLETE');assert.deepEqual(rejected.incomplete.blockedItems,['maintain']);
 await call({action:'save',submission:{resolvedBlockers:['maintain']}});
 assert.equal((await call({action:'verify'})).status,'READY_TO_INSTALL');
});

test('partial-check pollution discards the staged artifact and reusable evidence',async t=>{
 const {call,step}=await setup(t);
 writeFileSync(join(step.workspace.source,'models.txt'),'done');
 const checks=[{command:'node',args:['-e',"require('node:fs').writeFileSync('models.txt','pollution')"],reason:'Detect a mutating check'}];
 await call({action:'save',submission:{summary:'Plan',work:[change('models',{checks,ready:true})]}});
 const failed=await call({action:'check',item:'implementation:models'});assert.equal(failed.code,'WORKFLOW_PARTIAL_CHECK_FAILED',JSON.stringify(failed));
 assert.equal(readFileSync(join(step.workspace.source,'models.txt'),'utf8'),'done','staged mutation did not rewrite the candidate');
 assert.equal((await call({action:'details'})).items.find(i=>i.id==='implementation:models').status,'pending');
 await call({action:'save',submission:{work:[change('models')]}});
 const repaired=await call({action:'check',item:'implementation:models'});assert.equal(repaired.partialCheck.passed,true,JSON.stringify(repaired));assert.notEqual(repaired.partialCheck.checks[0].reused,true);
});

test('cancelled partial checks and quota recovery preserve work and named missing facts',async t=>{
 const {call,step,store,handlers}=await setup(t);
 writeFileSync(join(step.workspace.source,'models.txt'),'done');
 await call({action:'save',submission:{summary:'Plan',work:[change('models',{ready:true,missingFact:{question:'Which API?',why:'Select the native API',nextStep:'Read the public API'}})]}});
 let tool;registerWorkflowTool({registerTool:value=>tool=value,appendEntry(){}},store);
 const controller=new AbortController();controller.abort();
 const stopped=(await tool.execute('cancel',{action:'check',workflow:step.workspace.root,item:'implementation:models'},controller.signal,undefined,{cwd:step.workspace.source})).details;
 assert.equal(stopped.status,'INTERRUPTED',JSON.stringify(stopped));assert.equal(stopped.partialCheck.cancelled,true);
 let resumed=await call({action:'resume'});assert.equal(resumed.saved.work[0].missingFact.question,'Which API?');assert.equal(resumed.saved.work[0].claim,undefined);
 await handlers.get('turn_end')({outcome:'error',message:{role:'assistant',stopReason:'error',errorMessage:'429 quota usage limit',content:[]},toolResults:[]});
 const quota=await call({action:'details'});assert.equal(quota.status,'SUSPENDED_QUOTA');
 resumed=await call({action:'resume'});assert.equal(resumed.saved.work[0].goal,'Deliver models');assert.equal(resumed.saved.work[0].missingFact.nextStep,'Read the public API');
});

test('recovery hands off to independent implementations and focus switching cannot renew their budgets',async t=>{
 const {call,handlers}=await setup(t);
 await call({action:'save',submission:{summary:'Three bounded changes',work:[change('models'),change('status',{dependsOn:['models']}),change('export')]}});
 const turn=()=>handlers.get('turn_end')({outcome:'completed',message:{role:'assistant',stopReason:'toolUse',content:[]},toolResults:[]});
 await call({action:'focus',item:'implementation:models'});await turn();
 for(let i=0;i<17;i++){await call({action:'focus',item:'implementation:models'});await turn();}
 let state=await call({action:'details'});
 assert.equal(state.focus.id,'implementation:export','dependent status and its unfinished parent are not independent work');
 assert.equal(state.items.find(i=>i.id==='implementation:models').blocker.origin,'delivery');
 for(let i=0;i<22;i++){
  await call({action:'focus',item:'implementation:status'});await call({action:'focus',item:'implementation:export'});await turn();
  state=await call({action:'details'});if(state.status==='STALLED')break;
 }
 assert.equal(state.status,'STALLED','switching through the dependent cannot mint continuation allowances');
});

test('replacing a failed implementation check does not run the obsolete check at final verification',async t=>{
 const {call,step}=await setup(t);
 writeFileSync(join(step.workspace.source,'models.txt'),'done');
 await call({action:'save',submission:{summary:'Check plan',work:[change('models',{checks:[{command:'node',args:['-e','process.exit(1)'],reason:'Obsolete check'}]})]}});
 assert.equal((await call({action:'check',item:'implementation:models'})).partialCheck.passed,false);
 await call({action:'save',submission:{work:[change('models',{ready:true})]}});
 assert.equal((await call({action:'verify'})).status,'READY_TO_INSTALL');
});

test('a saved capability report pauses update until the human confirms the proposed scope',async t=>{
 const {source,store}=await setup(t);
 writeJson(join(source,'manifest.json'),{piVersion:harness().runtime.version});
 let tool,confirm=false,prompts=[];const handlers=new Map();
 registerWorkflowTool({registerTool:value=>tool=value,appendEntry(){},on:(name,fn)=>handlers.set(name,fn)},store);
 const ctx={cwd:harness().sandbox.project,ui:{confirm:async(title,body)=>{prompts.push({title,body});return confirm;}}};
 const call=async input=>(await tool.execute('review',input,undefined,undefined,ctx)).details;
 const started=await call({action:'update',source,review:'human',request:'Add export'});
 assert.equal(started.nextCall.action,'propose');
 assert.equal(started.material.preservation,undefined);
 const turn=()=>handlers.get('turn_end')({outcome:'completed',message:{role:'assistant',stopReason:'toolUse',content:[]},toolResults:[]});
 for(let i=0;i<9;i++)await turn();
 assert.ok((await call({action:'details'})).progress.sinceDeliveryProgress>=8);
 assert.equal((await call({action:'verify'})).code,'WORKFLOW_PLAN_APPROVAL_REQUIRED');
 const proposal={summary:'Add a local export without changing defaults.',changes:[{component:'Export',effect:'Users can export their notes.',recommendation:'adapt',reason:'The preset stores notes locally.'}],validation:'Export a note and compare the saved contents.'};
 const paused=await call({action:'propose',proposal,approved:true});
 assert.equal(paused.status,'WAITING_INPUT');
 assert.match(prompts[0].body,/Users can export their notes/);
 assert.equal((await call({action:'install',approved:true})).status,'ERROR');
 assert.equal((await call({action:'resume'})).status,'WAITING_INPUT');
 const reopened=await call({action:'resume',revise:true});
 assert.match(reopened.planReview.previousReport,/Users can export their notes/);
 assert.equal((await call({action:'save',submission:{summary:'Trying to skip the new proposal'}})).code,'WORKFLOW_PLAN_APPROVAL_REQUIRED');
 await call({action:'propose',proposal:{...proposal,summary:'Revised: add export without changing defaults.'}});
 confirm=true;
 const approved=await call({action:'resume'});
 assert.equal(approved.status,'PLAN_APPROVED');
 assert.equal(approved.planReview.phase,'approved');
 assert.match(approved.planReview.report,/compare the saved contents/);
 assert.match(approved.planReview.report,/^Revised/);
 assert.equal(prompts.length,4);
 assert.equal((await call({action:'save',submission:{summary:'Implementation has not resumed'}})).status,'ERROR');
 writeFileSync(join(approved.workspace.source,'unexpected.txt'),'changed after approval');
 assert.equal((await call({action:'resume'})).code,'WORKFLOW_PROPOSAL_STALE');
 const revisedApproval=await call({action:'resume',revise:true});
 assert.equal(revisedApproval.planReview.phase,'draft');
 assert.match(revisedApproval.planReview.previousReport,/^Revised/);
 assert.equal((await call({action:'verify'})).code,'WORKFLOW_PLAN_APPROVAL_REQUIRED');
 for(let i=0;i<9;i++)await turn();
 assert.ok((await call({action:'details'})).progress.sinceDeliveryProgress>=8);
 const short={changes:[{component:'Notes',effect:'Export Markdown with its date and title. Preserve daily notes.',recommendation:'adapt'}],validation:'Check the export template and existing daily notes.'};
 assert.equal((await call({action:'propose',proposal:short})).status,'PLAN_APPROVED');
 assert.equal(prompts.at(-1).body.split('\n').filter(Boolean).length,2);
 const implementing=await call({action:'resume'});
 assert.equal(implementing.status,'REVIEW_REQUIRED');
 assert.equal(implementing.context.localPackageAlias,'self');
 assert.equal(implementing.nextCall.submission.decisions[0].action,'adapt');
 await turn();
 assert.equal((await call({action:'details'})).progress.sinceDeliveryProgress,1,'proposal investigation does not consume implementation turns');
 assert.equal(prompts.length,5,'starting implementation uses the recorded confirmation');
});
