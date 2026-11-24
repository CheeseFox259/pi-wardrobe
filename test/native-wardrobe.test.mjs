import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, rmSync, lstatSync, readlinkSync, utimesSync, cpSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { test } from 'node:test';
import { useHarness, launchEnv } from './support/harness.mjs';
import pty from 'node-pty';
import { pathToFileURL } from 'node:url';
import { RpcSession } from '../fixtures/lib/pi-runner.mjs';

const harness = useHarness('native-wardrobe');
const manager = resolve('packages/wardrobe');

test('native presets win skill name conflicts while Pi still discovers new personal skills', async () => {
  const h = harness(), agent = 'native-skills'; h.sandbox.seedAgent(agent);
  await h.pi.runOk(agent, ['install', manager]);
  const skill = description => `---\nname: native-precedence\ndescription: ${description}\n---\nUse this skill.\n`;
  const repo = await h.gitRepo('native-skills', [{ message: 'preset skill', files: {
    'package.json': JSON.stringify({ name: 'native-skills', version: '1.0.0', pi: { skills: ['skills/check/SKILL.md'] } }),
    'preset.json': JSON.stringify({ schemaVersion: 1, id: 'native/skills', name: 'Skill Demo', version: '1.0.0', compatibility: { pi: h.runtime.version }, packages: { self: { source: '.' } }, resources: [{ package: 'self', kind: 'skills', include: ['skills'] }] }),
    'skills/check/SKILL.md': skill('Approved preset skill'),
    'skills/unexported/SKILL.md': '---\nname: unexported-skill\ndescription: Must remain unselected\n---\nHidden.\n',
  } }]);
  const first = await h.pi.rpc(agent);
  try {
    await first.command('wardrobe adopt --yes');
    await first.command(`wardrobe import ${repo.sourceAt(repo.commits[0])} --yes`);
    const result = (await first.readCustomEntries('wardrobe.native-result')).at(-1)?.data;
    assert.equal(result.ok, true, JSON.stringify(result));
    await first.command(`wardrobe default ${result.profile.id}`);
  } finally { await first.close(); }
  const personal = join(h.sandbox.home, '.agents/skills/native-check/SKILL.md');
  mkdirSync(dirname(personal), { recursive: true }); writeFileSync(personal, skill('Personal copy'));
  const extra = join(h.sandbox.home, '.agents/skills/new-personal/SKILL.md');
  mkdirSync(dirname(extra), { recursive: true }); writeFileSync(extra, '---\nname: new-personal\ndescription: Discovered after adoption\n---\nExtra.\n');
  for (const disabled of [false, true]) {
    const child = h.sandbox.runner.fork(process.execPath, [h.runtime.cliPath, '--mode', 'rpc', '--offline', '--no-session', ...(disabled ? ['--no-skills'] : [])], { cwd: h.sandbox.project, env: launchEnv(h, {}, agent) });
    const session = new RpcSession(child, h.sandbox.runner, { agentName: agent, agentDir: h.agentPath(agent), eventsLog: h.sandbox.extensionLog });
    try {
      const commands = (await session.request('get_commands')).data.commands;
      if (disabled) assert.ok(!commands.some(entry => entry.name.startsWith('skill:')));
      else {
        assert.equal(commands.find(entry => entry.name === 'skill:native-precedence')?.description, 'Approved preset skill');
        assert.ok(commands.some(entry => entry.name === 'skill:new-personal'));
        assert.ok(!commands.some(entry => entry.name === 'skill:unexported-skill'));
        assert.doesNotMatch(session.stderr, /Skill conflicts/);
      }
    } finally { await session.close(); }
  }
  assert.equal(readFileSync(personal, 'utf8'), skill('Personal copy'));
});

test('native composer adopts global resources without adopting Pi models or modifying shared skills', async () => {
  const h = harness(), dir = h.agentPath('primary');
  const localManager = join(h.sandbox.home, 'local-manager');
  cpSync(manager, localManager, { recursive: true });
  await h.pi.runOk('primary', ['install', localManager]);
  const shared = join(h.sandbox.home, '.agents/skills/shared-original');
  mkdirSync(shared, { recursive: true });
  const skill = '---\nname: shared-original\ndescription: Original shared skill\n---\nShared original.\n';
  writeFileSync(join(shared, 'SKILL.md'), skill);
  mkdirSync(join(dir, 'extensions'), { recursive: true });
  writeFileSync(join(dir, 'extensions/local.mjs'), "export default pi=>pi.registerCommand('original-local',{handler:async()=>{}});\n");
  const models = JSON.stringify({ providers: { original: { models: [{ id: 'private-model' }] } } });
  writeFileSync(join(dir, 'models.json'), models);
  mkdirSync(join(dir, 'custom'), { recursive: true });
  writeFileSync(join(dir, 'custom/extra.mjs'), 'export default pi=>{};\n');
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ fixturePrivateToken: 'keep-only-in-native' }));
  const beforeAuth = readFileSync(join(dir, 'auth.json'), 'utf8');
  const settings = JSON.parse(readFileSync(join(dir, 'settings.json')));
  const absentSkill = join(h.sandbox.home, '.agents/skills/archify/SKILL.md');
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ...settings, packages: [relative(dir, localManager)], extensions: ['./custom/extra.mjs'], skills: ['~/.agents/skills/shared-original', '-' + absentSkill, '!skills/removed/**'], defaultProvider: 'original', defaultModel: 'private-model' }));
  const session = await h.pi.rpc('primary');
  try {
    await session.command('wardrobe adopt --yes');
    const result = (await session.readCustomEntries('wardrobe.native-result')).at(-1)?.data;
    assert.equal(result?.ok, true, JSON.stringify(result ?? {}));
    assert.equal(result?.state, 'adopted');
    const config = JSON.parse(readFileSync(join(dir, 'wardrobe/native.json')));
    const original = config.profiles[config.default];
    assert.equal(original.name, '我的原始配置');
    assert.ok(existsSync(join(original.agentDir, 'extensions/local.mjs')));
    const declaration = readFileSync(join(original.agentDir, 'preset.json'), 'utf8');
    assert.doesNotMatch(declaration, /private-model|defaultProvider|defaultModel/);
    assert.equal(existsSync(join(original.agentDir, 'models.json')), false);
    assert.equal(existsSync(join(original.agentDir, 'auth.json')), false);
    assert.ok(lstatSync(join(original.agentDir, 'mcp.json')).isSymbolicLink());
    assert.equal(readlinkSync(join(original.agentDir, 'mcp.json')), join(dir, 'mcp.json'));
    assert.ok(original.localDependencies.includes(join(dir, 'custom/extra.mjs')));
    assert.ok(original.localDependencies.includes(shared));
    assert.ok(!original.localDependencies.includes(absentSkill));
    assert.ok(JSON.parse(readFileSync(join(original.agentDir, 'settings.json'))).skills.includes('-' + absentSkill));
    assert.ok(JSON.parse(readFileSync(join(original.agentDir, 'settings.json'))).extensions.includes(join(dir, 'custom/extra.mjs')));
    assert.equal(readFileSync(join(dir, 'models.json'), 'utf8'), models);
    assert.equal(readFileSync(join(dir, 'auth.json'), 'utf8'), beforeAuth);
    assert.equal(readFileSync(join(shared, 'SKILL.md'), 'utf8'), skill);
    assert.equal(JSON.parse(readFileSync(join(dir, 'settings.json'))).defaultModel, 'private-model');
    rmSync(original.agentDir, { recursive: true });
    await session.command('wardrobe repair original --yes');
    const repaired = (await session.readCustomEntries('wardrobe.native-result')).at(-1)?.data;
    assert.equal(repaired.ok, true, JSON.stringify(repaired));
    assert.equal(repaired.profile.id, 'original');
    assert.ok(existsSync(join(repaired.profile.agentDir, 'extensions/local.mjs')));
    const restoredPackages = JSON.parse(readFileSync(join(repaired.profile.agentDir, 'settings.json'))).packages;
    assert.equal(restoredPackages.length, 0, JSON.stringify(restoredPackages));
    rmSync(repaired.profile.agentDir, { recursive: true });
    rmSync(join(dir, 'extensions'), { recursive: true });
    await session.command('wardrobe repair original --yes');
    const missing = (await session.readCustomEntries('wardrobe.native-result')).at(-1)?.data;
    assert.equal(missing.ok, false, 'missing original source files cannot be reported as restored');
    assert.match(missing.error, /extensions/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'wardrobe/native.json'))).profiles.original.agentDir, repaired.profile.agentDir);
  } finally { await session.close(); }
});

test('first wardrobe panel archives missing disabled skills and opens the preset list', async () => {
  const h = harness(), agent = 'native-first-panel'; h.sandbox.seedAgent(agent);
  const dir = h.agentPath(agent);
  await h.pi.runOk(agent, ['install', manager]);
  const absent = join(h.sandbox.home, '.agents/skills/archify/SKILL.md');
  const settings = JSON.parse(readFileSync(join(dir, 'settings.json')));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ...settings, skills: ['-' + absent, '-skills/archify/SKILL.md'] }));
  const terminal = pty.spawn(process.execPath, [h.runtime.cliPath, '--offline', '--no-session'], { cwd: h.sandbox.project, env: launchEnv(h, {}, agent), cols: 120, rows: 40 });
  let output = '', exited = false;
  terminal.onData(chunk => { output += chunk; }); terminal.onExit(() => { exited = true; });
  async function waitFor(text) {
    const until = Date.now() + 15000;
    while (!output.includes(text)) {
      assert.ok(!exited, 'Pi exited before adoption completed: ' + output.slice(-1800));
      assert.ok(Date.now() < until, 'TUI did not show ' + text + ': ' + output.slice(-2500));
      await new Promise(done => setTimeout(done, 25));
    }
  }
  try {
    await waitFor('index.mjs');
    terminal.write('/wardrobe\r');
    await waitFor('欢迎使用 Wardrobe');
    terminal.write('\r');
    await waitFor('Ctrl+n 创建');
    assert.doesNotMatch(output, /这些本机依赖已丢失/);
    const config = JSON.parse(readFileSync(join(dir, 'wardrobe/native.json')));
    assert.equal(config.initialized, true);
    assert.deepEqual(config.profiles.original.localDependencies, []);
    assert.equal(existsSync(absent), false);
  } finally { terminal.kill('SIGTERM'); await new Promise(done => setTimeout(done, 100)); }
});

test('verification checks the reviewed resource selection before refreshing a startup cache', async () => {
  const h = harness(), agent = 'native-verify'; h.sandbox.seedAgent(agent);
  await h.pi.runOk(agent, ['install', manager]);
  const repo = await h.gitRepo('native-verify', [{ message: 'reviewed extension', files: {
    'package.json': JSON.stringify({ name: 'native-verify', version: '1.0.0', pi: { extensions: ['extension.mjs'] } }),
    'preset.json': JSON.stringify({ schemaVersion: 1, id: 'native/verify', name: 'Verify Demo', version: '1.0.0', compatibility: { pi: h.runtime.version }, packages: { self: { source: '.' } }, resources: [{ package: 'self', kind: 'extensions', include: ['extension.mjs'] }] }),
    'extension.mjs': "export default pi=>pi.registerCommand('verified-extension',{handler:async()=>{}});\n",
  } }]);
  const session = await h.pi.rpc(agent);
  const latest = async () => (await session.readCustomEntries('wardrobe.native-result')).at(-1)?.data;
  let profile;
  try {
    await session.command('wardrobe adopt --yes');
    await session.command(`wardrobe import ${repo.sourceAt(repo.commits[0])} --yes`);
    profile = (await latest()).profile;
    const extension = profile.resources[0].path;
    utimesSync(extension, new Date(), new Date(Date.now() + 5000));
    await session.command(`wardrobe verify ${profile.id}`);
    assert.equal((await latest()).ok, true, JSON.stringify(await latest()));
    const file = join(profile.agentDir, 'settings.json'), clean = readFileSync(file, 'utf8');
    const settings = JSON.parse(clean); settings.extensions = ['/unreviewed/rogue.mjs'];
    writeFileSync(file, JSON.stringify(settings));
    await session.command(`wardrobe verify ${profile.id}`);
    assert.equal((await latest()).ok, false, 'verify must refuse unreviewed resource declarations');
    writeFileSync(file, clean);
    await session.command(`wardrobe verify ${profile.id}`);
    assert.equal((await latest()).ok, true, JSON.stringify(await latest()));
    await session.command(`wardrobe default ${profile.id}`);
  } finally { await session.close(); }
  const restarted = await h.pi.rpc(agent);
  try { assert.ok((await restarted.commandNames()).includes('verified-extension'), restarted.stderr); }
  finally { await restarted.close(); }
});

test('composer imports a reviewed repository without requiring a digest or external launcher', async () => {
  const h = harness(), agent = 'native-import';
  h.sandbox.seedAgent(agent);
  await h.pi.runOk(agent, ['install', manager]);
  const repo = await h.gitRepo('native-import', [{ message: 'standard preset', files: {
    'preset.json': JSON.stringify({ schemaVersion: 1, id: 'native/demo', name: 'Native Demo', version: '1.0.0', compatibility: { pi: h.runtime.version }, packages: { self: { source: '.' } }, resources: [{ package: 'self', kind: 'extensions', include: ['extension.mjs'] }] }),
    'package.json': JSON.stringify({ name: 'native-demo-fixture', version: '1.0.0', pi: { extensions: ['extension.mjs'] } }),
    'extension.mjs': "export default pi=>pi.registerCommand('native-demo',{handler:async()=>{}});\n",
  } }]);
  const session = await h.pi.rpc(agent);
  let imported;
  try {
    await session.command('wardrobe adopt --yes');
    await session.command(`wardrobe import ${repo.sourceAt(repo.commits[0])} --yes`);
    const result = (await session.readCustomEntries('wardrobe.native-result')).at(-1)?.data;
    assert.equal(result?.ok, true, JSON.stringify(result ?? {}));
    assert.equal(result.state, 'installed');
    assert.equal(result.profile.name, 'Native Demo');
    assert.equal(JSON.parse(readFileSync(join(h.agentPath(agent), 'wardrobe/native.json'))).default, 'original');
    assert.ok(existsSync(join(result.profile.agentDir, 'settings.json')));
    assert.equal(result.active, false);
    imported = result.profile;
  } finally { await session.close(); }
  const { SessionManager } = await import(pathToFileURL(join(dirname(h.runtime.cliPath), 'index.js')).href);
  const oldSession = SessionManager.create(realpathSync(h.sandbox.project), h.sandbox.sessions);
  oldSession.appendMessage({ role: 'user', content: 'Preserve this original dialogue.', timestamp: Date.now() });
  const oldFile = oldSession.getSessionFile(), oldBytes = readFileSync(oldFile, 'utf8');
  const terminal = pty.spawn(process.execPath, [h.runtime.cliPath, '--offline', '--session', oldFile], { cwd: h.sandbox.project, env: launchEnv(h, {}, agent), cols: 120, rows: 35 });
  let output = '', exited = false;
  terminal.onData(chunk => { output += chunk; }); terminal.onExit(() => { exited = true; });
  async function waitFor(text) {
    const until = Date.now() + 15000;
    while (!output.includes(text)) {
      assert.ok(!exited, 'Pi exited before switch completed: ' + output.slice(-1000));
      assert.ok(Date.now() < until, 'TUI did not show ' + text + ': ' + output.slice(-1800));
      await new Promise(done => setTimeout(done, 25));
    }
  }
  try {
    await waitFor('Preset: 我的原始配置');
    terminal.write('/wardrobe use ' + imported.id + '\r');
    await waitFor('Preset: Native Demo');
    assert.equal(JSON.parse(readFileSync(join(h.agentPath(agent), 'wardrobe/native.json'))).default, 'original');
    output = '';
    terminal.write('/wardrobe\r');
    await waitFor('Ctrl+n 创建');
    terminal.write('\x1b');
    await new Promise(done => setTimeout(done, 100));
    output = '';
    terminal.write('/resume\r');
    await waitFor('Preserve this original dialogue.');
    output = ''; terminal.write('\r');
    await waitFor('Preset: 我的原始配置');
    assert.ok(readFileSync(oldFile, 'utf8').startsWith(oldBytes), 'native resume keeps the original dialogue');
    output = ''; terminal.write('/wardrobe default ' + imported.id + '\r');
    await waitFor('已设置启动默认');
  } finally { terminal.kill('SIGTERM'); await new Promise(done => setTimeout(done, 100)); }
  const resumed = pty.spawn(process.execPath, [h.runtime.cliPath, '--offline', '--resume', '--session-dir', dirname(oldFile)], { cwd: h.sandbox.project, env: launchEnv(h, {}, agent), cols: 120, rows: 35 });
  let resumeOutput = '';
  resumed.onData(chunk => { resumeOutput += chunk; });
  async function waitResume(text) {
    const until = Date.now() + 15000;
    while (!resumeOutput.includes(text)) {
      assert.ok(Date.now() < until, 'Startup resume did not show ' + text + ': ' + resumeOutput.slice(-1800));
      await new Promise(done => setTimeout(done, 25));
    }
  }
  try {
    await waitResume('Preserve this original dialogue.');
    resumeOutput = ''; resumed.write('\r');
    await waitResume('Preset: 我的原始配置');
  } finally { resumed.kill('SIGTERM'); await new Promise(done => setTimeout(done, 100)); }
});

test('ordinary native Pi starts its saved preset and retains the original model configuration', async () => {
  const h = harness(), dir = h.agentPath('second');
  await h.pi.runOk('second', ['install', manager]);
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { 'native-fixture': { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'native-existing' }] } } }));
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ 'native-fixture': { type: 'api_key', key: 'fixture-local-only' } }));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'settings.json'))), defaultProvider: 'native-fixture', defaultModel: 'native-existing' }));
  mkdirSync(join(dir, 'extensions'), { recursive: true });
  writeFileSync(join(dir, 'extensions/native-original.js'), "export default pi=>pi.registerCommand('saved-original-command',{handler:async()=>{}});\n");
  const first = await h.pi.rpc('second');
  try { await first.command('wardrobe adopt --yes'); } finally { await first.close(); }
  const next = await h.pi.rpc('second');
  next.agentDir = JSON.parse(readFileSync(join(dir, 'wardrobe/native.json'))).profiles.original.agentDir;
  try {
    assert.ok((await next.commandNames()).includes('saved-original-command'));
    await next.command('wardrobe current');
    const result = (await next.readCustomEntries('wardrobe.native-result')).at(-1)?.data;
    assert.equal(result?.profile?.id, 'original', JSON.stringify(result ?? {}));
    assert.equal(result?.nativeAgentDir, dir);
    assert.notEqual(result?.agentDir, dir);
    assert.equal((await next.request('get_state')).data.model.provider, 'native-fixture');
    await next.command('wardrobe default original --project');
    assert.equal(JSON.parse(readFileSync(join(dir, 'wardrobe/native.json'))).projects[realpathSync(h.sandbox.project)], 'original');
    await next.command('wardrobe default --project --clear');
    assert.equal(JSON.parse(readFileSync(join(dir, 'wardrobe/native.json'))).projects[realpathSync(h.sandbox.project)], undefined);
  } finally { await next.close(); }
});

test('composer pull prepares an incremental candidate without replacing revisions or startup defaults', async () => {
  const h = harness(), agent = 'native-update';
  h.sandbox.seedAgent(agent);
  await h.pi.runOk(agent, ['install', manager]);
  const declaration = version => JSON.stringify({ schemaVersion: 1, id: 'native/update', name: 'Update Demo', version, compatibility: { pi: h.runtime.version }, packages: { self: { source: '.' } }, resources: [{ package: 'self', kind: 'extensions', include: ['extension.mjs'] }] });
  const repo = await h.gitRepo('native-update', [
    { message: 'one', files: { 'preset.json': declaration('1.0.0'), 'package.json': JSON.stringify({ name: 'native-update', version: '1.0.0', pi: { extensions: ['extension.mjs'] } }), 'extension.mjs': 'export default pi=>{};\n' } },
    { message: 'two', files: { 'preset.json': declaration('1.1.0') } },
  ]);
  const session = await h.pi.rpc(agent, { extraEnv: { WARDROBE_REGISTRY: `${h.server.origin}/npm/` } });
  const latest = async () => (await session.readCustomEntries('wardrobe.native-result')).at(-1)?.data;
  try {
    await session.command('wardrobe adopt --yes');
    await session.command(`wardrobe import ${repo.sourceAt(repo.commits[0])} --yes`);
    const old = (await latest()).profile;
    await session.command(`wardrobe default ${old.id}`);
    await session.command(`wardrobe pull ${old.id} --prepare`);
    const result = await latest();
    assert.equal(result.status, 'REVIEW_REQUIRED', JSON.stringify(result));
    assert.ok(result.capabilities.some(capability=>capability.kind==='preset-update'));
    const versionReview=result.decisions.find(decision=>decision.skill==='preset'&&decision.path==='preset.json');
    assert.equal(JSON.parse(readFileSync(versionReview.review.upstream)).version,'1.1.0');
    assert.equal(JSON.parse(readFileSync(join(result.workspace.source,'preset.json'))).version,'1.0.1','the local revision remains the candidate until model review');
    const config = JSON.parse(readFileSync(join(h.agentPath(agent), 'wardrobe/native.json')));
    assert.ok(config.profiles[old.id]);
    assert.equal(config.default, old.id);
    assert.equal(Object.keys(config.profiles).length,2,'preparation never installs another revision');
  } finally { await session.close(); }
});

test('a standard collection imports its indexed preset at a named Git ref', async () => {
  const h = harness(), agent = 'native-collection'; h.sandbox.seedAgent(agent);
  await h.pi.runOk(agent, ['install', manager]);
  const preset = (id, name) => JSON.stringify({ schemaVersion: 1, id, name, version: '1.0.0', compatibility: { pi: h.runtime.version } });
  const repo = await h.gitRepo('native-collection', [{ message: 'collection', files: {
    'package.json': JSON.stringify({ name: 'collection', version: '1.0.0', wardrobe: { presets: ['presets/a/preset.json', 'presets/b/preset.json'] } }),
    'presets/a/preset.json': preset('collection/a', 'Collection A'),
    'presets/b/preset.json': preset('collection/b', 'Collection B'),
    'examples/invalid/preset.json': '{"not-a-preset":true}',
  } }]);
  const session = await h.pi.rpc(agent);
  try {
    await session.command('wardrobe adopt --yes');
    const branch = await h.sandbox.runner.run('git', ['--git-dir', repo.root, 'branch', 'release/native', repo.commits[0]], { env: h.sandbox.childEnv() });
    assert.equal(branch.code, 0, branch.stderr);
    const advertisement = await h.sandbox.runner.run('git', ['--git-dir', repo.root, 'update-server-info'], { env: h.sandbox.childEnv() });
    assert.equal(advertisement.code, 0, advertisement.stderr);
    const source = repo.sourceAt(repo.commits[0]).replace(/@[a-f0-9]{40}$/, '@release/native');
    await session.command(`wardrobe import ${source} --preset presets/b/preset.json --yes`);
    const result = (await session.readCustomEntries('wardrobe.native-result')).at(-1)?.data;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.profile.name, 'Collection B');
    assert.equal(result.profile.source.ref, 'release/native');
    assert.equal(result.profile.source.commit, repo.commits[0]);
  } finally { await session.close(); }
});
