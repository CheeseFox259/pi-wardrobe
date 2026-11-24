import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import pty from 'node-pty';
import { adoptOriginal } from '../packages/wardrobe/src/native-adoption.mjs';
import { checkPreparedProfile, currentPiVersion } from '../packages/wardrobe/src/native-service.mjs';
import { useHarness, launchEnv } from './support/harness.mjs';
import { RpcSession } from '../fixtures/lib/pi-runner.mjs';

const harness = useHarness('native-startup');

for (const entry of ['modular', 'installed']) test(`Pi runtime version resolves through its ${entry} entry symlink`, () => {
  const h = harness(), bin = join(h.sandbox.work, entry, 'node_modules/.bin/pi');
  mkdirSync(dirname(bin), { recursive: true });
  symlinkSync(entry === 'modular' ? h.runtime.cliPath : join(h.runtime.runtimeRoot, '../../.bin/pi'), bin);
  const previous = process.env.WARDROBE_PI_CLI;
  process.env.WARDROBE_PI_CLI = bin;
  try {
    assert.equal(currentPiVersion(), h.runtime.version);
    const profile = { name: 'Original', agentDir: h.agentPath('primary'), compatibility: { pi: '^1.1.0' } };
    assert.doesNotThrow(() => checkPreparedProfile(profile));
    assert.doesNotThrow(() => checkPreparedProfile({...profile,compatibility:{pi:'~1.0.4'}}));
    assert.throws(() => checkPreparedProfile({ ...profile, compatibility: { pi: '99.0.0' } }), /不兼容/);
    const cachePath=join(h.agentPath('primary'),'forward-cache-'+entry+'.json'),settings=JSON.parse(readFileSync(join(profile.agentDir,'settings.json')));
    const configuration=Object.fromEntries(['packages','extensions','skills','prompts','themes'].filter(k=>Object.hasOwn(settings,k)).map(k=>[k,settings[k]]));
    writeFileSync(cachePath,JSON.stringify({node:process.version,pi:'1.0.4',platform:process.platform,configuration,stamps:[]}));
    checkPreparedProfile({...profile,cache:cachePath});
    assert.equal(JSON.parse(readFileSync(cachePath)).pi,h.runtime.version);
    assert.equal(JSON.parse(readFileSync(cachePath)).previousPi,'1.0.4');
  }
  finally {
    if (previous === undefined) delete process.env.WARDROBE_PI_CLI;
    else process.env.WARDROBE_PI_CLI = previous;
  }
});

test('native TUI starts an adopted custom theme without a bootstrap warning', async () => {
  const h = harness(), agent = 'custom-theme';
  const dir = h.sandbox.seedAgent(agent);
  await h.pi.runOk(agent, ['install', resolve('packages/wardrobe')]);
  mkdirSync(join(dir, 'themes'));
  const theme = JSON.parse(readFileSync(join(h.runtime.runtimeRoot, 'dist/modes/interactive/theme/dark.json')));
  writeFileSync(join(dir, 'themes/cc-dark.json'), JSON.stringify({ ...theme, name: 'cc-dark' }));
  const settingsPath = join(dir, 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath));
  writeFileSync(settingsPath, JSON.stringify({ ...settings, theme: 'cc-dark' }));
  adoptOriginal(dir, { piVersion: '1.0.4' });
  const { NativeStore }=await import('../packages/wardrobe/src/native-store.mjs');
  const store=new NativeStore(dir),config=store.read();config.profiles.original.compatibility.pi='~1.0.4';store.save(config);
  const bin = join(h.sandbox.work, 'native-bin/pi');
  mkdirSync(dirname(bin), { recursive: true }); symlinkSync(join(h.runtime.runtimeRoot, '../../.bin/pi'), bin);
  const env = launchEnv(h, {}, agent); delete env.WARDROBE_PI_CLI;
  const terminal = pty.spawn(process.execPath, [bin, '--offline', '--no-session'], {
    cwd: h.sandbox.project, env, cols: 120, rows: 30,
  });
  let output = '';
  let exited = false;
  terminal.onData(chunk => { output += chunk; });
  terminal.onExit(() => { exited = true; });
  try {
    const deadline = Date.now() + 10000;
    while (!output.includes('Preset: 我的原始配置') && !output.includes('Preset 启动未完成')) {
      assert.equal(exited, false, output.slice(-4000));
      assert.ok(Date.now() < deadline, output.slice(-4000));
      await new Promise(done => setTimeout(done, 25));
    }
    assert.doesNotMatch(output, /Theme not found: cc-dark|Failed to load theme|Preset 启动未完成/);
    assert.match(output, /Preset: 我的原始配置/);
  } finally {
    terminal.kill('SIGTERM');
    await new Promise(done => setTimeout(done, 100));
  }
});

test('the installed Pi entry hands off with native model ownership intact', async () => {
  const h = harness(), agent = 'installed-entry', dir = h.sandbox.seedAgent(agent);
  await h.pi.runOk(agent, ['install', resolve('packages/wardrobe')]);
  const models = JSON.stringify({ providers: { 'native-fixture': { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'native-existing' }] } } });
  const auth = JSON.stringify({ 'native-fixture': { type: 'api_key', key: 'fixture-local-only' } });
  writeFileSync(join(dir, 'models.json'), models);
  writeFileSync(join(dir, 'auth.json'), auth);
  const settings = JSON.parse(readFileSync(join(dir, 'settings.json')));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ...settings, defaultProvider: 'native-fixture', defaultModel: 'native-existing' }));
  const { profile } = adoptOriginal(dir, { piVersion: '1.1.0' });
  const configPath=join(dir,'wardrobe/native.json'),config=JSON.parse(readFileSync(configPath));
  // Available presets and a project default do not require global adoption.
  config.initialized=false;config.default=null;config.projects={[realpathSync(h.sandbox.project)]:profile.id};writeFileSync(configPath,JSON.stringify(config));
  const env = launchEnv(h, {}, agent); delete env.WARDROBE_PI_CLI;
  const bin = join(h.runtime.runtimeRoot, '../../.bin/pi');
  const child = h.sandbox.runner.fork(process.execPath, [bin, '--mode', 'rpc', '--offline', '--no-session', '-e', h.pi.ensureDriver()], { cwd: h.sandbox.project, env });
  const session = new RpcSession(child, h.sandbox.runner, { agentName: agent, agentDir: profile.agentDir, eventsLog: h.sandbox.extensionLog });
  try {
    assert.ok((await session.commandNames()).includes('wardrobe'));
    await session.command('wardrobe current');
    assert.equal((await session.readCustomEntries('wardrobe.native-result')).at(-1).data.profile.id, 'original');
    assert.equal((await session.request('get_state')).data.model.provider, 'native-fixture');
    assert.equal(readFileSync(join(dir, 'models.json'), 'utf8'), models);
    assert.equal(readFileSync(join(dir, 'auth.json'), 'utf8'), auth);
    assert.equal(existsSync(join(profile.agentDir, 'models.json')), false);
    assert.equal(existsSync(join(profile.agentDir, 'auth.json')), false);
    assert.doesNotMatch(session.stderr, /Failed to load|ERR_MODULE_NOT_FOUND/);
  } finally { await session.close(); }
});
