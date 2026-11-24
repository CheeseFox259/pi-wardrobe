import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {useHarness} from './support/harness.mjs';
import {NativeStore,writeJson} from '../packages/wardrobe/src/native-store.mjs';
import {registerWorkflowTool} from '../packages/wardrobe/src/workflow-tool.mjs';
import {recordWorkflowTurn} from '../packages/wardrobe/src/native-workflow.mjs';
const harness=useHarness('autonomous');
function setup(t){
 const h=harness(),source=join(h.sandbox.work,t.name.slice(0,20));mkdirSync(source);
 writeJson(join(source,'package.json'),{name:'autonomous',version:'1.0.0',type:'module',pi:{}});
 writeJson(join(source,'preset.json'),{schemaVersion:1,id:'autonomous/local',name:'Local',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[]});
 writeJson(join(source,'manifest.json'),{piVersion:'1.0.4'});
 const old=process.env.WARDROBE_PI_CLI;process.env.WARDROBE_PI_CLI=h.runtime.cliPath;t.after(()=>{if(old===undefined)delete process.env.WARDROBE_PI_CLI;else process.env.WARDROBE_PI_CLI=old});
 const store=new NativeStore(h.sandbox.seedAgent('autonomous'));let tool;registerWorkflowTool({registerTool:x=>tool=x,appendEntry(){}},store);
 return {h,source,store,call:async input=>(await tool.execute('test',input,undefined,undefined,{cwd:h.sandbox.project})).details};
}
async function setupUpdate(t,{localAlpha='old alpha'}={}){
 const fixture=setup(t),{h,source,call}=fixture,skill=(name,text)=>`---\nname: ${name}\ndescription: ${name} method\n---\n${text}\n`;
 const upstream=await h.gitRepo('focused-upstream-'+t.name.replace(/[^a-z0-9]+/gi,'-'),[{message:'base',files:{'skills/alpha/SKILL.md':skill('alpha','old alpha'),'skills/beta/SKILL.md':skill('beta','old beta')}},{message:'target',files:{'skills/alpha/SKILL.md':skill('alpha','new alpha'),'skills/beta/SKILL.md':skill('beta','new beta')}}]);
 const base=upstream.commits[0],repo=upstream.sourceAt(base).slice(4).replace(/@[a-f0-9]{40}$/,'');
 for(const name of ['alpha','beta']){mkdirSync(join(source,'skills',name),{recursive:true});writeFileSync(join(source,'skills',name,'SKILL.md'),skill(name,name==='alpha'?localAlpha:'old '+name));}
 writeJson(join(source,'package.json'),{name:'autonomous',version:'1.0.0',type:'module',pi:{skills:['skills/alpha/SKILL.md','skills/beta/SKILL.md']}});
 writeJson(join(source,'preset.json'),{schemaVersion:1,id:'autonomous/local',name:'Local',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[{package:'self',kind:'skills',include:['skills/alpha/SKILL.md','skills/beta/SKILL.md']}]});
 writeJson(join(source,'manifest.json'),{piVersion:h.runtime.version});
 writeJson(join(source,'components.json'),{upstreams:{fixture:{repo,pinnedRef:base}},skills:{alpha:{type:'override',upstream:'fixture',baseRef:base,localPath:'skills/alpha/SKILL.md',upstreamRelPath:'skills/alpha/SKILL.md'},beta:{type:'override',upstream:'fixture',baseRef:base,localPath:'skills/beta/SKILL.md',upstreamRelPath:'skills/beta/SKILL.md'}}});
 return {...fixture,step:await call({action:'update',source})};
}
for(const action of ['update','maintain'])test(`${action} reports conflicting targets with an executable installed-profile retry`,async t=>{
 const {h,source,store,call}=setup(t);
 const imported=await call({action:'import',source,approved:true});
 assert.equal(imported.status,'IMPORTED',JSON.stringify(imported));
 const request='Preserve local instructions',profile=imported.profile.id;
 const conflict=await call({action,profile,source:h.sandbox.work,request});
 assert.equal(conflict.code,'WORKFLOW_TARGET_CONFLICT',JSON.stringify(conflict));
 assert.deepEqual(conflict.nextCall,{action,profile,request});
 assert.equal(conflict.workspace,undefined);
 assert.match(conflict.message,/profile.*source/);
 const retried=await call(conflict.nextCall);
 assert.equal(retried.status,'REVIEW_REQUIRED',JSON.stringify(retried));
 assert.equal(retried.profile.id,profile);
 assert.equal(store.read().default,null);
});
test('a model can focus either independent item and receives a partial-save next transition',async t=>{
 const {call,step}=await setupUpdate(t),second=step.items[1];
 assert.equal(step.items.length,2);assert.equal(step.nextCall.action,'save');
 const focused=await call({action:'focus',item:second.id});
 assert.equal(focused.status,'REVIEW_REQUIRED',JSON.stringify(focused));
 assert.equal(focused.focus.id,second.id);assert.deepEqual(focused.focus.requiredDecisions,second.required);
 assert.equal(focused.items.length,2);assert.deepEqual(focused.decisions.map(item=>item.path),second.files);
 assert.equal(focused.nextCall.action,'save');assert.deepEqual(focused.nextCall.submission,{decisions:second.required.map(id=>({id,action:'adopt',reason:''}))});assert.ok(focused.changes);
});
test('adopt cannot overwrite a candidate adaptation during save or verification',async t=>{
 const {call,step}=await setupUpdate(t),path=join(step.workspace.source,'skills/alpha/SKILL.md');
 const adapted=readFileSync(path,'utf8')+'Keep the local questionnaire and references layout.\n';
 writeFileSync(path,adapted);
 const decisions=step.requiredDecisions.map(id=>({id,action:'adopt',reason:'Upstream improvements integrated with local behavior'}));
 for(const action of ['save','verify']){
  const result=await call({action,submission:{summary:'Integrated upstream improvements',decisions,checks:[]}});
  assert.equal(result.code,'WORKFLOW_ADOPTION_CONFLICT',JSON.stringify(result));
  assert.match(result.message,/skill:alpha.*skills\/alpha\/SKILL.md.*adapt/);
  assert.equal(readFileSync(path,'utf8'),adapted,'the tool must retain model edits instead of copying upstream over them');
  assert.deepEqual((await call({action:'details'})).saved?.decisions||[],[],'a rejected decision cannot become durable');
 }
 decisions[0].action='adapt';
 const saved=await call({action:'save',submission:{summary:'Keep the completed adaptation',decisions,checks:[]}});
 assert.equal(saved.status,'REVIEW_REQUIRED',JSON.stringify(saved));
 assert.equal((await call({action:'verify'})).status,'READY_TO_INSTALL');
 assert.equal(readFileSync(path,'utf8'),adapted);
});
test('local-overlap templates suggest adaptation and saved adoption is rechecked after candidate edits',async t=>{
 const {call,step}=await setupUpdate(t,{localAlpha:'old alpha\nlocal questionnaire and references layout'});
 const focused=await call({action:'focus',item:'skill:alpha'});
 assert.equal(focused.nextCall.submission.decisions[0].action,'adapt');
 const decisions=step.requiredDecisions.map(id=>({id,action:'adopt',reason:'Choose upstream original'}));
 const saved=await call({action:'save',submission:{summary:'Use originals',decisions,checks:[]}});
 assert.equal(saved.status,'REVIEW_REQUIRED',JSON.stringify(saved),'unmodified local content can intentionally be replaced');
 const path=join(step.workspace.source,'skills/alpha/SKILL.md'),adapted=readFileSync(path,'utf8')+'\nnew incoming capability\n';writeFileSync(path,adapted);
 const rejected=await call({action:'verify'});
 assert.equal(rejected.code,'WORKFLOW_ADOPTION_CONFLICT',JSON.stringify(rejected));
 assert.equal(readFileSync(path,'utf8'),adapted,'a previously saved adopt cannot clobber a later repair');
});
test('saved decisions and blockers recover independently and unresolved required work cannot verify or install',async t=>{
 const {call,step}=await setupUpdate(t),[alpha,beta]=step.items;
 const blocked=await call({action:'save',submission:{summary:'Alpha needs a finite compatibility check',decisions:[],checks:[],blockers:[{item:alpha.id,reason:'Upstream compatibility is ambiguous',nextStep:'Inspect the affected native API'}]}});
 assert.equal(blocked.status,'REVIEW_REQUIRED',JSON.stringify(blocked));assert.equal(blocked.items.find(item=>item.id===alpha.id).status,'blocked');assert.equal(blocked.nextCall.action,'focus');
 await call({action:'focus',item:beta.id});
 const saved=await call({action:'save',submission:{summary:'Beta independently decided',decisions:[{id:beta.required[0],action:'adopt',reason:'Independent upstream text applies'}],checks:[]}});
 assert.equal(saved.items.find(item=>item.id===beta.id).status,'decided');assert.equal(saved.items.find(item=>item.id===alpha.id).status,'blocked');
 assert.equal(saved.nextCall.item,alpha.id,'remaining blocked work must have a real focus target');
 const recovered=await call({action:'details'});assert.equal(recovered.saved.decisions[0].id,beta.required[0]);assert.equal(recovered.items.find(item=>item.id===alpha.id).status,'blocked');
 const incomplete=await call({action:'verify'});assert.equal(incomplete.status,'ERROR');assert.equal(incomplete.code,'WORKFLOW_INCOMPLETE');assert.deepEqual(incomplete.incomplete.blockedItems,[alpha.id]);
 assert.equal((await call({action:'install',approved:true})).status,'ERROR');
 const continued=await call({action:'resume'});assert.equal(continued.items.find(item=>item.id===alpha.id).status,'blocked');assert.match(continued.items.find(item=>item.id===alpha.id).blocker.reason,/ambiguous/);
 await call({action:'focus',item:alpha.id});
 const resolved=await call({action:'save',submission:{summary:'Alpha compatibility resolved',decisions:[{id:alpha.required[0],action:'adapt',reason:'The affected API remains compatible'}],checks:[],resolvedBlockers:[alpha.id]}});
 assert.equal(resolved.nextCall.action,'verify',JSON.stringify(resolved));
 assert.equal((await call({action:'verify'})).status,'READY_TO_INSTALL');
});
test('a blocked-only review returns a usable focus call and retains the blocker until explicitly resolved',async t=>{
 const {call,step}=await setupUpdate(t),[alpha,beta]=step.items;
 const blocked=await call({action:'save',submission:{blockers:[
  {item:alpha.id,reason:'Need the requested compatibility choice',nextStep:'Ask which API behavior to preserve',needsUser:true},
  {item:beta.id,reason:'Need a concrete behavior check',nextStep:'Run the affected compatibility check'},
 ]}});
 assert.equal(blocked.nextCall.action,'focus');assert.equal(blocked.nextCall.item,alpha.id);
 const focused=await call(blocked.nextCall);
 assert.equal(focused.status,'REVIEW_REQUIRED');assert.equal(focused.focus.id,alpha.id);
 assert.equal(focused.items.find(item=>item.id===alpha.id).blocker.needsUser,true);
 assert.equal(focused.nextCall.submission.resolvedBlockers,undefined,'a save template cannot assume the user has answered an explicit blocker');
 assert.equal((await call({action:'verify'})).code,'WORKFLOW_INCOMPLETE');
 const resolved=await call({action:'save',submission:{decisions:[{id:alpha.required[0],action:'adapt',reason:'The user confirmed existing API behavior'}],resolvedBlockers:[alpha.id]}});
 assert.equal(resolved.nextCall.item,beta.id);
 assert.equal((await call(resolved.nextCall)).focus.id,beta.id);
});
for(const recovery of ['settlement','watchdog'])test(`${recovery} recovery preserves an existing user blocker through resume`,async t=>{
 const {h,store,step}=await setupUpdate(t),[alpha,beta]=step.items,handlers=new Map();let tool;
 const pi={on:(name,handler)=>handlers.set(name,handler),registerTool:value=>tool=value,appendEntry(){}};
 const {workflowContextFor}=await import('../packages/wardrobe/src/workflow-context.mjs');
 workflowContextFor(pi,store).accept(step);registerWorkflowTool(pi,store);
 const call=async input=>(await tool.execute('blocked-recovery',input,undefined,undefined,{cwd:h.sandbox.project})).details;
 const blocker={reason:'Need the requested compatibility choice',nextStep:'Ask which API behavior to preserve',needsUser:true};
 const saved=await call({action:'save',submission:{summary:'Both reviews saved pending compatibility approval',checks:[],decisions:[alpha,beta].map(item=>({id:item.required[0],action:'adopt',reason:'Review saved pending compatibility approval'})),blockers:[{item:alpha.id,...blocker}]}});
 await call(saved.nextCall);
 if(recovery==='settlement'){
  assert.equal((await handlers.get('agent_before_settle')({outcome:'completed'})).continue,true);
  assert.equal(await handlers.get('agent_before_settle')({outcome:'completed'}),undefined);
 }else{
  for(let i=0;i<20;i++)await recordWorkflowTurn(store,step.workspace.root,{});
 }
 const paused=await call({action:'details'});assert.equal(paused.status,'STALLED');
 assert.deepEqual(paused.items.find(item=>item.id===alpha.id).blocker,blocker);
 const resumed=await call({action:'resume'});
 assert.equal(resumed.items.find(item=>item.id===alpha.id).status,'blocked');
 assert.deepEqual(resumed.items.find(item=>item.id===alpha.id).blocker,blocker);
 assert.equal((await call({action:'verify'})).code,'WORKFLOW_INCOMPLETE');
 await call({action:'save',submission:{resolvedBlockers:[alpha.id]}});
 const verified=await call({action:'verify'});assert.equal(verified.status,'READY_TO_INSTALL',JSON.stringify(verified));
});
for(const needsUser of [true,false])test(`needsUser=${needsUser}: explicit blocker replaces a recovery pause without automatic resolution`,async t=>{
 const {call,store,step}=await setupUpdate(t),[alpha,beta]=step.items;
 for(let i=0;i<20;i++)await recordWorkflowTurn(store,step.workspace.root,{});
 const recovered=await call({action:'details'});assert.equal(recovered.focus.id,beta.id);
 const blocker={reason:'Compatibility behavior remains unresolved',nextStep:'Review which API behavior to preserve',...(needsUser?{needsUser:true}:{})};
 await call({action:'save',submission:{summary:'Reviews saved pending user choice',checks:[],decisions:[alpha,beta].map(item=>({id:item.required[0],action:'adopt',reason:'Review saved pending user choice'})),blockers:[{item:alpha.id,...blocker}]}});
 await call({action:'save',submission:{decisions:[{id:alpha.required[0],action:'adopt',reason:'Decision saved again; compatibility blocker still requires resolution'}]}});
 const resumed=await call({action:'resume'});
 assert.equal(resumed.items.find(item=>item.id===alpha.id).status,'blocked');
 assert.deepEqual(resumed.items.find(item=>item.id===alpha.id).blocker,blocker);
 assert.equal((await call({action:'verify'})).code,'WORKFLOW_INCOMPLETE');
 await call({action:'save',submission:{resolvedBlockers:[alpha.id]}});
 assert.equal((await call({action:'verify'})).status,'READY_TO_INSTALL');
});
test('an invalid final submission cannot mutate the durable item ledger',async t=>{
 const {call,step}=await setupUpdate(t),item=step.items[0];
 const invalid=await call({action:'verify',submission:{summary:'Invalid action',decisions:[{id:item.required[0],action:'invalid',reason:'Must not persist'}],checks:[]}});
 assert.equal(invalid.status,'ERROR');const recovered=await call({action:'details'});
 assert.equal(recovered.saved,undefined);assert.equal(recovered.items.find(candidate=>candidate.id===item.id).status,'pending');
});
test('initial verify reports incomplete coverage and a lone decision can be saved without boilerplate',async t=>{
 const {call,step}=await setupUpdate(t),item=step.items[0],incomplete=await call({action:'verify'});
 assert.equal(incomplete.status,'ERROR');assert.equal(incomplete.code,'WORKFLOW_INCOMPLETE');assert.deepEqual(incomplete.incomplete.missingDecisions,step.requiredDecisions);
 const saved=await call({action:'save',submission:{decisions:[{id:item.required[0],action:'adopt',reason:'One complete decision'}]}});
 assert.equal(saved.saved.decisions[0].id,item.required[0]);assert.equal(saved.items.find(candidate=>candidate.id===item.id).status,'decided');
});
test('all changes and explicit requirements are available together; partial decisions persist without permitting installation',async t=>{
 const {source,call}=setup(t);const step=await call({action:'update',source,request:'Add local export'});
 assert.equal(step.execution,'change-list');assert.match(step.request,/local export/);
 assert.ok(step.requiredDecisions.includes('request'));assert.ok(step.requiredDecisions.includes('runtime-review'));
 assert.ok(step.items.some(item=>item.id==='requested'));assert.ok(step.items.some(item=>item.id==='runtime-review'));
 writeFileSync(join(step.workspace.source,'export.md'),'Local export enabled.');
 const saved=await call({action:'save',submission:{summary:'Requested export done; runtime review pending',decisions:[{id:'request',action:'adapt',reason:'Local export instruction added'}],checks:[],work:[{id:'export',origins:['request'],goal:'Deliver local export instruction',paths:['export.md'],ready:true,checks:[{command:'node',args:['-e',"require('node:assert/strict').equal(require('node:fs').readFileSync('export.md','utf8'),'Local export enabled.')"],reason:'The local export instruction is delivered'}]}]}});
 assert.equal(saved.status,'REVIEW_REQUIRED');assert.equal(saved.saved.decisions.length,1);
 assert.equal((await call({action:'verify'})).status,'ERROR');
 assert.equal((await call({action:'install',approved:true})).status,'ERROR');
 const reviewed=await call({action:'verify',submission:{summary:'Runtime review complete',decisions:[{id:'runtime-review',action:'defer',reason:'Optional runtime changes do not affect this instruction-only preset'}],checks:[]}});
 assert.equal(reviewed.status,'READY_TO_INSTALL',JSON.stringify(reviewed));
 assert.equal((await call({action:'save',submission:{summary:'Add a late failing check',decisions:[],checks:[{command:'node',args:['-e','process.exit(9)'],reason:'Late check'}]}})).status,'ERROR','sealed reviews cannot gain unverified requirements');
 assert.equal((await call({action:'install',approved:true})).status,'INSTALLED');
});
test('candidate edits and fresh evidence remain progress beyond 24 turns; a true repeated no-progress loop pauses',async t=>{
 const {source,store,call}=setup(t);const step=await call({action:'maintain',source,request:'Improve export'});
 let state;
 for(let i=0;i<30;i++){
  writeFileSync(join(step.workspace.source,'export.md'),'Revision '+i);
  state=await recordWorkflowTurn(store,step.workspace.root,{newObservations:['fresh-'+i]});
 }
 assert.equal(state.status,'REVIEW_REQUIRED');
 for(let i=0;i<20;i++)state=await recordWorkflowTurn(store,step.workspace.root,{});
 assert.equal(state.status,'STALLED');
 const resumed=await call({action:'resume'});assert.equal(resumed.status,'REVIEW_REQUIRED');assert.equal(resumed.focus.id,'maintain');assert.equal(resumed.items[0].status,'in_progress');assert.match(resumed.items[0].previousBlocker.reason,/No candidate/);assert.match(resumed.focus.previousBlocker.reason,/No candidate/);
});

test('a failed tool at the recovery boundary remains editable for native correction',async t=>{
 const {source,store,call}=setup(t);const step=await call({action:'maintain',source,request:'Improve export'});
 for(let i=0;i<16;i++)await recordWorkflowTurn(store,step.workspace.root,{});
 const failed=await recordWorkflowTurn(store,step.workspace.root,{failureSignature:'edit-validation',stopReason:'toolUse'});
 assert.equal(failed.status,'REVIEW_REQUIRED');assert.equal(failed.progress.consecutiveFailures,1);
 writeFileSync(join(step.workspace.source,'export.md'),'Corrected edit');
 const corrected=await recordWorkflowTurn(store,step.workspace.root,{});
 assert.equal(corrected.status,'REVIEW_REQUIRED');assert.equal(corrected.progress.consecutiveFailures,0);
});

test('native correction opportunities remain bounded across different tool failures',async t=>{
 const {source,store,call}=setup(t);const step=await call({action:'maintain',source,request:'Improve export'});
 for(let i=0;i<16;i++)await recordWorkflowTurn(store,step.workspace.root,{});
 for(const failureSignature of ['edit-validation','read-missing']){const state=await recordWorkflowTurn(store,step.workspace.root,{failureSignature,stopReason:'toolUse'});assert.equal(state.status,'REVIEW_REQUIRED');}
 const exhausted=await recordWorkflowTurn(store,step.workspace.root,{failureSignature:'write-conflict',stopReason:'toolUse'});
 assert.equal(exhausted.status,'STALLED');assert.equal(exhausted.progress.consecutiveFailures,3);
});

test('schema correction remains available after successful investigation exhausts native continuations',async t=>{
 const {h,source,store,call}=setup(t),step=await call({action:'maintain',source,request:'Improve export'}),handlers=new Map();let tool;
 const pi={on:(name,handler)=>handlers.set(name,handler),registerTool:value=>tool=value,appendEntry(){}};
 const {workflowContextFor}=await import('../packages/wardrobe/src/workflow-context.mjs');
 workflowContextFor(pi,store).accept(step);registerWorkflowTool(pi,store);
 for(let i=0;i<16;i++)await recordWorkflowTurn(store,step.workspace.root,{});
 const turn=async(id,name,input,text,isError=false)=>handlers.get('turn_end')({outcome:'completed',message:{role:'assistant',stopReason:'toolUse',content:[{type:'toolCall',id,name,arguments:input}]},toolResults:[{role:'toolResult',toolName:name,toolCallId:id,isError,content:[{type:'text',text}]}]});
 for(let i=0;i<2;i++)await turn('read-'+i,'bash',{command:'cat evidence-'+i},'Evidence '+i);
 // Pi validates tool schemas before execute; the native failure still reaches turn_end.
 await turn('invalid-save','wardrobe_workflow',{action:'save',decisions:[]},'Validation failed: decisions: schema is false',true);
 const input={action:'save',submission:{summary:'Export instruction reviewed'}};
 assert.equal(await handlers.get('tool_call')({toolName:'wardrobe_workflow',input},{cwd:h.sandbox.project}),undefined,'the corrected save must reach execute instead of being blocked as STALLED');
 const saved=(await tool.execute('corrected-save',input,undefined,undefined,{cwd:h.sandbox.project})).details;
 assert.equal(saved.status,'REVIEW_REQUIRED',JSON.stringify(saved));assert.equal(saved.items[0].status,'decided');
});

test('alternating successful investigation and tool failures cannot renew the correction budget',async t=>{
 const {source,store,call}=setup(t),step=await call({action:'maintain',source,request:'Improve export'});
 for(let i=0;i<16;i++)await recordWorkflowTurn(store,step.workspace.root,{});
 for(let i=0;i<2;i++){
  assert.equal((await recordWorkflowTurn(store,step.workspace.root,{failureSignature:'failure-'+i,stopReason:'toolUse'})).status,'REVIEW_REQUIRED');
  assert.equal((await recordWorkflowTurn(store,step.workspace.root,{newObservations:['read-'+i],stopReason:'toolUse'})).status,'REVIEW_REQUIRED');
 }
 const exhausted=await recordWorkflowTurn(store,step.workspace.root,{failureSignature:'failure-2',stopReason:'toolUse'});
 assert.equal(exhausted.status,'STALLED');
});

test('native tool continuation cannot make investigation unlimited',async t=>{
 const {source,store,call}=setup(t);const step=await call({action:'maintain',source,request:'Improve export'});
 for(let i=0;i<16;i++)await recordWorkflowTurn(store,step.workspace.root,{});
 for(let i=0;i<2;i++){const state=await recordWorkflowTurn(store,step.workspace.root,{newObservations:['active-'+i],stopReason:'toolUse'});assert.equal(state.status,'REVIEW_REQUIRED');}
 const exhausted=await recordWorkflowTurn(store,step.workspace.root,{newObservations:['still-no-delivery'],stopReason:'toolUse'});
 assert.equal(exhausted.status,'STALLED');
});

test('an unproductive focus automatically hands recovery to independent work',async t=>{
 const {call,store,step}=await setupUpdate(t),[alpha,beta]=step.items;let state;
 for(let i=0;i<20;i++)state=await recordWorkflowTurn(store,step.workspace.root,{newObservations:['investigation-'+i]});
 assert.equal(state.status,'REVIEW_REQUIRED');
 const recovered=await call({action:'details'});assert.equal(recovered.items.find(item=>item.id===alpha.id).status,'blocked');assert.equal(recovered.focus.id,beta.id);assert.equal(recovered.items.find(item=>item.id===beta.id).status,'in_progress');assert.equal(recovered.nextCall.action,'save');
 const saved=await call({action:'save',submission:{summary:'Independent beta remains deliverable',decisions:[{id:beta.required[0],action:'adopt',reason:'Independent evidence is sufficient'}],checks:[]}});
 assert.equal(saved.items.find(item=>item.id===beta.id).status,'decided');assert.equal((await call({action:'verify'})).code,'WORKFLOW_INCOMPLETE');
});

test('automatic recovery refreshes the native handle used by the next public save',async t=>{
 const {h,store,step}=await setupUpdate(t),[,beta]=step.items,handlers=new Map();let tool;
 const pi={on:(name,handler)=>handlers.set(name,handler),registerTool:value=>tool=value,appendEntry(){}};
 const {workflowContextFor}=await import('../packages/wardrobe/src/workflow-context.mjs');
 workflowContextFor(pi,store).accept(step);registerWorkflowTool(pi,store);
 for(let i=0;i<17;i++)await handlers.get('turn_end')({outcome:'completed',message:{role:'assistant',stopReason:'toolUse',content:[{type:'toolCall',id:'recover-'+i,name:'bash',arguments:{command:'cat evidence-'+i}}]},toolResults:[{role:'toolResult',toolName:'bash',toolCallId:'recover-'+i,content:[{type:'text',text:'Evidence '+i}]}]});
 const saved=(await tool.execute('test',{action:'save',submission:{decisions:[{id:beta.required[0],action:'adopt',reason:'Recovered focus remains saveable'}]}},undefined,undefined,{cwd:h.sandbox.project})).details;
 assert.equal(saved.status,'REVIEW_REQUIRED',JSON.stringify(saved));assert.equal(saved.saved.decisions[0].id,beta.required[0]);assert.equal(saved.items.find(item=>item.id===beta.id).status,'decided');
});

test('concrete saved decisions resolve delivery pauses across independent items',async t=>{
 const {call,store,step}=await setupUpdate(t),[alpha,beta]=step.items;
 for(let i=0;i<20;i++)await recordWorkflowTurn(store,step.workspace.root,{});
 await call({action:'details'});
 const independent=await call({action:'save',submission:{decisions:[{id:beta.required[0],action:'adapt',reason:'Independent beta review complete'}]}});
 assert.equal(independent.items.find(item=>item.id===alpha.id).status,'blocked','delivery for an unrelated item cannot clear the pause');
 const delivered=await call({action:'save',submission:{summary:'Reviewed both independent adaptations',checks:[],decisions:[alpha,beta].map(item=>({id:item.required[0],action:'adapt',reason:'Concrete upstream adaptation completed'}))}});
 assert.equal(delivered.status,'REVIEW_REQUIRED',JSON.stringify(delivered));
 assert.equal(delivered.items.find(item=>item.id===alpha.id).status,'decided','a no-delivery pause is satisfied by the newly saved item decision');
 assert.equal(delivered.nextCall.action,'verify');
 const details=await call({action:'details'});
 assert.equal(details.items.find(item=>item.id===alpha.id).status,'decided','the resolution must remain durable');
 assert.equal((await call({action:'verify'})).status,'READY_TO_INSTALL');
});

test('premature settlement continues independent work before pausing the exhausted workflow',async t=>{
 const {h,store,step}=await setupUpdate(t),[alpha,beta]=step.items,handlers=new Map();let tool;
 const pi={on:(name,handler)=>handlers.set(name,handler),registerTool:value=>tool=value,appendEntry(){}};
 const {workflowContextFor}=await import('../packages/wardrobe/src/workflow-context.mjs');
 workflowContextFor(pi,store).accept(step);registerWorkflowTool(pi,store);
 const call=async input=>(await tool.execute('settlement',input,undefined,undefined,{cwd:h.sandbox.project})).details;
 assert.equal((await handlers.get('agent_before_settle')({outcome:'completed'})).continue,true);
 assert.equal((await handlers.get('agent_before_settle')({outcome:'completed'}))?.continue,true,'independent work must keep the native agent running');
 const recovered=await call({action:'details'});
 assert.equal(recovered.status,'REVIEW_REQUIRED');assert.equal(recovered.focus.id,beta.id);
 assert.equal(recovered.items.find(item=>item.id===alpha.id).status,'blocked');
 assert.equal(await handlers.get('tool_call')({toolName:'write',input:{path:join(step.workspace.source,'delivery.md')}},{cwd:h.sandbox.project}),undefined);
 const saved=await call({action:'save',submission:{decisions:[{id:beta.required[0],action:'adopt',reason:'Independent beta review remains deliverable'}]}});
 assert.equal(saved.status,'REVIEW_REQUIRED');assert.equal(saved.items.find(item=>item.id===beta.id).status,'decided');
 assert.equal((await handlers.get('agent_before_settle')({outcome:'completed'})).continue,true);
 assert.equal(await handlers.get('agent_before_settle')({outcome:'completed'}),undefined);
 const paused=await call({action:'details'});assert.equal(paused.status,'STALLED');
 assert.equal(paused.saved.decisions[0].id,beta.required[0]);assert.equal(paused.nextCall.action,'resume');
});

test('recovery time belongs to its focus rather than unrelated work on another item',async t=>{
 const {call,store,step}=await setupUpdate(t),[alpha,beta]=step.items;
 for(let i=0;i<9;i++)await recordWorkflowTurn(store,step.workspace.root,{newObservations:['alpha-'+i]});
 await call({action:'focus',item:beta.id});
 for(let i=0;i<9;i++)await recordWorkflowTurn(store,step.workspace.root,{newObservations:['beta-'+i]});
 await call({action:'focus',item:alpha.id});const state=await recordWorkflowTurn(store,step.workspace.root,{newObservations:['alpha-return']});
 assert.equal(state.status,'REVIEW_REQUIRED');assert.notEqual((await call({action:'details'})).items.find(item=>item.id===alpha.id).status,'blocked');
});

test('an unfocused review exposes the full index before recovery selects outstanding work',async t=>{
 const {call,store,step}=await setupUpdate(t),[alpha,beta]=step.items;
 await call({action:'save',submission:{summary:'Alpha decided; choose the next focus',decisions:[{id:alpha.required[0],action:'adopt',reason:'Complete'}],checks:[]}});
 const recovered=await call({action:'details'});assert.deepEqual(recovered.decisions,[]);assert.deepEqual(recovered.material.incoming,[],JSON.stringify({focus:recovered.focus,decisions:recovered.decisions,material:recovered.material}));assert.ok(recovered.changes);
 let state;for(let i=0;i<20;i++)state=await recordWorkflowTurn(store,step.workspace.root,{newObservations:['unfocused-'+i]});
 assert.equal(state.status,'REVIEW_REQUIRED');const handedOff=await call({action:'details'});assert.equal(handedOff.focus.id,beta.id);assert.equal(handedOff.nextCall.action,'save');
});

test('returning to already seen candidate states is a loop rather than fresh progress',async t=>{
 const {source,store,call}=setup(t);const step=await call({action:'maintain',source,request:'Improve export'});let state;
 for(let i=0;i<30;i++){
  writeFileSync(join(step.workspace.source,'export.md'),i%2?'A':'B');
  state=await recordWorkflowTurn(store,step.workspace.root,{});
 }
 assert.equal(state.status,'STALLED');
});
test('new bash observations count as investigation but cannot replace durable delivery or become verified evidence',async t=>{
 const {source,store,call}=setup(t),step=await call({action:'maintain',source,request:'Inspect affected interfaces'});
 const {workflowContextFor}=await import('../packages/wardrobe/src/workflow-context.mjs');
 const {loadWorkflowRecord}=await import('../packages/wardrobe/src/workflow-journal.mjs');
 const {validObservationIds}=await import('../packages/wardrobe/src/workflow-observations.mjs');
 const handlers=new Map();workflowContextFor({on:(name,handler)=>handlers.set(name,handler)},store).accept(step);
 const inspect=async i=>handlers.get('turn_end')({outcome:'completed',message:{role:'assistant',stopReason:'toolUse',content:[{type:'toolCall',id:'inspect-'+i,name:'bash',arguments:{command:'cat interface-'+i+'.md'}}]},toolResults:[{role:'toolResult',toolName:'bash',toolCallId:'inspect-'+i,content:[{type:'text',text:'Interface '+i}]}]});
 for(let i=0;i<30;i++)await inspect(i);
 assert.equal(loadWorkflowRecord(step.workspace.root).status,'STALLED','changing investigation output cannot extend a zero-delivery focus indefinitely');
 assert.deepEqual(validObservationIds(step.workspace.root),[],'unknown shell dependencies still require revalidation before evidence reuse');
});
test('failed verification opens a focused repair decision before final re-verification',async t=>{
 const {source,call}=setup(t),step=await call({action:'maintain',source,request:'Repair the export'});
 writeFileSync(join(step.workspace.source,'export.md'),'broken');
 const check={command:'node',args:['-e',"process.exit(require('node:fs').readFileSync('export.md','utf8')==='fixed'?0:1)"],reason:'Export contains the repaired behavior'};
 await call({action:'save',submission:{summary:'Check the broken export before repair',checks:[check]}});
 const failed=await call({action:'verify'});
 assert.equal(failed.status,'CHECK_FAILED',JSON.stringify(failed));assert.equal(failed.focus.id,'verification-repair');assert.deepEqual(failed.nextCall.submission.decisions,[{id:'verification-repair',action:'adapt',reason:'Repair the reported verification failures and rerun the affected checks'}]);assert.ok(failed.repair.failures.length);
 const acknowledged=await call(failed.nextCall);assert.equal(acknowledged.nextCall.action,'verify','the returned repair call is valid without rewriting an empty reason');
 const repeated=await call({action:'verify'});assert.equal(repeated.status,'CHECK_FAILED');assert.equal(repeated.focus.id,'verification-repair');assert.equal(repeated.nextCall.action,'save','a later failure reopens the repair decision');
 writeFileSync(join(step.workspace.source,'export.md'),'fixed');
 const repaired=await call({action:'save',submission:{decisions:[{id:'verification-repair',action:'adapt',reason:'Corrected the export and reran its affected check'}]}});
 assert.equal(repaired.nextCall.action,'verify');
 assert.equal((await call({action:'verify'})).status,'READY_TO_INSTALL');
});

test('save rejects a source-valued resource package with an actionable error and keeps the draft clean',async t=>{
 const {source,call}=setup(t),step=await call({action:'maintain',source,request:'Replace the status line package'});
 const invalid=await call({action:'save',submission:{summary:'Use the new package source as its alias',decisions:[],resources:[{action:'add',package:'npm:pi-statusline@0.0.2',kind:'extensions',path:'src/index.ts'}],checks:[]}});
 assert.equal(invalid.status,'ERROR',JSON.stringify(invalid));assert.equal(invalid.code,'WORKFLOW_RESOURCE_PACKAGE');
 assert.match(invalid.message,/resources\[0\]\.package/);assert.match(invalid.message,/npm:pi-statusline@0\.0\.2/);assert.match(invalid.message,/self/);
 assert.equal((await call({action:'details'})).saved,undefined,'the invalid operation must not enter the durable draft');
 mkdirSync(join(step.workspace.source,'src'),{recursive:true});writeFileSync(join(step.workspace.source,'src/index.ts'),'export default function statusLine() {}\n');
 const corrected=await call({action:'save',submission:{resources:[{action:'add',package:'self',kind:'extensions',path:'src/index.ts'}]}});
 assert.equal(corrected.status,'REVIEW_REQUIRED',JSON.stringify(corrected));assert.equal(corrected.saved.resources[0].package,'self');
});

test('verification preflight failures open a concrete repair instead of repeating verify',async t=>{
 const {source,call}=setup(t),step=await call({action:'maintain',source,request:'Declare a resource'});
 const invalid={action:'add',package:'missing',kind:'extensions',path:'extensions/missing.mjs'};
 const {loadWorkflowRecord,commitWorkflow}=await import('../packages/wardrobe/src/workflow-journal.mjs');
 const record=loadWorkflowRecord(step.workspace.root);record.draft={summary:'Legacy invalid resource draft',decisions:[],resources:[invalid],migrations:[],checks:[],obligations:[]};commitWorkflow(record,{type:'fixture.legacy-invalid-resource'});
 const failed=await call({action:'verify'});
 assert.equal(failed.status,'CHECK_FAILED',JSON.stringify(failed));assert.equal(failed.code,'WORKFLOW_RESOURCE_PACKAGE');assert.equal(failed.focus.id,'verification-repair');
 assert.ok(failed.items.find(item=>item.id==='verification-repair').files.includes('preset.json'));assert.match(JSON.stringify(failed.repair.failures),/declared package/);
 assert.deepEqual(failed.repair.failures[0].resourceChange,{index:0,field:'package',change:invalid,allowedPackages:['self']});
 assert.equal(failed.nextCall.action,'save');assert.equal(failed.nextCall.replace,true);assert.deepEqual(failed.nextCall.submission.resources,[invalid]);
 const recovered=await call({action:'details'});assert.equal(recovered.nextCall.replace,true);assert.deepEqual(recovered.nextCall.submission.resources,[invalid],'native investigation and recovery retain the draft repair template');
 writeFileSync(join(step.workspace.source,'export.md'),'Resource declaration repaired.');
 const submission={...failed.nextCall.submission,resources:[],decisions:[{id:'verification-repair',action:'adapt',reason:'The requested package is not part of this preset'}]};
 const repaired=await call({...failed.nextCall,submission});
 assert.equal(repaired.nextCall.action,'verify',JSON.stringify(repaired));
 assert.equal((await call({action:'verify'})).status,'READY_TO_INSTALL');
 assert.equal((await call({action:'install',approved:true})).status,'INSTALLED');
});

test('verification preserves declaration diagnostics and names the actual preset repair file',async t=>{
 const {source,call}=setup(t),step=await call({action:'maintain',source,request:'Repair the declaration'});
 const file=join(step.workspace.source,'preset.json'),definition=JSON.parse(readFileSync(file));
 definition.runtime={unexpected:true};writeJson(file,definition);
 await call({action:'save',submission:{summary:'Check the edited declaration'}});
 const failed=await call({action:'verify'});
 assert.equal(failed.status,'CHECK_FAILED',JSON.stringify(failed));
 assert.match(failed.checks[0].tail,/\/runtime\/unexpected/);
 assert.equal(failed.diagnostics[0].path,'/runtime/unexpected');
 assert.ok(failed.items.find(item=>item.id==='verification-repair').files.includes('preset.json'));
 assert.match(JSON.parse(readFileSync(join(step.workspace.root,'verification.json'))).checks[0].tail,/\/runtime\/unexpected/);
 delete definition.runtime;writeJson(file,definition);
 await call({action:'save',submission:{decisions:[{id:'verification-repair',action:'adapt',reason:'Removed the unsupported declaration field'}]}});
 assert.equal((await call({action:'verify'})).status,'READY_TO_INSTALL');
});

test('a removed package can retire its frozen resources through save, verify and inactive installation',async t=>{
 const {h,source,store,call}=setup(t);
 await h.npmPackage('legacy-resource-owner',[{version:'1.0.0',pi:{extensions:['extension.mjs']},extraFiles:{'extension.mjs':'export default function extension() {}\n'}}]);
 const previous=Object.fromEntries(['WARDROBE_REGISTRY','npm_config_registry'].map(name=>[name,process.env[name]]));
 Object.assign(process.env,{WARDROBE_REGISTRY:h.server.origin+'/npm/',npm_config_registry:h.server.origin+'/npm/'});
 t.after(()=>{for(const [name,value] of Object.entries(previous))if(value===undefined)delete process.env[name];else process.env[name]=value;});
 const definition=JSON.parse(readFileSync(join(source,'preset.json')));
 definition.packages.legacy={source:'npm:legacy-resource-owner@1.0.0'};
 definition.resources=[{package:'legacy',kind:'extensions',include:['extension.mjs']}];
 writeJson(join(source,'preset.json'),definition);writeJson(join(source,'manifest.json'),{piVersion:h.runtime.version});
 const step=await call({action:'maintain',source,request:'Retire the old package'});
 assert.equal(step.status,'REVIEW_REQUIRED',JSON.stringify(step));
 const file=join(step.workspace.source,'preset.json'),candidate=JSON.parse(readFileSync(file));
 delete candidate.packages.legacy;candidate.resources=[];writeJson(file,candidate);
 const incomplete=await call({action:'save',submission:{summary:'Removed the old package declaration'}});
 assert.equal(incomplete.code,'WORKFLOW_RESOURCE_PACKAGE',JSON.stringify(incomplete));
 assert.match(incomplete.message,/legacy/);assert.match(incomplete.message,/extension.mjs/);assert.match(incomplete.message,/retire/);
 const saved=await call({action:'save',submission:{summary:'Explicitly retire the old export',resources:[{action:'retire',package:'legacy',kind:'extensions',path:'extension.mjs'}]}});
 assert.equal(saved.status,'REVIEW_REQUIRED',JSON.stringify(saved));
 assert.equal((await call({action:'verify'})).status,'READY_TO_INSTALL');
 assert.deepEqual(JSON.parse(readFileSync(file)).resources,[]);
 assert.equal((await call({action:'install',approved:true})).status,'INSTALLED');
 assert.equal(store.read().default,null);
});

test('saved resource operations retain replacement and later visibility changes',async t=>{
 const {source,call}=setup(t);mkdirSync(join(source,'skills/old'),{recursive:true});
 const skill=name=>'---\nname: '+name+'\ndescription: Local method\n---\nLocal behavior.\n';
 writeFileSync(join(source,'skills/old/SKILL.md'),skill('old'));
 writeJson(join(source,'package.json'),{name:'autonomous',version:'1.0.0',type:'module',pi:{skills:['skills/old/SKILL.md']}});
 writeJson(join(source,'preset.json'),{schemaVersion:1,id:'autonomous/resources',name:'Resources',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[{package:'self',kind:'skills',include:['skills/old/SKILL.md']}]});
 const step=await call({action:'maintain',source,request:'Prepare a replacement and leave it disabled'});
 mkdirSync(join(step.workspace.source,'skills/new'));writeFileSync(join(step.workspace.source,'skills/new/SKILL.md'),skill('new'));
 const resource={package:'self',kind:'skills',path:'skills/new/SKILL.md'};
 await call({action:'save',submission:{summary:'Replacement',decisions:[],resources:[{...resource,action:'replace',oldPath:'skills/old/SKILL.md'}],checks:[]}});
 const saved=await call({action:'save',submission:{summary:'Leave replacement disabled',decisions:[],resources:[{...resource,action:'disable'}],checks:[]}});
 assert.deepEqual(saved.saved.resources.map(r=>r.action),['replace','disable']);
 const repeated=await call({action:'save',submission:{summary:'Retry replacement declaration',decisions:[],resources:[{...resource,action:'replace',oldPath:'skills/old/SKILL.md'}],checks:[]}});
 assert.deepEqual(repeated.saved.resources.map(r=>r.action),['replace','disable'],'retry preserves creation before visibility');
 await call({action:'save',submission:{summary:'Enable replacement',decisions:[],resources:[{...resource,action:'enable'}],checks:[]}});
 const disabled=await call({action:'save',submission:{summary:'Disable replacement again',decisions:[],resources:[{...resource,action:'disable'}],checks:[]}});
 assert.deepEqual(disabled.saved.resources.map(r=>r.action),['replace','disable'],'latest visibility wins without reordering the creation');
 assert.equal((await call({action:'verify'})).status,'READY_TO_INSTALL');
});

test('resumed legacy execution consumes saved checks rather than silently ignoring them',async t=>{
 const {source,call}=setup(t);const step=await call({action:'maintain',source,request:'Check the legacy candidate'});
 const {loadWorkflowRecord,commitWorkflow}=await import('../packages/wardrobe/src/workflow-journal.mjs');
 const record=loadWorkflowRecord(step.workspace.root);delete record.execution;commitWorkflow(record,{type:'fixture.legacy'});
 await call({action:'save',submission:{summary:'A saved failing behavior check',decisions:[],checks:[{command:'node',args:['-e','process.exit(8)'],reason:'Legacy saved behavior'}]}});
 const checked=await call({action:'verify'});assert.equal(checked.status,'CHECK_FAILED');assert.ok(checked.checks.some(c=>c.code===8));
});
