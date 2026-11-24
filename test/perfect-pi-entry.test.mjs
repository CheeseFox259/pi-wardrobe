import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { useHarness, launchEnv } from './support/harness.mjs';
import pty from 'node-pty';
import { RpcSession } from '../fixtures/lib/pi-runner.mjs';
import { serveLocalSource } from '../scripts/serve-local-source.mjs';

const harness = useHarness('perfect-pi-entry');
const entry = resolve('scripts/perfect-pi.mjs');
const presetPath = 'presets/perfect-pi/preset.json';

test('retired configuration options are refused before setup in both CLI forms', async () => {
  const h = harness();
  for (const option of ['--config', '--config=private-file', '--replace', '--replace=true']) {
    const result = await h.sandbox.runner.run(process.execPath, [entry, 'setup', option], { cwd: h.sandbox.project, env: launchEnv(h) });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /模型与认证由 Pi 管理/);
  }
});

async function sourceFor(h, name) {
  const files = {
    'package.json': JSON.stringify({ name: 'fixture-workspace', version: '1.0.0' }),
    [presetPath]: JSON.stringify({ schemaVersion: 1, id: 'perfect-pi/full', name: 'Perfect Pi Entry Fixture', version: '1.0.0', compatibility: { pi: h.runtime.version }, packages: { self: { source: '.' } }, resources: [{ package: 'self', kind: 'skills', include: ['skills/entry-fixture/SKILL.md'] }] }),
    'presets/perfect-pi/package.json': JSON.stringify({ name: 'perfect-pi-entry-fixture', version: '1.0.0', pi: { skills: ['skills/entry-fixture/SKILL.md'] }, wardrobe: { agent: { schemaVersion: 1, files: [{ source: 'manifest.json', target: 'manifest.json' }] } } }),
    'presets/perfect-pi/manifest.json': JSON.stringify({ schemaVersion: 1 }),
    'presets/perfect-pi/skills/entry-fixture/SKILL.md': '---\nname: entry-fixture\ndescription: Public entry fixture\n---\nUse the fixture.\n',
  };
  const collect = dir => { for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) collect(path); else if ((/\.(mjs|ts)$/.test(e.name))) files[path] = readFileSync(path);
  } };
  collect('packages/wardrobe'); collect('scripts');
  for (const path of ['presets/perfect-pi/scripts/pi-runtime.mjs']) files[path] = readFileSync(path);
  const repo = await h.gitRepo(name, [{ message: 'approved Perfect Pi entry fixture', files }]);
  return repo.sourceAt(repo.commits[0]);
}

test('setup presents an approval plan without installing when input is not a terminal', async () => {
  const h = harness(), source = await sourceFor(h, 'entry-review');
  const agentDir = join(h.sandbox.root, 'new manager with spaces');
  const result = await h.sandbox.runner.run(process.execPath, [entry, 'setup', '--source', source, '--agent-dir', agentDir], {
    cwd: h.sandbox.project, env: launchEnv(h),
  });
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stdout, /Perfect Pi Entry Fixture/);
  assert.match(result.stdout, /digest: [a-f0-9]{64}/);
  assert.match(result.stderr, /--confirm/);
  const staging = join(agentDir, 'wardrobe/staging');
  assert.equal(existsSync(staging) && readdirSync(staging).length > 0, false);
});

test('one approved setup creates a working daily launcher and repeated setup reuses it', async () => {
  const h = harness(), source = await sourceFor(h, 'entry-install');
  const agentDir = join(h.sandbox.root, 'entry install'), binDir = join(h.sandbox.root, "bin with spaces and 'quote");
  const args = [entry, 'setup', '--source', source, '--agent-dir', agentDir, '--bin-dir', binDir];
  const env = launchEnv(h);
  const review = await h.sandbox.runner.run(process.execPath, args, { cwd: h.sandbox.project, env });
  const digest = review.stdout.match(/digest: ([a-f0-9]{64})/)?.[1];
  assert.ok(digest, review.stderr);
  const installed = await h.sandbox.runner.run(process.execPath, [...args, '--confirm', digest], { cwd: h.sandbox.project, env });
  assert.equal(installed.code, 0, installed.stderr);
  assert.match(installed.stdout, /安装完成/);
  const project = join(h.sandbox.root, 'other project'); mkdirSync(project);
  const independentEnv = { ...env }; delete independentEnv.WARDROBE_AGENT_DIR; delete independentEnv.WARDROBE_PI_CLI;
  const wrapper = join(binDir, 'perfect-pi');
  const launch = await h.sandbox.runner.run(wrapper, ['--offline', '--version'], { cwd: project, env: independentEnv });
  assert.equal(launch.code, 0, launch.stderr); assert.equal(launch.stdout.trim(), h.runtime.version);
  const doctor = await h.sandbox.runner.run(wrapper, ['doctor'], { cwd: project, env: independentEnv });
  assert.equal(doctor.code, 0, doctor.stderr); assert.match(doctor.stdout, /available/);
  const repeat = await h.sandbox.runner.run(process.execPath, [entry, 'setup', '--agent-dir', agentDir], { cwd: project, env: independentEnv });
  assert.equal(repeat.code, 0, repeat.stderr); assert.match(repeat.stdout, /已有安装/);
  assert.equal(readdirSync(join(agentDir, 'wardrobe/staging')).filter(name => name.endsWith('.json')).length, 1);
  unlinkSync(wrapper);
  const repaired = await h.sandbox.runner.run(process.execPath, [entry, 'setup', '--agent-dir', agentDir], { cwd: project, env: independentEnv });
  assert.equal(repaired.code, 0, repaired.stderr); assert.equal(existsSync(wrapper), true, 'setup repairs a removed owned entry');
  assert.equal(existsSync(join(h.sandbox.home, '.config/pi-wardrobe/perfect-pi/models.json')), false, 'setup must not create a model configuration');
  assert.doesNotMatch(installed.stdout, /CPA|models.json|perfect-pi config/);
  const unsupported = await h.sandbox.runner.run(wrapper, ['config'], { cwd: project, env: independentEnv });
  assert.equal(unsupported.code, 1);
  assert.match(unsupported.stderr, /Pi/);
  const beforeUpdate = readFileSync(wrapper, 'utf8');
  const next = await sourceFor(h, 'entry-failed-update');
  const nextArgs = [entry, 'update', '--source', next, '--agent-dir', agentDir, '--bin-dir', binDir];
  const nextReview = await h.sandbox.runner.run(process.execPath, nextArgs, { cwd: project, env: independentEnv });
  const nextDigest = nextReview.stdout.match(/digest: ([a-f0-9]{64})/)?.[1]; assert.ok(nextDigest, nextReview.stderr);
  const stateFile = join(agentDir, 'wardrobe/perfect-pi.json'), oldState = readFileSync(stateFile, 'utf8');
  const fault = join(h.sandbox.root, 'storage-fault.mjs');
  writeFileSync(fault, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const rename=fs.renameSync; fs.renameSync=(from,to)=>{if(to===${JSON.stringify(stateFile)})throw new Error('simulated state storage failure'); return rename(from,to);}; syncBuiltinESMExports();`);
  const commitFailed = await h.sandbox.runner.run(process.execPath, ['--import', fault, ...nextArgs, '--confirm', nextDigest], { cwd: project, env: independentEnv });
  assert.equal(commitFailed.code, 1); assert.match(commitFailed.stderr, /simulated state storage failure/);
  assert.equal(readFileSync(stateFile, 'utf8'), oldState); assert.equal(readFileSync(wrapper, 'utf8'), beforeUpdate);
  const defaultBin = join(h.sandbox.home, '.local/bin'); mkdirSync(defaultBin, { recursive: true });
  writeFileSync(join(defaultBin, 'perfect-pi'), 'unrelated default command\n');
  const switched = await h.sandbox.runner.run(process.execPath, [entry, 'update', '--source', next, '--agent-dir', agentDir, '--confirm', nextDigest], { cwd: project, env: independentEnv });
  assert.equal(switched.code, 0, switched.stderr);
  assert.equal(readFileSync(join(defaultBin, 'perfect-pi'), 'utf8'), 'unrelated default command\n');
  const afterUpdate = await h.sandbox.runner.run(wrapper, ['doctor'], { cwd: project, env: independentEnv });
  assert.equal(afterUpdate.code, 0, afterUpdate.stderr); assert.match(afterUpdate.stdout, /available/);
});

test('daily entry reuses native Pi models, authentication and saved selection without login', async t => {
  const h = harness(), source = await sourceFor(h, 'entry-native-config');
  const agentDir = join(h.sandbox.root, 'native config manager');
  const nativeDir = join(h.sandbox.root, 'native Pi with spaces');
  mkdirSync(nativeDir);
  const models = JSON.stringify({providers:{'native-fixture':{api:'openai-completions',baseUrl:'http://127.0.0.1:1/v1',models:[{id:'native-first'},{id:'native-second'}]}}});
  const auth = JSON.stringify({'native-fixture':{type:'api_key',key:'fixture-only-key'}});
  writeFileSync(join(nativeDir,'models.json'),models);
  writeFileSync(join(nativeDir,'auth.json'),auth);
  writeFileSync(join(nativeDir,'settings.json'),JSON.stringify({defaultProvider:'native-fixture',defaultModel:'native-second',enabledModels:['native-fixture/*'],defaultThinkingLevel:'off',theme:'light'}));
  const env = launchEnv(h, {PI_CODING_AGENT_DIR:nativeDir});
  const args = [entry,'setup','--source',source,'--agent-dir',agentDir,'--bin-dir',join(h.sandbox.root,'native-bin')];
  const review = await h.sandbox.runner.run(process.execPath,args,{cwd:h.sandbox.project,env});
  const digest = review.stdout.match(/digest: ([a-f0-9]{64})/)?.[1]; assert.ok(digest,review.stderr);
  const setup = await h.sandbox.runner.run(process.execPath,[...args,'--confirm',digest],{cwd:h.sandbox.project,env});
  assert.equal(setup.code,0,setup.stderr);
  const wrapper = join(h.sandbox.root,'native-bin/perfect-pi');
  const child = h.sandbox.runner.fork(wrapper,['--','--mode','rpc','--offline','--no-session'],{cwd:h.sandbox.project,env});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  const session = new RpcSession(child,h.sandbox.runner,{agentName:'native-config',agentDir,eventsLog:h.sandbox.extensionLog});
  const state = await session.request('get_state');
  assert.equal(state.data.model?.provider,'native-fixture',session.stderr);
  assert.equal(state.data.model.id,'native-second');
  assert.equal(state.data.thinkingLevel,'off');
  const available = await session.request('get_available_models');
  assert.ok(available.data.models.some(model=>model.id==='native-first'));
  assert.equal((await session.close()).code,0,session.stderr);
  assert.equal(readFileSync(join(nativeDir,'auth.json'),'utf8'),auth);
  assert.equal(readFileSync(join(nativeDir,'models.json'),'utf8'),models);
  const staging = join(agentDir,'wardrobe/staging');
  const revision = readdirSync(staging).find(name=>!name.endsWith('.json'));
  const runtime = join(staging,revision,'attempt-1');
  assert.equal(existsSync(join(runtime,'models.json')),false,'no model configuration copy');
  assert.equal(existsSync(join(runtime,'auth.json')),false,'native auth storage is used directly');
  // A native edit becomes visible on the next launch without updating the preset.
  const settings = JSON.parse(readFileSync(join(nativeDir,'settings.json'),'utf8'));
  settings.defaultModel='native-first'; writeFileSync(join(nativeDir,'settings.json'),JSON.stringify(settings));
  const again = h.sandbox.runner.fork(wrapper,['--','--mode','rpc','--offline','--no-session'],{cwd:h.sandbox.project,env});
  t.after(()=>{if(again.exitCode===null)again.kill('SIGKILL');});
  const next = new RpcSession(again,h.sandbox.runner,{agentName:'native-config-next',agentDir,eventsLog:h.sandbox.extensionLog});
  assert.equal((await next.request('get_state')).data.model.id,'native-first');
  assert.equal((await next.close()).code,0,next.stderr);
  const saveExtension=join(h.sandbox.root,'native-save.ts');
  writeFileSync(saveExtension, `import {SettingsManager,getAgentDir} from '@earendil-works/pi-coding-agent';
export default pi=>pi.registerCommand('native-save',{handler:async()=>{const settings=SettingsManager.create(process.cwd(),getAgentDir());settings.setDefaultModelAndProvider('native-fixture','native-second');settings.setModelThinkingLevel('native-fixture','native-second','off');settings.setTheme('dark');await settings.flush();}});`);
  const saveChild=h.sandbox.runner.fork(wrapper,['--','--mode','rpc','--offline','--no-session','--extension',saveExtension],{cwd:h.sandbox.project,env});
  t.after(()=>{if(saveChild.exitCode===null)saveChild.kill('SIGKILL');});
  const saving=new RpcSession(saveChild,h.sandbox.runner,{agentName:'native-save',agentDir,eventsLog:h.sandbox.extensionLog});
  await saving.command('native-save');
  assert.equal((await saving.close()).code,0,saving.stderr);
  const saved=JSON.parse(readFileSync(join(nativeDir,'settings.json'),'utf8'));
  assert.equal(saved.defaultModel,'native-second','Pi saves model defaults back to the native directory');
  assert.equal(saved.modelThinkingLevels['native-fixture/native-second'],'off');
  assert.equal(saved.theme,'light','Perfect Pi UI preferences remain local');
  assert.equal(JSON.parse(readFileSync(join(runtime,'settings.json'),'utf8')).theme,'dark');
  // A process inherited from Perfect Pi must not redirect another revision.
  const ordinary=join(h.sandbox.root,'ordinary Pi');mkdirSync(ordinary);
  writeFileSync(join(ordinary,'settings.json'),JSON.stringify({enableInstallTelemetry:false}));
  const nestedEnv={...env,PI_CODING_AGENT_DIR:ordinary,PERFECT_PI_NATIVE_AGENT_DIR:nativeDir,PERFECT_PI_NATIVE_REVISION_ROOT:join(staging,revision),NODE_OPTIONS:'--import='+pathToFileURL(resolve('scripts/native-pi-config.mjs')).href};
  const nestedChild=h.sandbox.runner.fork(process.execPath,[h.runtime.cliPath,'--mode','rpc','--offline','--no-session'],{cwd:h.sandbox.project,env:nestedEnv});
  t.after(()=>{if(nestedChild.exitCode===null)nestedChild.kill('SIGKILL');});
  const nested=new RpcSession(nestedChild,h.sandbox.runner,{agentName:'ordinary',agentDir:ordinary,eventsLog:h.sandbox.extensionLog});
  assert.notEqual((await nested.request('get_state')).data.model?.provider,'native-fixture');
  assert.ok(!(await nested.request('get_available_models')).data.models.some(model=>model.provider==='native-fixture'));
  assert.equal((await nested.close()).code,0,nested.stderr);


});

test('a failed local snapshot leaves no temporary source directory', async () => {
  const h = harness(), outputDir = join(h.sandbox.root, 'failed snapshots');
  await assert.rejects(serveLocalSource({ workspaceDir: join(h.sandbox.root, 'missing checkout'), outputDir }));
  assert.deepEqual(readdirSync(outputDir), []);
});

if (process.env.WARDROBE_ENTRY_FULL_INTEGRATION === '1') test('single-terminal setup installs the full local snapshot and launches 47 skills', { timeout: 1800000 }, async t => {
  const h = harness(), managerDir = join(h.sandbox.root, 'full manager');
  const personal = join(h.sandbox.home, '.agents/skills/ask-matt/SKILL.md');
  mkdirSync(join(personal, '..'), {recursive:true});
  const personalText = '---\nname: ask-matt\ndescription: Personal collision fixture\n---\nPersonal skill.\n';
  writeFileSync(personal, personalText);
  const env = launchEnv(h, { WARDROBE_AGENT_DIR: managerDir, WARDROBE_REGISTRY: 'https://registry.npmjs.org/', NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/', NPM_CONFIG_CACHE: '/tmp/wardrobe-perfect-pi-npm-cache' });
  const term = pty.spawn(process.execPath, [entry, 'setup'], { cwd: h.sandbox.project, env, cols: 120, rows: 35 });
  let output = '', answered = false;
  term.onData(chunk => { output += chunk; if (!answered && output.includes('d 查看详细计划')) { answered = true; term.write('y\r'); } });
  t.after(() => { try { term.kill(); } catch {} });
  const code = await new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error(output.slice(-5000))), 1200000);
    term.onExit(result => { clearTimeout(timeout); done(result.exitCode); });
  });
  assert.equal(code, 0, output); assert.match(output, /安装完成/); assert.match(output, /离线启动检查通过/);
  assert.equal(readdirSync(join(managerDir, 'wardrobe/source-snapshots')).length, 0, 'temporary source server files are removed');
  const wrapper = join(h.sandbox.home, '.local/bin/perfect-pi');
  assert.equal(existsSync(join(h.sandbox.home, '.config/pi-wardrobe/perfect-pi/models.json')), false);
  const dailyEnv = { ...env }; delete dailyEnv.WARDROBE_AGENT_DIR; delete dailyEnv.WARDROBE_PI_CLI;
  const child = h.sandbox.runner.fork(wrapper, ['--', '--mode', 'rpc', '--offline', '--no-session'], { cwd: h.sandbox.project, env: dailyEnv });
  const session = new RpcSession(child, h.sandbox.runner, { agentName: 'full-entry', agentDir: managerDir, eventsLog: h.sandbox.extensionLog });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const commands = await session.commandNames();
  const loaded = await session.request('get_commands');
  const askMatt = loaded.data.commands.find(row => row.name === 'skill:ask-matt');
  assert.ok(askMatt.sourceInfo.path.startsWith(managerDir), JSON.stringify(askMatt));
  assert.notEqual(askMatt.description, 'Personal collision fixture');
  assert.equal(readFileSync(personal, 'utf8'), personalText);
  assert.equal(commands.filter(name => name.startsWith('skill:')).length, 47);
  for (const name of ['wardrobe', 'skill:route', 'mcp-key', 'tools']) assert.ok(commands.includes(name), name);
  assert.equal((await session.close()).code, 0, session.stderr);
  const tui = pty.spawn(wrapper,['--','--offline','--no-session'],{cwd:h.sandbox.project,env:dailyEnv,cols:140,rows:40});
  t.after(()=>{try{tui.kill();}catch{}});
  let tuiOutput=''; const tuiExited=new Promise(done=>tui.onExit(done));
  await new Promise((done,reject)=>{const timer=setTimeout(()=>reject(new Error('TUI startup timeout: '+tuiOutput.slice(-3000))),30000);tui.onData(chunk=>{tuiOutput+=chunk;if(tuiOutput.includes('No models available')){clearTimeout(timer);done();}});});
  await new Promise(done=>setTimeout(done,300));
  assert.doesNotMatch(tuiOutput,/ccstyle: write 工具已被|富 diff 已让位|Extension errors|Skill conflicts/);
  await new Promise((done,reject)=>{
    const timer=setTimeout(()=>reject(new Error('TUI reload did not complete: '+tuiOutput.slice(-2000))),20000);
    const subscription=tui.onData(()=>{if(tuiOutput.includes('Reloaded keybindings')){clearTimeout(timer);subscription.dispose();done();}});
    tui.write('/reload\r');
  });
  await new Promise(done=>setTimeout(done,300));
  assert.doesNotMatch(tuiOutput,/ccstyle: write 工具已被|富 diff 已让位|Extension errors|Skill conflicts/);
  tui.kill('SIGTERM'); await tuiExited;
  const doctor = await h.sandbox.runner.run(wrapper, ['doctor'], { cwd: h.sandbox.project, env: dailyEnv });
  assert.equal(doctor.code, 0, doctor.stderr);
  console.log(JSON.stringify({ path: 'setup confirmation → install → offline check → generated launcher → doctor', commandCount: commands.length, skills: 47, nativeDependencies: 8 }));
});

test('interactive setup can be cancelled after review and never overwrites an unrelated command', async t => {
  const h = harness(), source = await sourceFor(h, 'entry-interactive');
  const agentDir = join(h.sandbox.root, 'interactive manager'), binDir = join(h.sandbox.root, 'interactive bin');
  const term = pty.spawn(process.execPath, [entry, 'setup', '--source', source, '--agent-dir', agentDir, '--bin-dir', binDir], {
    cwd: h.sandbox.project, env: launchEnv(h), cols: 120, rows: 30,
  });
  let output = '', answered = false;
  term.onData(chunk => { output += chunk; if (!answered && output.includes('d 查看详细计划')) { answered = true; term.write('n\r'); } });
  t.after(() => { try { term.kill(); } catch {} });
  const code = await new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error(output)), 30000);
    term.onExit(result => { clearTimeout(timeout); done(result.exitCode); });
  });
  assert.equal(code, 0, output); assert.equal(answered, true); assert.match(output, /已取消安装/);
  assert.equal(existsSync(join(binDir, 'perfect-pi')), false);
  assert.equal(existsSync(join(agentDir, 'wardrobe/staging')), false);
  mkdirSync(binDir); const wrapper = join(binDir, 'perfect-pi'); writeFileSync(wrapper, 'user-owned command\n');
  const refused = await h.sandbox.runner.run(process.execPath, [entry, 'setup', '--source', source, '--agent-dir', agentDir, '--bin-dir', binDir], { cwd: h.sandbox.project, env: launchEnv(h) });
  assert.equal(refused.code, 1); assert.match(refused.stderr, /未覆盖/);
  assert.equal(readFileSync(wrapper, 'utf8'), 'user-owned command\n');
});
