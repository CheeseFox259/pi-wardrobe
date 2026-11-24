import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { NativeStore, writeJson } from '../packages/wardrobe/src/native-store.mjs';
import { handleNativeCommand } from '../packages/wardrobe/src/native-flow.mjs';
import { normalizePresetSource } from '../packages/wardrobe/src/native-normalize.mjs';
import { registerWorkflowTool } from '../packages/wardrobe/src/workflow-tool.mjs';
import { advanceUpdateLineage, planPresetUpdate } from '../packages/wardrobe/src/preset-update.mjs';
import { supportsPi } from '../packages/wardrobe/src/semver.mjs';
import { prepareUpdateContext } from '../packages/wardrobe/src/update-context.mjs';
import { gitTextDelta } from '../packages/wardrobe/src/git-delta.mjs';
import { resolvePiRuntime } from '../fixtures/lib/runtime.mjs';
import { lookupResource } from '../packages/wardrobe/src/resource-lookup.mjs';

test('an unpinned npm lookup returns the latest exact version and a targeted next call',async t=>{
  const root=mkdtempSync(join(tmpdir(),'wardrobe-npm-lookup-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const requests=[];const server=createServer((req,res)=>{requests.push(req.url);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({'dist-tags':{latest:'0.0.2'},versions:{'0.0.2':{name:'pi-statusline',version:'0.0.2',description:'Statusline extension'}}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const result=await lookupResource({root:join(root,'agent')},'npm:pi-statusline',{WARDROBE_REGISTRY:'http://127.0.0.1:'+server.address().port+'/'},{query:'statusline footer compatibility',timeoutMs:1000});
  assert.equal(result.status,'NEEDS_VERSION');
  assert.deepEqual(result.package,{name:'pi-statusline',latestVersion:'0.0.2',description:'Statusline extension'});
  assert.deepEqual(result.nextCall,{action:'lookup',source:'npm:pi-statusline@0.0.2',request:'statusline footer compatibility'});
  assert.deepEqual(requests,['/pi-statusline']);
});

test('optional release-note downloads time out without blocking update handoff',async t=>{
  const root=mkdtempSync(join(tmpdir(),'wardrobe-notes-timeout-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  let requests=0,downloads=0;const server=createServer((req,res)=>{requests++;if(req.url==='/sample'){res.setHeader('content-type','application/json');res.end(JSON.stringify({versions:{'1.1.0':{repository:'https://example.invalid/upstream',dist:{integrity:'sha512-fixture',tarball:'http://127.0.0.1:'+server.address().port+'/slow.tgz'}}}}));}else downloads++;});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const plan={status:'REVIEW_REQUIRED',repositories:[],packages:[{name:'sample',installed:'1.0.0',latest:'1.1.0',changed:true}]};
  await prepareUpdateContext(plan,{root,docsCache:join(root,'cache'),env:{WARDROBE_REGISTRY:'http://127.0.0.1:'+server.address().port+'/'},notesTimeoutMs:50});
  assert.equal(requests,2);assert.equal(plan.releaseNotes[0].status,'UNAVAILABLE');assert.match(plan.releaseNotes[0].reason,/timeout/i);
  const env={WARDROBE_REGISTRY:'http://127.0.0.1:'+server.address().port+'/'},store={root:join(root,'lookup')};
  const unavailable=await lookupResource(store,'npm:sample@1.1.0',env,{timeoutMs:50});assert.equal(unavailable.status,'RESOURCE_UNAVAILABLE');assert.equal(unavailable.channels.repository,'https://example.invalid/upstream');
  const count=downloads;assert.equal((await lookupResource(store,'npm:sample@1.1.0',env,{timeoutMs:50})).status,'RESOURCE_UNAVAILABLE');assert.equal(downloads,count,'a repeated lookup uses the explicit unavailable result instead of repeating the stalled download');
});

test('older presets accept newer Pi while explicit constraints retain their meaning',()=>{
  for(const requirement of ['1.0.4','~1.0.4','^1.0.4','1.x','>=1.0.4'])assert.equal(supportsPi(requirement,'1.3.0'),true,requirement);
  for(const requirement of ['=1.0.4','>=1.0.4 <1.2.0','1.4.0'])assert.equal(supportsPi(requirement,'1.3.0'),false,requirement);
  assert.equal(supportsPi('1.0.4','unknown'),null);
});

test('a transient registry failure is retried once before handing work to the model',async t=>{
  const source=mkdtempSync(join(tmpdir(),'wardrobe-registry-retry-'));t.after(()=>rmSync(source,{recursive:true,force:true}));
  writeJson(join(source,'preset.json'),{packages:{addon:{source:'npm:sample@1.0.0'}}});
  let requests=0;const server=createServer((_req,res)=>{requests++;res.writeHead(requests===1?503:200,{'content-type':'application/json'});res.end(requests===1?'{}':JSON.stringify({version:'1.0.0'}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const plan=await planPresetUpdate({source,cacheDir:join(source,'cache'),piVersion:'1.3.0',registry:'http://127.0.0.1:'+server.address().port+'/'});
  assert.equal(requests,2);assert.equal(plan.status,'NO_UPDATE');assert.equal(plan.metrics.metadataRetries,1);assert.equal(plan.metrics.modelRequests,0);
});

test('update ends unchanged without a model and hands only incoming work to the model, retaining custom content and cached bases', async t => {
  const root=mkdtempSync(join(tmpdir(),'wardrobe-update-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,'source'),repo=join(root,'upstream'),pi=join(root,'pi');
  for(const path of [source,repo,pi+'/dist'])mkdirSync(path,{recursive:true});
  writeJson(pi+'/package.json',{name:'@earendil-works/pi-coding-agent',version:'1.3.0'});writeFileSync(pi+'/dist/cli.js','');
  writeFileSync(pi+'/CHANGELOG.md','# Changelog\n\n## [1.3.0]\nNew native feature.\n\n## [1.1.0]\nEarlier new feature.\n\n## [1.0.4]\nOld baseline feature.\n');
  const previous=process.env.WARDROBE_PI_CLI;process.env.WARDROBE_PI_CLI=pi+'/dist/cli.js';t.after(()=>{if(previous===undefined)delete process.env.WARDROBE_PI_CLI;else process.env.WARDROBE_PI_CLI=previous});
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();git('init','-q');
  const commit=()=>{git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','commit','-qm','fixture');return git('rev-parse','HEAD')};
  mkdirSync(repo+'/skills/one',{recursive:true});writeFileSync(repo+'/skills/one/SKILL.md','original\n');writeFileSync(repo+'/skills/one/helper.mjs','export const value=1;\n');writeFileSync(repo+'/README.md','upstream guide\n');const base=commit();
  mkdirSync(source+'/skills/one',{recursive:true});writeFileSync(source+'/skills/one/SKILL.md','original\nour native Pi behavior\n');writeFileSync(source+'/skills/one/helper.mjs','export const value=1;\n');writeFileSync(source+'/skills/one/custom.md','personal feature\n');
  writeJson(source+'/package.json',{name:'test',version:'1.0.0',pi:{skills:['skills/one/SKILL.md']}});
  writeJson(source+'/preset.json',{schemaVersion:1,id:'test/update',name:'Test',version:'1.0.0',compatibility:{pi:'~1.3.0'},packages:{self:{source:'.'}},resources:[{package:'self',kind:'skills',include:['skills/one/SKILL.md']}]});
  writeJson(source+'/manifest.json',{piVersion:'1.3.0',skills:[]});writeFileSync(source+'/README.md','upstream guide\nlocal guide\n');
  writeJson(source+'/components.json',{presetUpstream:{repo,baseRef:base,path:'preset.json'},upstreams:{demo:{repo,pinnedRef:base}},skills:{one:{type:'override',upstream:'demo',baseRef:base,localPath:'skills/one/SKILL.md',preservedFeatures:['native Pi behavior']}}});
  const store=new NativeStore(root+'/agent'),messages=[],results=[];
  const api={appendEntry:(_type,result)=>results.push(result),sendMessage:(message)=>messages.push(message),sendUserMessage:message=>messages.push(message)};
  const ctx={cwd:root,isIdle:()=>true,ui:{notify(){}}};
  const command=async args=>{await handleNativeCommand(api,args,ctx,store);return results.at(-1)};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end();});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const priorRegistry=process.env.WARDROBE_REGISTRY;process.env.WARDROBE_REGISTRY='http://127.0.0.1:'+server.address().port+'/';t.after(()=>{if(priorRegistry===undefined)delete process.env.WARDROBE_REGISTRY;else process.env.WARDROBE_REGISTRY=priorRegistry});
  const definition=JSON.parse(readFileSync(source+'/preset.json'));writeJson(source+'/preset.json',{...definition,packages:{...definition.packages,missing:{source:'npm:missing@1.0.0'}}});writeJson(source+'/manifest.json',{piVersion:'1.0.4',skills:[]});
  const blocked=await command('update --source '+JSON.stringify(source));assert.equal(blocked.status,'BLOCKED');assert.equal(blocked.runtime.notes.status,'READY');
  const runtimeNotes=readFileSync(blocked.runtime.notes.path,'utf8');assert.match(runtimeNotes,/New native feature/);assert.match(runtimeNotes,/Earlier new feature/);assert.doesNotMatch(runtimeNotes,/Old baseline feature/);
  writeJson(source+'/preset.json',definition);writeJson(source+'/manifest.json',{piVersion:'1.3.0',skills:[]});
  const unchanged=await command('update --source '+JSON.stringify(source));
  assert.equal(unchanged.status,'NO_UPDATE',JSON.stringify(unchanged));assert.equal(messages.length,0);
  const repeat=await command('update --source '+JSON.stringify(source));assert.equal(repeat.metrics.clones,0);assert.equal(repeat.metrics.fetches,0);assert.equal(repeat.metrics.blobsRead,0);
  writeFileSync(repo+'/skills/one/SKILL.md','upstream methodology\n');writeFileSync(repo+'/skills/one/helper.mjs','export const value=2;\n');writeFileSync(repo+'/README.md','new guide\n');writeFileSync(repo+'/new-capability.md','New capability\n');writeFileSync(repo+'/新的能力.md','Unicode capability\n');
  for(const name of ['new-one','new-two']){mkdirSync(repo+'/skills/'+name);writeFileSync(repo+'/skills/'+name+'/SKILL.md','New upstream skill: '+name+'\n');}
  const target=commit();
  const delta=await gitTextDelta(repo,base,target,['new-capability.md'],process.env);assert.match(delta.patch,/New capability/);assert.doesNotMatch(delta.patch,/upstream methodology/);assert.equal(delta.fetchedObjects,0);
  const context={status:'REVIEW_REQUIRED',repositories:[{repo,cache:repo,previous:base,target}],capabilities:[{kind:'source-update',repo,target}],packages:[],metrics:{}};
  await prepareUpdateContext(context,{root:root+'/notes',env:process.env});assert.match(readFileSync(context.releaseNotes[0].delta,'utf8'),/Unicode capability/);
  const changed=await command('update --source '+JSON.stringify(source));assert.equal(changed.status,'REVIEW_REQUIRED',JSON.stringify(changed));assert.equal(messages.length,1);
  assert.equal(readFileSync(changed.workspace.source+'/skills/one/SKILL.md','utf8'),'original\nour native Pi behavior\n');
  assert.equal(readFileSync(changed.workspace.source+'/skills/one/helper.mjs','utf8'),'export const value=2;\n','safe incoming changes are available for autonomous review');
  assert.equal(readFileSync(changed.workspace.source+'/skills/one/custom.md','utf8'),'personal feature\n');
  assert.equal(readFileSync(changed.workspace.source+'/new-capability.md','utf8'),'New capability\n');
  assert.equal(readFileSync(changed.workspace.source+'/README.md','utf8'),'upstream guide\nlocal guide\n');
  const guide=changed.decisions.find(d=>d.path==='README.md');
  assert.equal(readFileSync(guide.inputs+'/base','utf8'),'upstream guide\n');
  assert.match(readFileSync(guide.review.upstreamDiff,'utf8'),/new guide/);
  assert.match(readFileSync(guide.review.localDiff,'utf8'),/local guide/);
  assert.equal(JSON.parse(readFileSync(changed.workspace.source+'/components.json')).skills.one.baseRef,base);
  assert.notEqual(base,target);assert.equal(readFileSync(source+'/skills/one/helper.mjs','utf8'),'export const value=1;\n');
  assert.equal(changed.releaseNotes.length,1,'shared repository ranges are delivered once');
  let tool;registerWorkflowTool({registerTool:value=>tool=value,appendEntry(){}},store);
  const resumed=(await tool.execute('test',{action:'update',source:changed.workspace.source},null,null,ctx)).details;
  assert.deepEqual(resumed.requiredDecisions,changed.requiredDecisions);
  const call=async input=>(await tool.execute('test',{workflow:changed.workspace.root,...input},null,null,ctx)).details;
  assert.equal((await call({action:'verify'})).code,'WORKFLOW_PLAN_APPROVAL_REQUIRED');
  ctx.ui.confirm=async()=>true;
  const approved=await call({action:'propose',proposal:{
    changes:[{component:'Local method',effect:'Review the new skill while preserving local behavior.',recommendation:'adapt'}],
    validation:'Check that the custom skill and existing instructions remain available.',
  }});
  assert.equal(approved.status,'PLAN_APPROVED');
  const implementation=await call({action:'resume'});
  assert.equal(implementation.planReview.phase,'approved');
  const incomplete=await call({action:'verify',batch:implementation.batch.id,revision:implementation.revision,submission:{summary:'Missing decision',decisions:[],checks:[]}});
  assert.equal(incomplete.status,'ERROR');assert.equal(incomplete.code,'WORKFLOW_INCOMPLETE');assert.ok(incomplete.incomplete.missingDecisions.length>0);
  const planPath=changed.workspace.root+'/update-plan.json',plan=readFileSync(planPath);writeFileSync(planPath,'{}');
  const rejected=(await tool.execute('test',{action:'verify',workflow:changed.workspace.root},null,null,ctx)).details;
  assert.match(rejected.message,/plan changed/);writeFileSync(planPath,plan);
  const finalized=root+'/finalized';cpSync(changed.workspace.source,finalized,{recursive:true});
  await advanceUpdateLineage(finalized,JSON.parse(plan),[{id:'README.md',action:'defer'},{id:'skill:one',action:'defer'}]);
  const lineage=JSON.parse(readFileSync(finalized+'/components.json'));
  assert.equal(lineage.presetUpstream.baseRef,target);
  assert.equal(lineage.presetUpstream.fileBases['README.md'],base,'deferred file keeps the exact old base');
  assert.equal(lineage.skills.one.baseRef,base);
});

test('focused maintain skips upstream polling, executes affected checks and rejects installation after source changes', async t => {
  const root=mkdtempSync(join(tmpdir(),'wardrobe-maintain-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,'source'),pi=join(root,'pi');mkdirSync(source+'/skills/local',{recursive:true});mkdirSync(pi+'/dist',{recursive:true});
  writeJson(pi+'/package.json',{name:'@earendil-works/pi-coding-agent',version:'1.3.0'});writeFileSync(pi+'/dist/cli.js','');
  const previous=process.env.WARDROBE_PI_CLI;process.env.WARDROBE_PI_CLI=resolvePiRuntime().cliPath;t.after(()=>{if(previous===undefined)delete process.env.WARDROBE_PI_CLI;else process.env.WARDROBE_PI_CLI=previous});
  writeJson(source+'/package.json',{name:'focused',version:'1.0.0',type:'module',pi:{}});writeJson(source+'/preset.json',{schemaVersion:1,id:'focused/test',name:'Focused',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[{package:'self',kind:'skills',include:['skills/local/SKILL.md']}]});
  writeJson(source+'/components.json',{upstreams:{unreachable:{repo:'https://127.0.0.1:1/no-network.git',pinnedRef:'old'}},skills:{local:{type:'custom',localPath:'skills/local/SKILL.md'}}});
  writeFileSync(source+'/skills/local/SKILL.md','Keep local capability.\n[Existing broken link](legacy-missing.md)\n');writeFileSync(source+'/value.mjs','export const double = n => n;\n');
  writeFileSync(source+'/check.mjs',"import assert from 'node:assert/strict';import {double} from './value.mjs';assert.equal(double(3),6);assert.equal(double(-2),-4);\n");
  let tool;const store=new NativeStore(root+'/agent');registerWorkflowTool({registerTool:value=>tool=value,appendEntry(){}},store);
  const call=async input=>(await tool.execute('test',input,null,null,{cwd:root})).details;
  assert.equal((await call({action:'maintain',source})).status,'ERROR','a concrete request is required');
  const prepared=await call({action:'maintain',source,request:'Fix double for positive and negative inputs'});assert.equal(prepared.status,'REVIEW_REQUIRED');assert.equal(prepared.kind,'maintain');
  assert.equal(prepared.context.cwd,prepared.workspace.source);
  assert.equal(prepared.context.wardrobe.presentation.event,'wardrobe:preset');
  assert.equal(prepared.context.wardrobe.presentation.clearDefault,'ui.setWidget("wardrobe", undefined)');
  const resumed=await call({action:'maintain',source:prepared.workspace.source,request:'Same request paraphrased by the model'});
  assert.equal(resumed.workspace.root,prepared.workspace.root,'a prepared candidate resumes its existing workflow rather than creating a nested copy');
  assert.equal(resumed.request,prepared.request,'the original user request remains authoritative');
  assert.equal((await call({action:'maintain',source:prepared.workspace.source})).request,prepared.request,'resuming does not require the user request to be repeated');
  assert.equal((await call({action:'update',source:prepared.workspace.source})).status,'ERROR','a candidate cannot silently change workflow mode');
  assert.match((await call({action:'maintain',source,request:'Unrelated task'})).message,/未完成任务/);
  const workflow=prepared.workspace.root,candidate=prepared.workspace.source;
  writeJson(workflow+'/result.json',{summary:'Fix double',decisions:[],checks:[{command:'node',args:['check.mjs'],reason:'double results for signed inputs'},{command:'node',args:['-e','process.exit(7)'],reason:'another affected failure'}]});
  const failures=await call({action:'verify',workflow});
  assert.equal(failures.status,'CHECK_FAILED');assert.deepEqual(failures.checks.filter(check=>check.code!==0).map(check=>check.code),[1,7],'one verification reports all selected failures');
  const result=JSON.parse(readFileSync(workflow+'/result.json'));result.checks.pop();result.decisions.push({id:'verification-repair',action:'adapt',reason:'Fix double and remove the unrelated failure'});writeJson(workflow+'/result.json',result);
  writeFileSync(candidate+'/value.mjs','export const double = n => n * 2;\n');
  const skill=readFileSync(candidate+'/skills/local/SKILL.md','utf8');
  writeFileSync(candidate+'/skills/local/SKILL.md',skill+'\n[New guide](<../../docs/guide.md> "Guide")\n`[example](inline-example.md)`\n~~~md\n[example](fenced-example.md)\n~~~\n[Web](https://example.invalid/guide) [Anchor](#details)\n');
  const missingReference=await call({action:'verify',workflow});
  assert.equal(missingReference.status,'CHECK_FAILED',JSON.stringify(missingReference));assert.equal(missingReference.code,'SKILL_REFERENCE_MISSING');assert.equal(missingReference.focus.id,'verification-repair');assert.equal(missingReference.nextCall.action,'save');
  assert.deepEqual(missingReference.references,[{file:'skills/local/SKILL.md',target:'../../docs/guide.md',resolved:'docs/guide.md'}]);
  mkdirSync(candidate+'/docs');writeFileSync(candidate+'/docs/guide.md','Required guide.\n');
  const previousKey=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='synthetic-verification-key';t.after(()=>{if(previousKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previousKey});
  writeFileSync(candidate+'/check.mjs',readFileSync(candidate+'/check.mjs','utf8')+"\nimport {existsSync,writeFileSync} from 'node:fs';import {join} from 'node:path';assert.notEqual(process.env.PI_CODING_AGENT_DIR,"+JSON.stringify(store.nativeDir)+");assert.equal(process.env.OPENAI_API_KEY,undefined);assert.equal(existsSync(join(process.env.PI_CODING_AGENT_DIR,'auth.json')),false);writeFileSync(join(process.env.PI_CODING_AGENT_DIR,'settings.json'),'{}');writeFileSync(join(process.env.HOME,'test-marker'),'test side effect');\n");
  assert.equal((await call({action:'verify',workflow})).status,'READY_TO_INSTALL');
  const environment=JSON.parse(readFileSync(workflow+'/verification.json')).checks.find(c=>c.reason==='double results for signed inputs').environment;
  assert.equal(readFileSync(environment+'/agent/settings.json','utf8'),'{}');
  assert.equal(readFileSync(environment+'/home/test-marker','utf8'),'test side effect');
  writeFileSync(candidate+'/value.mjs','export const double = n => n;\n');
  const stale=await call({action:'install',workflow,approved:true});assert.equal(stale.status,'ERROR');assert.match(stale.message,/stale/);
  assert.equal(readFileSync(source+'/value.mjs','utf8'),'export const double = n => n;\n');
  writeJson(pi+'/package.json',{name:'@earendil-works/pi-coding-agent',version:'1.4.0'});process.env.WARDROBE_PI_CLI=pi+'/dist/cli.js';
  assert.equal((await call({action:'verify',workflow})).code,'WORKFLOW_RUNTIME_CHANGED','a new runtime requires fresh preparation');
});

test('cancelling affected verification stops its process and invalidates the receipt',async t=>{
  const root=mkdtempSync(join(tmpdir(),'wardrobe-check-cancel-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const pi=join(root,'pi');mkdirSync(pi+'/dist',{recursive:true});writeJson(pi+'/package.json',{name:'@earendil-works/pi-coding-agent',version:'1.3.0'});writeFileSync(pi+'/dist/cli.js','');
  const previous=process.env.WARDROBE_PI_CLI;process.env.WARDROBE_PI_CLI=resolvePiRuntime().cliPath;t.after(()=>{if(previous===undefined)delete process.env.WARDROBE_PI_CLI;else process.env.WARDROBE_PI_CLI=previous});
  const source=join(root,'source');mkdirSync(source);writeJson(source+'/preset.json',{schemaVersion:1,id:'cancel/test',name:'Cancellation',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[]});writeJson(source+'/package.json',{name:'cancel',version:'1.0.0'});
  const store=new NativeStore(root+'/agent');let tool;registerWorkflowTool({registerTool:value=>tool=value,appendEntry(){}},store);
  const ctx={cwd:root},call=async(input,signal)=>(await tool.execute('test',input,signal,null,ctx)).details;
  const prepared=await call({action:'maintain',source,request:'Verify cancellation'});assert.equal(prepared.status,'REVIEW_REQUIRED',JSON.stringify(prepared));const workflow=prepared.workspace.root;
  writeJson(workflow+'/result.json',{summary:'Cancellation check',decisions:[],checks:[{command:'node',args:['-e','console.log(process.pid);setInterval(()=>{},1000)'],reason:'affected long-running process'}]});
  const controller=new AbortController(),pending=call({action:'verify',workflow},controller.signal);
  // Wait for the actual child, rather than cancelling before it was spawned.
  let log;const deadline=Date.now()+15000;
  while(!log){log=[0,1,2,3,4].map(i=>workflow+'/check-0-'+i+'.log').find(p=>existsSync(p)&&/^\d+\s*$/.test(readFileSync(p,'utf8')));assert.ok(Date.now()<deadline);if(!log)await new Promise(done=>setTimeout(done,10));}
  const pid=Number(readFileSync(log,'utf8').trim());controller.abort();
  assert.equal((await pending).status,'CANCELLED');
  assert.equal(JSON.parse(readFileSync(workflow+'/verification.json')).ok,false);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});


test('normalization preserves module entry extensions, excludes helpers and snapshots changed source separately',async t=>{
  const root=mkdtempSync(join(tmpdir(),'wardrobe-normalize-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,'legacy');mkdirSync(source+'/global/extensions',{recursive:true});
  execFileSync('git',['init','-q',source]);
  writeJson(source+'/manifest.json',{piVersion:'1.0.4',packages:[]});
  writeFileSync(source+'/global/extensions/feature.mjs','export default pi => pi.on("session_start",()=>{});\n');
  writeFileSync(source+'/global/extensions/helper.mjs','export const helper = 1;\n');
  writeFileSync(source+'/global/extensions/reexport.mjs','export { default } from "./feature.mjs";\n');
  const store=new NativeStore(root+'/agent'),first=await normalizePresetSource(store,source);
  assert.deepEqual(JSON.parse(readFileSync(first.source+'/package.json')).pi.extensions,['global/extensions/feature.mjs','global/extensions/reexport.mjs']);
  writeFileSync(source+'/global/extensions/feature.mjs','export default pi => pi.on("session_start",()=>{console.log("changed")});\n');
  const second=await normalizePresetSource(store,source);assert.notEqual(second.source,first.source);
  assert.match(readFileSync(second.source+'/global/extensions/feature.mjs','utf8'),/changed/);
  assert.doesNotMatch(readFileSync(first.source+'/global/extensions/feature.mjs','utf8'),/changed/);
});
