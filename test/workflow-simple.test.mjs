import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { useHarness } from './support/harness.mjs';
import { NativeStore, writeJson } from '../packages/wardrobe/src/native-store.mjs';
import { registerWorkflowTool } from '../packages/wardrobe/src/workflow-tool.mjs';
import { captureObservations } from '../packages/wardrobe/src/workflow-observations.mjs';
const harness=useHarness('workflow-simple');

test('the native session owns workflow coordinates through repair, verification and inactive installation',async()=>{
  const h=harness(),source=join(h.sandbox.work,'simple');mkdirSync(source);
  writeJson(join(source,'package.json'),{name:'simple',version:'1.0.0',type:'module',pi:{}});
  writeJson(join(source,'preset.json'),{schemaVersion:1,id:'simple/demo',name:'Simple',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[]});
  const old=process.env.WARDROBE_PI_CLI;process.env.WARDROBE_PI_CLI=h.runtime.cliPath;
  try{
    const store=new NativeStore(h.sandbox.seedAgent('simple')),handlers=new Map(),entries=[];let tool;
    registerWorkflowTool({on:(n,f)=>handlers.set(n,f),registerTool:t=>tool=t,appendEntry:(customType,data)=>entries.push({type:'custom',customType,data})},store);
    const call=input=>tool.execute('simple',input,undefined,undefined,{cwd:h.sandbox.project});
    const start=await call({action:'maintain',source,request:'Add a local instruction'});
    for(const field of ['handle','workflow','revision','batch','findings','observationIds','nextAction'])assert.equal(tool.parameters.properties[field],undefined,field+' is program state');
    assert.doesNotMatch(start.content[0].text,/w3\.|nextAction|observationIds/);
    const candidate=start.details.workspace.source;
    for(let i=0;i<8;i++)await handlers.get('turn_end')({outcome:'completed',message:{role:'assistant',content:[]},toolResults:[]});
    assert.equal(await handlers.get('tool_call')({toolName:'read',input:{path:join(candidate,'preset.json')}},{cwd:h.sandbox.project}),undefined,'recovery does not require another permission protocol');
    writeFileSync(join(candidate,'instruction.md'),'Keep native model settings.\n');
    let restoredTool;const restoredHandlers=new Map();
    registerWorkflowTool({on:(name,handler)=>restoredHandlers.set(name,handler),registerTool:t=>restoredTool=t,appendEntry(){}},store);
    const isolated=await restoredTool.execute('isolated',{action:'install',approved:true},undefined,undefined,{cwd:h.sandbox.project});
    assert.equal(isolated.details.code,'WORKFLOW_INPUT_REQUIRED','unrelated sessions cannot select a candidate');
    const rejected=await restoredTool.execute('failed-after-restore',{action:'verify',submission:{summary:''}},undefined,undefined,{cwd:h.sandbox.project,sessionManager:{getBranch:()=>entries}});
    assert.equal(rejected.isError,true);
    await restoredHandlers.get('turn_end')({outcome:'completed',message:{role:'assistant',content:[]},toolResults:[]});
    const {loadWorkflowRecord}=await import('../packages/wardrobe/src/workflow-journal.mjs');
    assert.equal(loadWorkflowRecord(start.details.workspace.root).progress.assistantTurns,9,'restored failed calls remain in bounded recovery');
    restoredHandlers.get('agent_settled')();
    const rejectedAgain=await restoredTool.execute('failed-after-settlement',{action:'verify',submission:{summary:''}},undefined,undefined,{cwd:h.sandbox.project,sessionManager:{getBranch:()=>entries}});
    assert.equal(rejectedAgain.isError,true);
    await restoredHandlers.get('turn_end')({outcome:'completed',message:{role:'assistant',content:[]},toolResults:[]});
    assert.equal(loadWorkflowRecord(start.details.workspace.root).progress.assistantTurns,10,'same-instance settlement also restores recovery');
    const verified=await restoredTool.execute('verify',{action:'verify',submission:{summary:'Add instruction',decisions:[],checks:[]}},undefined,undefined,{cwd:h.sandbox.project,sessionManager:{getBranch:()=>entries}});
    assert.equal(verified.details.status,'READY_TO_INSTALL',JSON.stringify(verified.details));
    const candidateBranch=entries.slice();
    const failedStart=await call({action:'maintain',source:join(h.sandbox.work,'missing-source'),request:'A different preset'});
    assert.equal(failedStart.isError,true);
    const wrongInstall=await tool.execute('wrong-target',{action:'install',approved:true},undefined,undefined,{cwd:h.sandbox.project,sessionManager:{getBranch:()=>entries}});
    assert.equal(wrongInstall.details.code,'WORKFLOW_INPUT_REQUIRED','a failed new task cannot install an older candidate');
    const installed=await restoredTool.execute('restored',{action:'install',approved:true},undefined,undefined,{cwd:h.sandbox.project,sessionManager:{getBranch:()=>candidateBranch}});
    assert.equal(installed.details.status,'INSTALLED',JSON.stringify(installed.details));
    assert.equal(store.read().default,null);
  }finally{if(old===undefined)delete process.env.WARDROBE_PI_CLI;else process.env.WARDROBE_PI_CLI=old;}
});

test('repeated error calls and administrative results never count as evidence; identical reads count once',()=>{
  const h=harness(),root=join(h.sandbox.work,'memory'),path=join(h.sandbox.work,'evidence.txt');writeFileSync(path,'evidence');
  const messages=(id,tool,content,isError=false)=>[{role:'assistant',content:[{type:'toolCall',id,name:tool,arguments:{path}}]},{role:'toolResult',toolName:tool,toolCallId:id,isError,content:[{type:'text',text:content}]}];
  assert.deepEqual(captureObservations(root,messages('bad1','wardrobe_workflow','handle invalid',true)),[]);
  assert.deepEqual(captureObservations(root,messages('bad2','wardrobe_workflow','checkpoint saved')),[]);
  assert.equal(captureObservations(root,messages('read1','read','evidence')).length,1);
  assert.deepEqual(captureObservations(root,messages('read2','read','evidence')),[]);
});

test('probe observes edited candidate code instead of reusing an obsolete staged package',async()=>{
  const h=harness(),source=join(h.sandbox.work,'probe-current');mkdirSync(join(source,'extensions'),{recursive:true});
  writeJson(join(source,'package.json'),{name:'probe-current',version:'1.0.0',type:'module',pi:{extensions:['extensions/main.mjs']}});
  writeJson(join(source,'preset.json'),{schemaVersion:1,id:'probe/current',name:'Probe',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[{package:'self',kind:'extensions',include:['extensions/main.mjs']}]});
  writeFileSync(join(source,'extensions/main.mjs'),'export default pi=>{};');
  const old=process.env.WARDROBE_PI_CLI;process.env.WARDROBE_PI_CLI=h.runtime.cliPath;
  try{
    let tool;registerWorkflowTool({registerTool:t=>tool=t,appendEntry(){}},new NativeStore(h.sandbox.seedAgent('probe-current')));
    const call=async input=>(await tool.execute('probe',input,undefined,undefined,{cwd:h.sandbox.project})).details;
    const ready=await call({action:'maintain',source,request:'Repair startup'});
    assert.equal(ready.baselineDiagnostics,undefined,'starting a task does not preinstall the candidate');
    assert.equal((await call({action:'probe'})).baselineDiagnostics.status,'READY');
    writeFileSync(join(ready.workspace.source,'extensions/main.mjs'),"export default pi=>pi.on('session_start',(_e,ctx)=>ctx.ui.notify('CURRENT_CANDIDATE_FAILURE','warning'));");
    const probed=await call({action:'probe'});
    assert.equal(probed.baselineDiagnostics.status,'BLOCKED_DEPENDENCY');
    assert.match(JSON.stringify(probed.baselineDiagnostics),/CURRENT_CANDIDATE_FAILURE/);
  }finally{if(old===undefined)delete process.env.WARDROBE_PI_CLI;else process.env.WARDROBE_PI_CLI=old;}
});
