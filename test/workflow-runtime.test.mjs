import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { useHarness } from './support/harness.mjs';
import { NativeStore, writeJson } from '../packages/wardrobe/src/native-store.mjs';
import { registerWorkflowTool } from '../packages/wardrobe/src/workflow-tool.mjs';
import { loadWorkflowRecord } from '../packages/wardrobe/src/workflow-journal.mjs';
const harness=useHarness('runtime-items');
function fixture(t,name,broken=false){
 const h=harness(),source=join(h.sandbox.work,name);mkdirSync(join(source,'extensions'),{recursive:true});
 writeJson(join(source,'package.json'),{name,version:'1.0.0',type:'module',pi:{extensions:['extensions/main.mjs']}});
 writeJson(join(source,'preset.json'),{schemaVersion:1,id:'runtime/'+name,name,version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[{package:'self',kind:'extensions',include:['extensions/main.mjs']}]});
 writeJson(join(source,'manifest.json'),{piVersion:'1.0.4'});
 writeFileSync(join(source,'extensions/main.mjs'),broken?"export default ()=>{throw Error('SPECIFIC_STARTUP_FAILURE')};":"export default pi=>{};");
 const old=process.env.WARDROBE_PI_CLI;process.env.WARDROBE_PI_CLI=h.runtime.cliPath;t.after(()=>{if(old===undefined)delete process.env.WARDROBE_PI_CLI;else process.env.WARDROBE_PI_CLI=old;});
 const store=new NativeStore(h.sandbox.seedAgent(name));let tool;
 registerWorkflowTool({registerTool:value=>tool=value,appendEntry(){}},store);
 const call=(input,signal)=>tool.execute(name,input,signal,undefined,{cwd:h.sandbox.project});
 return {source,store,call};
}
test('native loading completes while the whole runtime review and explicit request remain independently available',async t=>{
 const {source,store,call}=fixture(t,'runtime-ready');
 const response=await call({action:'update',source,request:'Add REQUEST_SENTINEL instruction'}),step=response.details;
 assert.equal(step.status,'REVIEW_REQUIRED',JSON.stringify(step));
 const record=loadWorkflowRecord(step.workspace.root);
 assert.equal(record.accepted[0]?.automatic,'runtime-load');assert.equal(record.accepted[0].checks[0].code,0);
 assert.deepEqual(step.requiredDecisions,['runtime-review','request']);
 assert.match(response.content[0].text,/REQUEST_SENTINEL/);
 assert.ok(step.material.notes.every(note=>note.path&&!note.text));
 assert.equal((await call({action:'install',approved:true})).isError,true);
 assert.equal((await call({action:'save',submission:{summary:'Skip request',decisions:[{id:'request',action:'defer',reason:'Not now'}],checks:[]}})).isError,true);
 writeFileSync(join(step.workspace.source,'instruction.md'),'REQUEST_SENTINEL\n');
 const saved=(await call({action:'save',submission:{summary:'Add requested instruction first',decisions:[{id:'request',action:'adapt',reason:'Instruction implemented'}],checks:[],work:[{id:'instruction',origins:['request'],goal:'Deliver requested instruction',paths:['instruction.md'],ready:true,checks:[{command:'node',args:['-e',"require('node:assert/strict').match(require('node:fs').readFileSync('instruction.md','utf8'),/REQUEST_SENTINEL/)"],reason:'The requested instruction is present'}]}]}})).details;
 assert.equal(saved.status,'REVIEW_REQUIRED');
 const final=(await call({action:'verify',submission:{summary:'Preserve runtime behavior',decisions:[{id:'runtime-review',action:'defer',reason:'No optional runtime behavior is needed'}],checks:[]}})).details;
 assert.equal(final.status,'READY_TO_INSTALL',JSON.stringify(final));
 assert.equal((await call({action:'install',approved:true})).details.status,'INSTALLED');assert.equal(store.read().default,null);
});

test('an explicit update request remains required even with no incoming changes',async t=>{
 const {source,call}=fixture(t,'runtime-current');writeJson(join(source,'manifest.json'),{piVersion:harness().runtime.version});
 const step=(await call({action:'update',source,request:'Add an instruction'})).details;
 assert.equal(step.status,'REVIEW_REQUIRED');assert.ok(step.items.some(item=>item.id==='requested'));assert.deepEqual(step.requiredDecisions,['request']);
 assert.equal((await call({action:'install',approved:true})).isError,true);
});

test('cancelled automatic loading preserves an unaccepted candidate for explicit resume',async t=>{
 const {source,call}=fixture(t,'runtime-cancelled');const controller=new AbortController();controller.abort();
 const step=(await call({action:'update',source},controller.signal)).details;
 assert.equal(step.status,'INTERRUPTED');assert.equal(step.nextCall.action,'resume');
 assert.equal(loadWorkflowRecord(step.workspace.root).accepted.length,0);
 assert.equal((await call({action:'probe'})).isError,true,'a paused workflow requires resume');
 const resumed=(await call({action:'resume'})).details;assert.equal(resumed.batch.id,'runtime');
 assert.equal((await call({action:'probe'})).details.batch.id,'review');
});
test('a failed automatic load leaves independent work available but final verification still requires successful loading',async t=>{
 const {source,call}=fixture(t,'runtime-broken',true);
 let step=(await call({action:'update',source})).details;
 assert.equal(step.batch.id,'review');assert.match(JSON.stringify(step.baselineDiagnostics),/SPECIFIC_STARTUP_FAILURE/);
 assert.deepEqual(step.requiredDecisions,['runtime-review']);assert.equal(step.nextCall.action,'save');
 assert.equal(loadWorkflowRecord(step.workspace.root).accepted.length,0);
 step=(await call({action:'save',submission:{summary:'Claim compatibility',decisions:[{id:'runtime-review',action:'defer',reason:'No new optional behavior'}],checks:[]}})).details;
 assert.equal(step.nextCall.action,'verify');step=(await call({action:'verify',submission:{summary:'Verify saved compatibility review',decisions:[],checks:[]}})).details;
 assert.equal(step.status,'CHECK_FAILED');assert.equal((await call({action:'install',approved:true})).isError,true);
 const current=(await call({action:'details'})).details;
 writeFileSync(join(current.workspace.source,'extensions/main.mjs'),'export default pi=>{};');
 assert.equal((await call({action:'probe'})).details.baselineDiagnostics.status,'READY');
 assert.equal((await call({action:'install',approved:true})).isError,true,'loading alone never authorizes installation');
 await call({action:'save',submission:{summary:'Repair the native loading failure',decisions:[{id:'verification-repair',action:'adapt',reason:'Removed the concrete startup failure and probed successfully'}],checks:[]}});
 assert.equal((await call({action:'verify'})).details.status,'READY_TO_INSTALL');
});
