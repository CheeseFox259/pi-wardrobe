import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { useHarness } from './support/harness.mjs';

const harness = useHarness('native-maintenance');

test('model import reviews legacy source without waiting for a modal, then installs on explicit authorization',async()=>{
  const h=harness(),dir=h.sandbox.seedAgent('model-import'),legacy=join(h.sandbox.work,'legacy');
  await h.pi.runOk('model-import',['install',resolve('packages/wardrobe')]);
  mkdirSync(join(legacy,'global/extensions'),{recursive:true});
  writeFileSync(join(legacy,'manifest.json'),JSON.stringify({name:'Legacy',piVersion:'1.0.4',packages:[]}));
  writeFileSync(join(legacy,'global/extensions/legacy.mjs'),'export default pi=>pi.registerCommand("legacy-imported",{handler:async()=>{}});');
  const {NativeStore}=await import('../packages/wardrobe/src/native-store.mjs');
  const {registerWorkflowTool}=await import('../packages/wardrobe/src/workflow-tool.mjs');
  let tool;registerWorkflowTool({registerTool:value=>tool=value,appendEntry(){}},new NativeStore(dir));
  const previous=process.env.WARDROBE_PI_CLI;process.env.WARDROBE_PI_CLI=h.runtime.cliPath;
  try{
    const call=async approved=>JSON.parse((await tool.execute('import',{action:'import',source:legacy,approved},null,null,{cwd:h.sandbox.project,ui:{confirm(){throw Error('Model tool must not open a modal')}}})).content[0].text);
    const review=await call(false);assert.equal(review.status,'APPROVAL_REQUIRED',JSON.stringify(review));assert.match(review.review,/Legacy.*1.0.0/s);
    const installed=await call(true);assert.equal(installed.status,'IMPORTED',JSON.stringify(installed));
    const store=new NativeStore(dir),config=store.read(),profile=config.profiles[installed.profile.id];assert.equal(profile.compatibility.pi,'>=1.0.4');
    store.save({...config,initialized:true,default:profile.id});
    const session=await h.pi.rpc('model-import');
    try{assert.ok((await session.commandNames()).includes('legacy-imported'));}finally{await session.close();}
  }finally{if(previous===undefined)delete process.env.WARDROBE_PI_CLI;else process.env.WARDROBE_PI_CLI=previous;}
});

test('an updated npm preset installs its new self package even when external dependencies are unchanged',async()=>{
  const h=harness(),dir=h.sandbox.seedAgent('npm-preset-update');
  await h.npmPackage('stable-addon',[
    {version:'1.0.0',exitCode:0,pi:{},extraFiles:{'README.md':'Old addon capability.\n'}},
    {version:'1.0.1',exitCode:17,pi:{},extraFiles:{'CHANGELOG.md':'## [1.0.1]\nNew addon capability.\n\n## [1.0.0]\nOld baseline release.\n','README.md':'Old addon capability and a new feature.\n'}},
  ]);
  const pkg=await h.npmPackage('reuse-preset',['1.0.0','1.0.1'].map(version=>({version,exitCode:0,pi:{extensions:['entry.mjs']},extraFiles:{
    'entry.mjs':`export default pi=>pi.registerCommand('version-${version}',{handler:async()=>{}});`,
    'preset.json':JSON.stringify({schemaVersion:1,id:'reuse/preset',name:'Reuse preset',version,compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'},addon:{source:'npm:stable-addon@1.0.0'}},resources:[{package:'self',kind:'extensions',include:['entry.mjs']}]}),
  }})));
  const {NativeStore}=await import('../packages/wardrobe/src/native-store.mjs');
  const {reviewNativeImport,installNativePlan}=await import('../packages/wardrobe/src/native-service.mjs');
  const store=new NativeStore(dir),previous={cli:process.env.WARDROBE_PI_CLI,registry:process.env.WARDROBE_REGISTRY,npm:process.env.npm_config_registry};
  process.env.WARDROBE_PI_CLI=h.runtime.cliPath;process.env.WARDROBE_REGISTRY=h.server.origin+'/npm/';process.env.npm_config_registry=h.server.origin+'/npm/';
  try{
    const first=await reviewNativeImport(store,pkg.sourceAt('1.0.0'));
    const parent=await installNativePlan(store,first.plan,{source:first.source});
    const next=await reviewNativeImport(store,pkg.sourceAt('1.0.1'));
    const updated=await installNativePlan(store,next.plan,{source:next.source,parent:parent.id});
    assert.equal(updated.version,'1.0.1');
    assert.match(readFileSync(updated.resources.find(r=>r.path.endsWith('/entry.mjs')).path,'utf8'),/version-1.0.1/);
    assert.match(readFileSync(parent.resources.find(r=>r.path.endsWith('/entry.mjs')).path,'utf8'),/version-1.0.0/);
    const {beginWorkflow}=await import('../packages/wardrobe/src/native-workflow.mjs');
    const marker=readFileSync(h.sandbox.markerLog,'utf8');
    const update=await beginWorkflow(store,{profile:updated,mode:'update'});
    assert.equal(update.status,'REVIEW_REQUIRED');
    const notes=update.releaseNotes.find(n=>n.id==='package:stable-addon');assert.equal(notes.status,'READY',JSON.stringify(notes));
    const text=readFileSync(notes.path,'utf8');assert.match(text,/New addon capability/);assert.doesNotMatch(text,/Old baseline release/);
    assert.equal(readFileSync(h.sandbox.markerLog,'utf8'),marker,'reading release notes never runs package scripts');
    const {lookupResource}=await import('../packages/wardrobe/src/resource-lookup.mjs');
    const found=await lookupResource(store,'npm:stable-addon@1.0.1',{...process.env,WARDROBE_REGISTRY:h.server.origin+'/npm/'});
    assert.equal(found.status,'RESOURCE_DOCUMENTS');assert.ok(found.documents.some(p=>p.endsWith('/CHANGELOG.md')));
    assert.equal(readFileSync(h.sandbox.markerLog,'utf8'),marker,'new resource documentation lookup never runs package scripts');
  }finally{
    for(const [key,value] of [['WARDROBE_PI_CLI',previous.cli],['WARDROBE_REGISTRY',previous.registry],['npm_config_registry',previous.npm]])if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
});

test('maintenance of the original keeps native package boundaries and incompatible dependency versions', async () => {
  const h = harness(), agent = 'package-boundaries'; h.sandbox.seedAgent(agent);
  mkdirSync(join(h.agentPath(agent), 'skills/local'), { recursive: true });
  writeFileSync(join(h.agentPath(agent), 'skills/local/SKILL.md'), '---\nname: local\ndescription: Local custom skill\n---\nPreserve this skill.\n');
  writeFileSync(join(h.agentPath(agent), 'sol-pi.json'), '{"actionFusion":true}');
  await h.npmPackage('shared-runtime', ['1.0.0', '2.0.0'].map(version => ({ version, exitCode: 0, pi: {}, manifest: { main: 'value.mjs' }, extraFiles: { 'value.mjs': `export default '${version}';` } })));
  for (const [name, version] of [['first-extension', '1.0.0'], ['second-extension', '2.0.0']]) {
    const pkg = await h.npmPackage(name, [{ version: '1.0.0', exitCode: 0, manifest: { dependencies: { 'shared-runtime': version } }, pi: { extensions: ['extension.mjs'], skills: ['skills/package/SKILL.md'] }, extraFiles: { 'extension.mjs': `import value from 'shared-runtime';export default pi=>pi.registerCommand('${name}',{handler:async(_args,ctx)=>ctx.ui.notify(value,'info')});`, 'skills/package/SKILL.md': `---\nname: ${name}-skill\ndescription: Packaged skill\n---\nNative package workflow.\n` } }]);
    await h.pi.runOk(agent, ['install', pkg.sourceAt('1.0.0')]);
  }
  await h.pi.runOk(agent, ['install', resolve('packages/wardrobe')]);
  const session = await h.pi.rpc(agent, { extraEnv: { WARDROBE_REGISTRY: `${h.server.origin}/npm/` } });
  const latest = async () => (await session.readCustomEntries('wardrobe.native-result')).at(-1)?.data;
  try {
    await session.command('wardrobe adopt --yes');
    await session.command('wardrobe maintain original --prepare --request '+JSON.stringify('Preserve package boundaries in a new revision'));
    const result = await latest();
    assert.equal(result.status, 'REVIEW_REQUIRED', JSON.stringify(result));
    const definition = JSON.parse(readFileSync(join(result.workspace.source, 'preset.json')));
    assert.deepEqual(Object.values(definition.packages).map(item => item.source).sort(), ['.', 'npm:first-extension@1.0.0', 'npm:second-extension@1.0.0']);
    assert.equal(JSON.parse(readFileSync(join(result.workspace.source, 'package.json'))).dependencies?.['shared-runtime'], undefined);
    const customSkills = JSON.parse(readFileSync(join(result.workspace.root, 'inventory.json'))).customSkills;
    assert.deepEqual(Object.values(customSkills).map(skill => skill.localPath), ['skills/local/SKILL.md']);
    writeFileSync(join(result.workspace.source,'skills/local/SKILL.md'),readFileSync(join(result.workspace.source,'skills/local/SKILL.md'),'utf8')+'\nUse the native package boundaries.\n');
    writeResult(result.workspace.root,'Preserve package boundaries');
    await session.command('wardrobe maintain original --verify');
    assert.equal((await latest()).status,'READY_TO_INSTALL',JSON.stringify(await latest()));
    await session.command('wardrobe maintain original --apply --yes');
    assert.equal((await latest()).status, 'INSTALLED', JSON.stringify(await latest()));
    const profile = JSON.parse(readFileSync(join(h.agentPath(agent),'wardrobe/native.json'))).profiles[(await latest()).profile.id];
    const { NativeStore } = await import('../packages/wardrobe/src/native-store.mjs');
    const { prepareDeviceBindings } = await import('../packages/wardrobe/src/native-bindings.mjs');
    assert.doesNotThrow(() => prepareDeviceBindings(new NativeStore(h.agentPath(agent)), profile));
    assert.equal(readFileSync(join(profile.agentDir, 'sol-pi.json'), 'utf8'), '{"actionFusion":true}');
    const installed = await h.pi.rpc(agent, { extraEnv: { WARDROBE_NATIVE_PROFILE: profile.id } });
    try {
      assert.ok((await installed.commandNames()).includes('first-extension'));
      assert.ok((await installed.commandNames()).includes('second-extension'));
    } finally { await installed.close(); }
  } finally { await session.close(); }
});

test('preset maintenance retains custom skills and companions in a new recoverable revision', async () => {
  const h = harness(), agent = 'maintenance'; h.sandbox.seedAgent(agent);
  await h.pi.runOk(agent, ['install', resolve('packages/wardrobe')]);
  const originalSkill = '---\nname: adapted\ndescription: Pi adapted skill\n---\nUse native Pi tools.\n';
  const customSkill = '---\nname: custom\ndescription: Our custom skill\n---\nKeep our workflow.\n';
  const repo = await h.gitRepo('maintenance', [{ message: 'source', files: {
    'package.json': JSON.stringify({ name: 'maintenance', version: '1.0.0', pi: { skills: ['skills'] } }),
    'preset.json': JSON.stringify({ schemaVersion: 1, id: 'maintenance/demo', name: 'Maintenance Demo', version: '1.0.0', compatibility: { pi: h.runtime.version }, packages: { self: { source: '.' } }, resources: [{ package: 'self', kind: 'skills', include: ['skills/adapted/SKILL.md', 'skills/custom/SKILL.md'] }] }),
    'skills/adapted/SKILL.md': originalSkill,
    'skills/adapted/REFERENCE.md': 'Keep the Pi companion.\n',
    'skills/custom/SKILL.md': customSkill,
    'components.json': JSON.stringify({ skills: { custom: { type: 'custom' }, adapted: { type: 'override', baseRef: 'recorded-base', preservedFeatures: ['Pi tools'] } } }),
  } }]);
  const session = await h.pi.rpc(agent);
  const latest = async () => (await session.readCustomEntries('wardrobe.native-result')).at(-1)?.data;
  try {
    await session.command('wardrobe adopt --yes');
    await session.command(`wardrobe import ${repo.sourceAt(repo.commits[0])} --yes`);
    const original = (await latest()).profile;
    assert.ok(original, JSON.stringify(await latest()));
    rmSync(repo.root, { recursive: true, force: true });
    await session.command(`wardrobe maintain ${original.id} --prepare --request "Adapt the workflow while preserving custom behavior"`);
    const prepared = await latest();
    assert.equal(prepared.status, 'REVIEW_REQUIRED', JSON.stringify(prepared));
    const { workspace } = prepared;
    assert.equal(readFileSync(join(workspace.source, 'skills/custom/SKILL.md'), 'utf8'), customSkill);
    assert.equal(readFileSync(join(workspace.source, 'skills/adapted/REFERENCE.md'), 'utf8'), 'Keep the Pi companion.\n');
    assert.equal(JSON.parse(readFileSync(join(workspace.source, 'components.json'))).skills.adapted.baseRef, 'recorded-base');
    assert.doesNotMatch(workspace.source, /staging/);
    writeFileSync(join(workspace.source, 'skills/adapted/SKILL.md'), originalSkill + 'New upstream methodology.\n');
    await session.command(`wardrobe maintain ${original.id} --prepare --request "Adapt the workflow while preserving custom behavior"`);
    assert.match(readFileSync(join(workspace.source, 'skills/adapted/SKILL.md'), 'utf8'), /New upstream methodology/);
    rmSync(join(workspace.source, 'skills/custom/SKILL.md'));
    writeResult(workspace.root,'Preserve custom workflow');
    await session.command(`wardrobe maintain ${original.id} --verify`);
    assert.match((await latest()).error, /自定义技能/);
    writeFileSync(join(workspace.source, 'skills/custom/SKILL.md'), customSkill);
    writeResult(workspace.root,'Restore the required custom skill',[{id:'verification-repair',action:'adapt',reason:'Restored the required custom skill'}]);
    writeFileSync(join(workspace.source, 'skills/adapted/SKILL.md'), originalSkill + '<<<<<<< local\nUnresolved change\n>>>>>>> upstream\n');
    await session.command(`wardrobe maintain ${original.id} --verify`);
    assert.match((await latest()).error, /冲突/, JSON.stringify(await latest()));
    writeFileSync(join(workspace.source, 'skills/adapted/SKILL.md'), originalSkill + 'New upstream methodology.\n');
    writeResult(workspace.root,'Preserve Pi tools, custom skill and companion',[{id:'verification-repair',action:'adapt',reason:'Resolved the merge conflict and preserved the custom skill'}]);
    await session.command(`wardrobe maintain ${original.id} --verify`);
    assert.equal((await latest()).status,'READY_TO_INSTALL',JSON.stringify(await latest()));
    await session.command(`wardrobe maintain ${original.id} --apply --yes`);
    const result = await latest();
    const failed = !result.ok && readdirSync(join(h.agentPath(agent), 'wardrobe/staging')).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(h.agentPath(agent), 'wardrobe/staging', name))).attempts.at(-1).failure);
    assert.equal(result.status, 'INSTALLED', JSON.stringify({ result, failed }));
    assert.equal(result.status, 'INSTALLED');
    result.profile=JSON.parse(readFileSync(join(h.agentPath(agent),'wardrobe/native.json'))).profiles[result.profile.id];
    assert.equal(result.profile.kind, 'derivative');
    assert.equal(result.profile.parent, original.id);
    assert.equal(result.active, false);
    assert.equal(result.profile.maintenance.upstream.locator, original.source.locator);
    const skillPath = result.profile.selectedSkills.find(path => path.endsWith('adapted/SKILL.md'));
    assert.match(readFileSync(skillPath, 'utf8'), /Use native Pi tools\.[\s\S]*New upstream methodology/);
    assert.equal(readFileSync(join(skillPath, '../REFERENCE.md'), 'utf8'), 'Keep the Pi companion.\n');
    assert.equal(readFileSync(result.profile.selectedSkills.find(path => path.endsWith('custom/SKILL.md')), 'utf8'), customSkill);
    assert.equal(readFileSync(original.selectedSkills.find(path => path.endsWith('adapted/SKILL.md')), 'utf8'), originalSkill);
    const configPath = join(h.agentPath(agent), 'wardrobe/native.json');
    assert.equal(JSON.parse(readFileSync(configPath)).default, 'original');
    assert.equal(result.profile.source.commit,original.source.commit,'a local revision retains its upstream commit, not its installation snapshot commit');
    const count=Object.keys(JSON.parse(readFileSync(configPath)).profiles).length;
    await session.command(`wardrobe maintain ${original.id} --apply --yes`);
    assert.equal((await latest()).profile.id,result.profile.id,'install retries return the original receipt');
    assert.equal(Object.keys(JSON.parse(readFileSync(configPath)).profiles).length,count);
    await session.command(`wardrobe maintain ${original.id} --prepare --request "A different focused request"`);
    const fresh=await latest();
    assert.equal(fresh.status,'REVIEW_REQUIRED',JSON.stringify(fresh));
    assert.notEqual(fresh.workspace.root,workspace.root);
    assert.equal(readFileSync(join(fresh.workspace.source,'skills/adapted/SKILL.md'),'utf8'),originalSkill,'new tasks start from the selected installed revision');
    assert.match(readFileSync(join(workspace.source,'skills/adapted/SKILL.md'),'utf8'),/New upstream methodology/,'previous evidence remains intact');
    await session.command(`wardrobe upgrade ${result.profile.id} --yes`);
    assert.equal((await latest()).state, 'native-update');
    rmSync(result.profile.agentDir, { recursive: true, force: true });
    await session.command(`wardrobe repair ${result.profile.id} --yes`);
    const repaired = await latest();
    assert.equal(repaired.ok, true, JSON.stringify(repaired));
    assert.equal(repaired.state, 'repaired');
    assert.equal(repaired.profile.maintenance.base, original.id);
    assert.ok(existsSync(join(repaired.profile.agentDir, 'settings.json')));
  } finally { await session.close(); }
});

function writeResult(root,summary,decisions=[]){writeFileSync(join(root,'result.json'),JSON.stringify({summary,decisions,checks:[{command:'node',args:['-e',"const fs=require('node:fs');JSON.parse(fs.readFileSync('preset.json'));JSON.parse(fs.readFileSync('package.json'));"],reason:'modified declaration remains readable; installed behavior checked by native RPC'}]}));}
