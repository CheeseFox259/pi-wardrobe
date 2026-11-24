import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { useHarness } from './support/harness.mjs';
import { NativeStore, writeJson } from '../packages/wardrobe/src/native-store.mjs';
import { registerWorkflowTool } from '../packages/wardrobe/src/workflow-tool.mjs';

const harness = useHarness('workflow-v2');

test('a structured maintain verifies the actual new dependency and exports, then promotes the same inactive artifact', async () => {
  const h = harness(), agent = 'single-batch', dir = h.sandbox.seedAgent(agent);
  await h.pi.runOk(agent, ['install', resolve('packages/wardrobe')]);
  await h.npmPackage('batch-runtime', ['1.0.0', '2.0.0'].map(version => ({
    version, exitCode: 0, pi: {}, manifest: { main: 'value.mjs' },
    extraFiles: { 'value.mjs': `export default ${JSON.stringify(version)};` },
  })));
  const source = join(h.sandbox.work, 'single-source');
  mkdirSync(join(source, 'skills/local'), { recursive: true });
  mkdirSync(join(source,'skills/private'),{recursive:true});writeFileSync(join(source,'skills/private/SKILL.md'),'---\nname: private\ndescription: Disabled capability\n---\nPrivate\n');
  writeJson(join(source, 'package.json'), { name: 'batch-preset', version: '1.0.0', type: 'module', dependencies: { 'batch-runtime': '1.0.0' }, pi: { skills: ['skills/local/SKILL.md','skills/private/SKILL.md'] } });
  writeJson(join(source, 'preset.json'), { schemaVersion: 1, id: 'batch/demo', name: 'Batch', version: '1.0.0', compatibility: { pi: '>=1.0.4' }, packages: { self: { source: '.' } }, resources: [{ package: 'self', kind: 'skills', include: ['skills/local/SKILL.md','skills/private/SKILL.md'],exclude:['skills/private/SKILL.md'] }] });
  writeJson(join(source, 'components.json'), { upstreams: { fixture: { repo: 'https://example.invalid/skills.git', pinnedRef: 'original' } }, skills: { local: { type: 'custom' } } });
  writeJson(join(source, 'manifest.json'), { piVersion: '0.0.1' });
  writeFileSync(join(source, 'skills/local/SKILL.md'), '---\nname: local\ndescription: Our local capability\n---\nKeep local work.\n');
  const previous = Object.fromEntries(['WARDROBE_PI_CLI', 'WARDROBE_REGISTRY', 'npm_config_registry'].map(k => [k, process.env[k]]));
  Object.assign(process.env, { WARDROBE_PI_CLI: h.runtime.cliPath, WARDROBE_REGISTRY: h.server.origin + '/npm/', npm_config_registry: h.server.origin + '/npm/' });
  try {
    const store = new NativeStore(dir); let tool;
    registerWorkflowTool({ registerTool(value) { tool = value; }, appendEntry() {} }, store);
    const call = async input => (await tool.execute('test', input, undefined, undefined, { cwd: h.sandbox.project })).details;
    const prepared = await call({ action: 'maintain', source, request: 'Add the status extension using runtime 2' });
    assert.equal(prepared.status, 'REVIEW_REQUIRED', JSON.stringify(prepared));
    assert.equal(prepared.protocolVersion, 3);
    const workflow = prepared.workspace.root, candidate = prepared.workspace.source;
    const pkg = JSON.parse(readFileSync(join(candidate, 'package.json')));
    pkg.dependencies['batch-runtime'] = '2.0.0'; writeJson(join(candidate, 'package.json'), pkg);
    mkdirSync(join(candidate, 'extensions'));
    writeFileSync(join(candidate, 'extensions/status.mjs'), "import version from 'batch-runtime'; import {getAgentDir} from '@earendil-works/pi-coding-agent'; import {existsSync} from 'node:fs'; export default pi => { if(!existsSync(getAgentDir()+'/settings.json'))throw Error('Pi agent context missing'); if (version !== '2.0.0') throw Error('old runtime'); pi.registerCommand('v2-status', { handler: async () => {} }); };\n");
    writeFileSync(join(candidate, 'affected.mjs'), "import assert from 'node:assert/strict'; import version from 'batch-runtime'; assert.equal(version, '2.0.0'); assert.equal(process.env.OPENAI_API_KEY, undefined);\n");
    mkdirSync(join(candidate,'skills/local-v2'));cpSync(join(candidate,'skills/local/SKILL.md'),join(candidate,'skills/local-v2/SKILL.md'));rmSync(join(candidate,'skills/local'),{recursive:true});
    const submission = { migrations:[{from:['skills/local/SKILL.md'],to:['skills/local-v2/SKILL.md'],reason:'Keep local capability under its new entry'}], summary: 'Add status with runtime 2', decisions: [], resources: [{action:'replace',package:'self',kind:'skills',oldPath:'skills/local/SKILL.md',path:'skills/local-v2/SKILL.md'}, { action: 'add', package: 'self', kind: 'extensions', path: 'extensions/status.mjs', enabled: true }], checks: [{ command: 'node', args: ['affected.mjs'], reason: 'New dependency API in actual candidate package' }] };
    const originalComponents = JSON.parse(readFileSync(join(candidate, 'components.json')));
    const tampered = structuredClone(originalComponents); tampered.upstreams.fixture.pinnedRef = 'invented'; delete tampered.skills; writeJson(join(candidate, 'components.json'), tampered);
    const verified = await call({ action: 'verify', workflow, batch: prepared.batch.id, revision: prepared.revision, submission });
    assert.equal(verified.status, 'READY_TO_INSTALL', JSON.stringify(verified));
    const restoredComponents = JSON.parse(readFileSync(join(candidate, 'components.json')));
    assert.equal(restoredComponents.upstreams.fixture.pinnedRef, originalComponents.upstreams.fixture.pinnedRef, 'the program restores its own lineage before verification');
    assert.equal(restoredComponents.skills.local.type, originalComponents.skills.local.type, 'deleting the whole skill lineage cannot remove program-owned entries');
    assert.equal(JSON.parse(readFileSync(join(candidate, 'manifest.json'))).piVersion, h.runtime.version, 'the program-owned runtime baseline advances to the actual Pi instead of reverting to the old base');
    assert.equal(existsSync(join(workflow, 'result.json')), false, 'structured submit does not need a model-authored result file');
    assert.equal(Object.keys(store.read().profiles).length, 0, 'verification does not register a preset');
    const markers = readFileSync(h.sandbox.markerLog, 'utf8');
    const installed = await call({ action: 'install', workflow, approved: true });
    assert.equal(installed.status, 'INSTALLED', JSON.stringify(installed));
    assert.ok(!store.read().profiles[installed.profile.id].selectedSkills.some(p=>p.endsWith('/private/SKILL.md')),'normalization preserves excluded exports');
    const moved=store.read().profiles[installed.profile.id].selectedSkills.find(p=>p.endsWith('/local-v2/SKILL.md'));assert.ok(moved);assert.equal(JSON.parse(readFileSync(join(moved,'../../..','components.json'))).skills.local.localPath,'skills/local-v2/SKILL.md');
    assert.equal(installed.active, false); assert.equal(store.read().default, null);
    assert.equal(readFileSync(h.sandbox.markerLog, 'utf8'), markers, 'promotion does not reinstall or rerun lifecycle scripts');
    assert.equal((await call({ action: 'install', workflow, approved: true })).profile.id, installed.profile.id);
    const selector=await h.pi.rpc(agent);
    try { await selector.command('wardrobe default '+installed.profile.id); } finally { await selector.close(); }
    const session = await h.pi.rpc(agent);
    try { const names=await session.commandNames();assert.ok(names.includes('v2-status'),JSON.stringify({names,stderr:session.stderr,settings:JSON.parse(readFileSync(join(store.read().profiles[installed.profile.id].agentDir,'settings.json')))})); } finally { await session.close(); }
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('affected checks resolve staged packages in an isolated agent without credentials', async () => {
  const h = harness(), dir = h.sandbox.seedAgent('check-dependencies'), source = join(h.sandbox.work, 'check-dependency-source');
  await h.npmPackage('staged-runtime', [{ version: '1.0.0', pi: { extensions: ['extension.mjs'] }, extraFiles: { 'extension.mjs': 'export default function extension() {}\n' } }]);
  mkdirSync(source);
  writeJson(join(source, 'package.json'), { name: 'check-dependencies', version: '1.0.0', type: 'module', pi: {} });
  writeJson(join(source, 'preset.json'), { schemaVersion: 1, id: 'check/dependencies', name: 'Check dependencies', version: '1.0.0', compatibility: { pi: '>=1.0.4' }, packages: { self: { source: '.' }, addon: { source: 'npm:staged-runtime@1.0.0' } }, resources: [{ package: 'addon', kind: 'extensions', include: ['extension.mjs'] }] });
  writeJson(join(source, 'manifest.json'), { piVersion: h.runtime.version });
  const previous = Object.fromEntries(['WARDROBE_PI_CLI', 'WARDROBE_REGISTRY', 'npm_config_registry'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { WARDROBE_PI_CLI: h.runtime.cliPath, WARDROBE_REGISTRY: h.server.origin + '/npm/', npm_config_registry: h.server.origin + '/npm/' });
  try {
    const store = new NativeStore(dir); let tool;
    registerWorkflowTool({ registerTool(value) { tool = value; }, appendEntry() {} }, store);
    const call = async input => (await tool.execute('test', input, undefined, undefined, { cwd: h.sandbox.project })).details;
    const prepared = await call({ action: 'maintain', source, request: 'Verify the actual staged dependency' });
    writeFileSync(join(prepared.workspace.source, 'check.mjs'), "import assert from 'node:assert/strict';import {existsSync} from 'node:fs';import {join} from 'node:path';const agent=process.env.PI_CODING_AGENT_DIR;assert.equal(existsSync(join(agent,'npm','node_modules','staged-runtime','extension.mjs')),true,'the isolated check must see the real staged package');assert.equal(existsSync(join(agent,'auth.json')),false,'credentials must stay absent');\n");
    const verified = await call({ action: 'verify', workflow: prepared.workspace.root, submission: { summary: 'Exercise staged package isolation', decisions: [], checks: [{ command: 'node', args: ['check.mjs'], reason: 'The affected check uses the actual dependency without credentials' }] } });
    assert.equal(verified.status, 'READY_TO_INSTALL', JSON.stringify(verified));
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('new original capabilities are installed by the program while an all-deferred review closes without an empty revision',async()=>{
  const h=harness(),dir=h.sandbox.seedAgent('new-capabilities'),source=join(h.sandbox.work,'new-cap-source');
  const skill=name=>`---\nname: ${name}\ndescription: ${name} capability\n---\nUse the ${name} workflow.\n`;
  const upstream=await h.gitRepo('new-cap-upstream',[{message:'base',files:{'README.md':'Skills\n'}},{message:'new capability',files:{'skills/new-feature/SKILL.md':skill('new-feature'),'skills/new-feature/guide.md':'A required companion.\n'}}]);
  const base=upstream.commits[0],target=upstream.commits[1],repo=upstream.sourceAt(base).slice(4).replace(/@[a-f0-9]{40}$/,'');
  mkdirSync(source);writeJson(join(source,'package.json'),{name:'new-cap',version:'1.0.0',pi:{}});
  writeJson(join(source,'preset.json'),{schemaVersion:1,id:'cap/demo',name:'Capabilities',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[]});
  writeJson(join(source,'manifest.json'),{piVersion:h.runtime.version});writeJson(join(source,'components.json'),{upstreams:{demo:{repo,pinnedRef:base}},skills:{}});
  const old=process.env.WARDROBE_PI_CLI;process.env.WARDROBE_PI_CLI=h.runtime.cliPath;
  try{
    const store=new NativeStore(dir);let tool;registerWorkflowTool({registerTool:t=>tool=t,appendEntry(){}},store);
    const call=async input=>(await tool.execute('t',input,undefined,undefined,{cwd:h.sandbox.project})).details;
    let step=await call({action:'update',source});const workflow=step.workspace.root;
    const progress=await call({action:'details',workflow});
    assert.ok(progress.items.length,'complete change list is available without a merge operation');
    assert.equal(step.batch.total,1,'related work can be submitted as one coherent batch');
    while(step.status==='REVIEW_REQUIRED')step=await call({action:'verify',workflow,batch:step.batch.id,revision:step.revision,submission:{summary:'Review and defer unchanged local environment',decisions:step.requiredDecisions.map(id=>({id,action:'defer',reason:'Not needed in this environment'})),checks:[]}});
    assert.equal(step.status,'REVIEWED',JSON.stringify(step));assert.equal(Object.keys(store.read().profiles).length,0);
    assert.equal((await call({action:'update',source})).status,'NO_UPDATE');
    const other=join(h.sandbox.work,'new-cap-adopt');cpSync(source,other,{recursive:true});
    writeJson(join(other,'preset.json'),{...JSON.parse(readFileSync(join(other,'preset.json'))),name:'Adopt the feature'});
    step=await call({action:'update',source:other});const adoptWorkflow=step.workspace.root;
    while(step.status==='REVIEW_REQUIRED')step=await call({action:'verify',workflow:adoptWorkflow,batch:step.batch.id,revision:step.revision,submission:{summary:'Adopt compatible original feature',decisions:step.requiredDecisions.map(id=>({id,action:'adopt',reason:'Original skill is native-tool independent and useful'})),checks:[]}});
    assert.equal(step.status,'READY_TO_INSTALL',JSON.stringify(step));
    const installed=await call({action:'install',workflow:adoptWorkflow,approved:true});assert.equal(installed.status,'INSTALLED',JSON.stringify(installed));
    const path=store.read().profiles[installed.profile.id].selectedSkills.find(p=>p.endsWith('/new-feature/SKILL.md'));assert.ok(path,'adopted original is selected and exported');
    assert.equal(readFileSync(join(path,'../guide.md'),'utf8'),'A required companion.\n');
    const lineage=JSON.parse(readFileSync(join(path,'../../..','components.json'))).skills['new-feature'];assert.equal(lineage.baseRef,target);assert.equal(lineage.upstreamRepo,repo);
  }finally{if(old===undefined)delete process.env.WARDROBE_PI_CLI;else process.env.WARDROBE_PI_CLI=old;}
});

test('update saves independent decisions, preserves companion moves and checks the final candidate against saved evidence', async () => {
  const h=harness(),dir=h.sandbox.seedAgent('batch-update'),source=join(h.sandbox.work,'update-source');
  const skill=name=>`---\nname: ${name}\ndescription: ${name} workflow\n---\n`;
  const upstream=await h.gitRepo('batch-upstream',[
    {message:'base',files:{'skills/alpha/SKILL.md':skill('alpha')+'old alpha\n','skills/beta/SKILL.md':skill('beta')+'old beta\n'}},
    {message:'target',files:{'skills/alpha/SKILL.md':skill('alpha')+'new alpha\n','skills/beta/SKILL.md':skill('beta')+'new beta\n'}},
  ]);
  const base=upstream.commits[0],target=upstream.commits[1],repo=upstream.sourceAt(base).slice(4).replace(/@[a-f0-9]{40}$/,'');
  for(const name of ['alpha','beta','maintain'])mkdirSync(join(source,'skills',name),{recursive:true});
  writeJson(join(source,'package.json'),{name:'batch-update',version:'1.0.0',type:'module',pi:{skills:['skills/alpha/SKILL.md','skills/beta/SKILL.md','skills/maintain/SKILL.md']}});
  writeJson(join(source,'preset.json'),{schemaVersion:1,id:'batch/update',name:'Update',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[{package:'self',kind:'skills',include:['skills/alpha/SKILL.md','skills/beta/SKILL.md','skills/maintain/SKILL.md']}]});
  writeJson(join(source,'manifest.json'),{piVersion:h.runtime.version});
  writeJson(join(source,'components.json'),{upstreams:{demo:{repo,pinnedRef:base}},skills:{alpha:{type:'override',upstream:'demo',baseRef:base,localPath:'skills/alpha/SKILL.md',upstreamRelPath:'skills/alpha/SKILL.md',preservedFeatures:['local alpha']},beta:{type:'override',upstream:'demo',baseRef:base,localPath:'skills/beta/SKILL.md',upstreamRelPath:'skills/beta/SKILL.md'},maintain:{type:'custom',localPath:'skills/maintain/SKILL.md'}}});
  writeFileSync(join(source,'skills/alpha/SKILL.md'),skill('alpha')+'old alpha\nlocal alpha\n');
  writeFileSync(join(source,'skills/beta/SKILL.md'),skill('beta')+'old beta\n');
  writeFileSync(join(source,'skills/maintain/SKILL.md'),skill('maintain')+'[Upstream updates](reference.md)\n');
  writeFileSync(join(source,'skills/maintain/reference.md'),'Update integration instructions.\n');
  const old=process.env.WARDROBE_PI_CLI;process.env.WARDROBE_PI_CLI=h.runtime.cliPath;
  try{
    const store=new NativeStore(dir);let tool;registerWorkflowTool({registerTool:v=>tool=v,appendEntry(){}},store);
    const call=async input=>(await tool.execute('test',input,undefined,undefined,{cwd:h.sandbox.project})).details;
    let step=await call({action:'update',source});assert.deepEqual(step.requiredDecisions,['skill:alpha','skill:beta']);
    const workflow=step.workspace.root,candidate=step.workspace.source;
    const frozen=step.decisions[0].review.upstream,bytes=readFileSync(frozen);writeFileSync(frozen,'damaged input');
    assert.equal((await call({action:'details',workflow})).code,'WORKFLOW_INPUT_CHANGED');writeFileSync(frozen,bytes);
    mkdirSync(join(workflow,'.workflow-lock'));
    assert.equal((await call({action:'details',workflow})).batch.id,step.batch.id,'orphan lock can be resumed');
    assert.match(readFileSync(join(candidate,'skills/beta/SKILL.md'),'utf8'),/new beta/,'safe incoming changes are available together');
    assert.ok(step.releaseNotes.length,'exact upstream release channels accompany the batch');
    writeFileSync(join(candidate,'skills/alpha/SKILL.md'),skill('alpha')+'new alpha\nlocal alpha\n');
    mkdirSync(join(candidate,'skills/update'));writeFileSync(join(candidate,'skills/update/SKILL.md'),skill('update')+'[Process](reference.md)\n');
    writeFileSync(join(candidate,'skills/update/reference.md'),readFileSync(join(candidate,'skills/maintain/reference.md')));rmSync(join(candidate,'skills/maintain/reference.md'));
    writeFileSync(join(candidate,'skills/maintain/SKILL.md'),skill('maintain')+'Handle requested fixes. See [update](../update/SKILL.md).\n');
    writeFileSync(join(candidate,'check-alpha.mjs'),"import assert from 'node:assert/strict';import {readFileSync,appendFileSync} from 'node:fs';const s=readFileSync('skills/alpha/SKILL.md','utf8');assert.match(s,/new alpha/);assert.match(s,/local alpha/);\n");
    const submit={summary:'Adapt alpha and preserve split maintenance guidance',decisions:[{id:'skill:alpha',action:'adapt',reason:'Keep local alpha with the new method'}],resources:[{action:'add',package:'self',kind:'skills',path:'skills/update/SKILL.md'}],migrations:[{from:['skills/maintain/reference.md'],to:['skills/update/reference.md'],reason:'Updates move to their dedicated skill; maintain still handles fixes'}],checks:[{command:'node',args:['check-alpha.mjs'],reason:'New alpha plus preserved local method'}]};
    step=await call({action:'save',workflow,submission:submit});
    assert.equal(step.status,'REVIEW_REQUIRED',JSON.stringify(step));assert.equal(step.saved.decisions[0].id,'skill:alpha');
    assert.match(readFileSync(join(candidate,'skills/beta/SKILL.md'),'utf8'),/new beta/);
    const resumed=await call({action:'update',source:candidate});assert.equal(resumed.revision,step.revision);assert.equal(resumed.saved.decisions[0].id,'skill:alpha');
    const defer={summary:'Retain beta for now',decisions:[{id:'skill:beta',action:'defer',reason:'Local workflow needs the old behavior'}],checks:[]};
    writeFileSync(join(candidate,'skills/alpha/SKILL.md'),skill('alpha')+'broken alpha\n');
    const invalid=await call({action:'verify',workflow,batch:step.batch.id,revision:step.revision,submission:defer});
    assert.equal(invalid.status,'CHECK_FAILED',JSON.stringify(invalid));
    assert.ok(invalid.checks.some(c=>c.reason==='New alpha plus preserved local method'&&c.code!==0),'later changes invalidate affected earlier behavior evidence');
    writeFileSync(join(candidate,'skills/alpha/SKILL.md'),skill('alpha')+'new alpha\nlocal alpha\n');
    await call({action:'save',workflow,submission:{...defer,decisions:[...defer.decisions,{id:'verification-repair',action:'adapt',reason:'Restore new alpha with the preserved local method'}]}});
    step=await call({action:'verify',workflow});
    assert.equal(step.status,'READY_TO_INSTALL',JSON.stringify(step));
    assert.match(readFileSync(join(candidate,'skills/beta/SKILL.md'),'utf8'),/old beta/,'defer restores safe pre-application');
    const installed=await call({action:'install',workflow,approved:true});assert.equal(installed.status,'INSTALLED',JSON.stringify(installed));
    const profile=store.read().profiles[installed.profile.id],beta=profile.selectedSkills.find(p=>p.endsWith('/beta/SKILL.md'));
    const components=JSON.parse(readFileSync(join(beta,'../../..','components.json')));
    assert.equal(components.skills.alpha.baseRef,target);assert.equal(components.skills.beta.baseRef,base);
    const next=await call({action:'update',profile:profile.id});assert.equal(next.status,'NO_UPDATE',JSON.stringify(next));assert.equal(next.modelRequired,false);
    assert.equal(profile.parent,null);assert.equal(store.read().default,null);
    const mergedSource=join(h.sandbox.work,'merged-update');cpSync(source,mergedSource,{recursive:true});
    let merged=await call({action:'update',source:mergedSource});const mergedRoot=merged.workspace.root;
    assert.deepEqual(merged.requiredDecisions,['skill:alpha','skill:beta']);
    const combined={summary:'Adopt original alpha; retain beta',decisions:[{id:'skill:alpha',action:'adopt',reason:'Original method is now sufficient'},{id:'skill:beta',action:'defer',reason:'Retain current beta'}],checks:[]};
    merged=await call({action:'verify',workflow:mergedRoot,batch:merged.batch.id,revision:merged.revision,submission:combined});
    assert.equal(merged.status,'READY_TO_INSTALL',JSON.stringify(merged));
    assert.match(readFileSync(join(merged.workspace.source,'skills/alpha/SKILL.md'),'utf8'),/new alpha/);
    assert.doesNotMatch(readFileSync(join(merged.workspace.source,'skills/alpha/SKILL.md'),'utf8'),/local alpha/,'adopt copies the original incoming version');
    assert.match(readFileSync(join(merged.workspace.source,'skills/beta/SKILL.md'),'utf8'),/old beta/,'partial defer restores its own pre-applied files');
    const local=join(h.sandbox.work,'changed-deferred');
    cpSync(join(beta,'../../..'),local,{recursive:true,filter:p=>!['.git','node_modules'].includes(p.split('/').at(-1))});
    writeFileSync(join(local,'skills/beta/SKILL.md'),skill('beta')+'old beta\nchanged local behavior\n');
    const reconsider=await call({action:'update',source:local});assert.equal(reconsider.status,'REVIEW_REQUIRED',JSON.stringify(reconsider));assert.ok(reconsider.requiredDecisions.includes('skill:beta'),'local change invalidates a previous defer receipt');
  }finally{if(old===undefined)delete process.env.WARDROBE_PI_CLI;else process.env.WARDROBE_PI_CLI=old;}
});
