import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import pty from 'node-pty';
import { launchEnv, useHarness } from './support/harness.mjs';

const harness = useHarness('native-authoring');

test('native import refuses a selected skill missing from package exports before registering a profile', async () => {
  const h=harness(),agent='export-validation';h.sandbox.seedAgent(agent);
  await h.pi.runOk(agent,['install',resolve('packages/wardrobe')]);
  const source=await h.gitRepo('missing-native-export',[
    {message:'selected skill is not exported',files:{
      'package.json':JSON.stringify({name:'export-validation',version:'1.0.0',pi:{skills:['skills/other/SKILL.md']}}),
      'preset.json':JSON.stringify({schemaVersion:1,id:'export-validation',name:'Export Validation',version:'1.0.0',compatibility:{pi:'>=1.0.0'},packages:{self:{source:'.'}},resources:[{package:'self',kind:'skills',include:['skills/check/SKILL.md']}]}),
      'skills/check/SKILL.md':'---\nname: export-validation\ndescription: Native export fixture\n---\nFixture.\n',
      'skills/other/SKILL.md':'---\nname: other\ndescription: Unselected native export fixture\n---\nFixture.\n',
    }},
    {message:'export the selected skill',files:{'package.json':JSON.stringify({name:'export-validation',version:'1.0.0',pi:{skills:['skills/check/SKILL.md']}})}},
  ]);
  const session=await h.pi.rpc(agent);
  const latest=async()=>(await session.readCustomEntries('wardrobe.native-result')).at(-1)?.data;
  try {
    await session.command('wardrobe adopt --yes');
    await session.command(`wardrobe import ${source.sourceAt(source.commits[0])} --yes`);
    assert.match((await latest()).error,/Native Pi cannot discover selected resources: skills: self\/skills\/check\/SKILL.md/);
    const configPath=join(h.agentPath(agent),'wardrobe/native.json');
    const failed=JSON.parse(readFileSync(configPath));assert.equal(Object.values(failed.profiles).some(p=>p.name==='Export Validation'),false);
    await session.command(`wardrobe import ${source.sourceAt(source.commits[1])} --yes`);
    assert.equal((await latest()).ok,true,JSON.stringify(await latest()));
    const repaired=JSON.parse(readFileSync(configPath));assert.ok(Object.values(repaired.profiles).some(p=>p.name==='Export Validation'));assert.equal(repaired.default,failed.default);
  } finally { await session.close(); }
});

test('composer creates a blank draft, saves a usable revision and exports a standard preset without activating it', async () => {
  const h = harness(), agent = 'create'; h.sandbox.seedAgent(agent);
  await h.pi.runOk(agent, ['install', resolve('packages/wardrobe')]);
  const session = await h.pi.rpc(agent);
  const latest = async () => (await session.readCustomEntries('wardrobe.native-result')).at(-1)?.data;
  try {
    await session.command('wardrobe adopt --yes');
    await session.command('wardrobe create --blank --name "My Writing"');
    const created = await latest();
    assert.equal(created?.state, 'draft', JSON.stringify(created));
    assert.ok(existsSync(join(created.draft.source, 'preset.json')));
    const definitionPath = join(created.draft.source, 'preset.json');
    const definition = JSON.parse(readFileSync(definitionPath));
    writeFileSync(definitionPath, JSON.stringify({ ...definition, version: '1.0.0+local.fixture' }));
    const unsafe = join(created.draft.source, 'unsafe-example.json');
    writeFileSync(unsafe, JSON.stringify({ apiKey: 'sk-' + 'not-a-real-key-'.repeat(4) }));
    await session.command(`wardrobe save ${created.draft.id} --yes`);
    assert.match((await latest()).error, /凭据/);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(h.agentPath(agent), 'wardrobe/native.json'))).profiles), ['original']);
    rmSync(unsafe);
    await session.command(`wardrobe save ${created.draft.id} --yes`);
    const saved = await latest();
    assert.equal(saved?.ok, true, JSON.stringify(saved));
    assert.equal(saved.state, 'saved');
    assert.equal(saved.profile.name, 'My Writing');
    const count=Object.keys(JSON.parse(readFileSync(join(h.agentPath(agent),'wardrobe/native.json'))).profiles).length;
    await session.command(`wardrobe save ${created.draft.id} --yes`);
    assert.equal((await latest()).profile.id,saved.profile.id,'repeating save returns the original revision');
    assert.equal(Object.keys(JSON.parse(readFileSync(join(h.agentPath(agent),'wardrobe/native.json'))).profiles).length,count);
    await session.command(`wardrobe edit ${saved.profile.id}`);
    const edited = await latest();
    assert.equal(JSON.parse(readFileSync(join(edited.draft.source, 'preset.json'))).version, '1.0.1');
    const config = JSON.parse(readFileSync(join(h.agentPath(agent), 'wardrobe/native.json')));
    assert.equal(config.default, 'original');
    const destination = join(h.sandbox.home, 'exported writing');
    await session.command(`wardrobe export ${saved.profile.id} ${JSON.stringify(destination)}`);
    assert.equal((await latest()).state, 'exported', JSON.stringify(await latest()));
    assert.equal(JSON.parse(readFileSync(join(destination, 'preset.json'))).name, 'My Writing');
    assert.equal(existsSync(join(destination, 'models.json')), false);
    await session.command(`wardrobe import ${JSON.stringify(destination)} --yes`);
    assert.equal((await latest()).ok, true, JSON.stringify(await latest()));
  } finally { await session.close(); }
});

test('real TUI edits a current-environment draft and preserves disabled resources for later revisions', async () => {
  const h = harness(), agent = 'resource-author'; h.sandbox.seedAgent(agent);
  const dir = h.agentPath(agent);
  mkdirSync(join(dir, 'skills/optional'), { recursive: true });
  writeFileSync(join(dir, 'skills/optional/SKILL.md'), '---\nname: optional\ndescription: Optional public skill\n---\nPublic workflow.\n');
  await h.pi.runOk(agent, ['install', resolve('packages/wardrobe')]);
  const setup = await h.pi.rpc(agent);
  try { await setup.command('wardrobe adopt --yes'); } finally { await setup.close(); }
  const terminal = pty.spawn(process.execPath, [h.runtime.cliPath, '--offline', '--no-session'], { cwd: h.sandbox.project, env: launchEnv(h, {}, agent), cols: 110, rows: 36 });
  let output = '', exited = false;
  terminal.onData(chunk => { output += chunk; }); terminal.onExit(() => { exited = true; });
  const waitFor = async text => {
    const until = Date.now() + 15000;
    while (!output.includes(text)) {
      assert.ok(!exited && Date.now() < until, 'TUI did not show ' + text + ': ' + output.slice(-3500));
      await new Promise(done => setTimeout(done, 25));
    }
  };
  let saved;
  try {
    await waitFor('Preset: 我的原始配置');
    output = ''; terminal.write('/wardrobe\r'); await waitFor('Ctrl+n 创建');
    terminal.write('\x0e'); await waitFor('从当前环境');
    terminal.write('\r'); await waitFor('预设名称');
    terminal.write('Lean Writing\r'); await waitFor('审阅并保存');
    terminal.write('\x1b[B\r'); await waitFor('skills/optional/SKILL.md');
    output = ''; terminal.write('\r'); await waitFor('○ skills');
    terminal.write('\x1b'); output = ''; await waitFor('审阅并保存');
    terminal.write('\x1b[B'.repeat(6) + '\r'); await waitFor('保存 Lean Writing');
    output = ''; terminal.write('\r'); await waitFor('Ctrl+n 创建');
    const config = JSON.parse(readFileSync(join(dir, 'wardrobe/native.json')));
    saved = Object.values(config.profiles).find(profile => profile.name === 'Lean Writing');
    assert.ok(saved, JSON.stringify(config));
    assert.deepEqual(saved.selectedSkills, []);
    assert.ok(existsSync(join(config.profiles.original.agentDir, 'skills/optional/SKILL.md')));
    assert.equal(config.default, 'original');
    output = ''; terminal.write('Lean Writing\x1b[C'); await waitFor('启动默认');
    terminal.write('\r'); output = ''; await waitFor('审阅并保存');
    terminal.write('\x1b[B\r'); output = ''; await waitFor('○ skills');
    terminal.write('\r'); output = ''; await waitFor('✓ skills');
    terminal.write('\x1b'); output = ''; await waitFor('审阅并保存');
    terminal.write('\x1b[B'.repeat(6) + '\r'); await waitFor('1.0.1');
    output = ''; terminal.write('\r'); await waitFor('Ctrl+n 创建');
    const revised = Object.values(JSON.parse(readFileSync(join(dir, 'wardrobe/native.json'))).profiles).find(p => p.parent === saved.id);
    assert.equal(revised?.selectedSkills.length, 1, JSON.stringify(revised));
  } finally { terminal.kill('SIGTERM'); await new Promise(done => setTimeout(done, 100)); }
  const session = await h.pi.rpc(agent);
  session.agentDir = JSON.parse(readFileSync(join(dir, 'wardrobe/native.json'))).profiles.original.agentDir;
  try {
    await session.command(`wardrobe edit ${saved.id}`);
    const result = (await session.readCustomEntries('wardrobe.native-result')).at(-1).data;
    const draft = JSON.parse(readFileSync(join(dir, 'wardrobe/drafts', result.draft.id, 'draft.json')));
    // Reading the editor builds the catalog; the saved manifest must carry it
    // between independent drafts and exports, without re-enabling the resource.
    const manifest = JSON.parse(readFileSync(join(draft.source, 'package.json')));
    assert.ok(manifest.wardrobe.resourceCatalog.some(item => item.path === 'skills/optional/SKILL.md'));
    assert.deepEqual(JSON.parse(readFileSync(join(draft.source, 'preset.json'))).resources.find(r => r.kind === 'skills').include, []);
  } finally { await session.close(); }
});

test('real TUI creates and uses a preset through the searchable roster', async () => {
  const h = harness(), agent = 'tui-author'; h.sandbox.seedAgent(agent);
  const dir = h.agentPath(agent);
  mkdirSync(join(dir, 'docs')); mkdirSync(join(dir, 'extensions'));
  writeFileSync(join(dir, 'docs/reader.json'), '{"message":"Public companion loaded"}');
  writeFileSync(join(dir, 'extensions/reader.mjs'), "import {readFileSync} from 'node:fs';import {join} from 'node:path';export default pi=>{const value=JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR,'docs/reader.json')));pi.registerCommand('public-reader',{handler:async(_args,ctx)=>ctx.ui.notify(value.message,'info')});};\n");
  const settings = JSON.parse(readFileSync(join(dir, 'settings.json')));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ...settings, extensions: ['extensions/reader.mjs'] }));
  await h.pi.runOk(agent, ['install', resolve('packages/wardrobe')]);
  const setup = await h.pi.rpc(agent);
  try { await setup.command('wardrobe adopt --yes'); } finally { await setup.close(); }
  const terminal = pty.spawn(process.execPath, [h.runtime.cliPath, '--offline', '--no-session'], { cwd: h.sandbox.project, env: launchEnv(h, {}, agent), cols: 110, rows: 36 });
  let output = '', exited = false;
  terminal.onData(chunk => { output += chunk; }); terminal.onExit(() => { exited = true; });
  const waitFor = async text => {
    const until = Date.now() + 15000;
    while (!output.includes(text)) {
      assert.ok(!exited && Date.now() < until, 'TUI did not show ' + text + ': ' + output.slice(-3500));
      await new Promise(done => setTimeout(done, 25));
    }
  };
  try {
    await waitFor('Preset: 我的原始配置');
    output = ''; terminal.write('/wardrobe\r'); await waitFor('Ctrl+n 创建');
    terminal.write('\x0e'); await waitFor('从空白创建');
    terminal.write('\x1b[B\x1b[B\r'); await waitFor('预设名称');
    terminal.write('UI Writing\r'); await waitFor('审阅并保存');
    terminal.write('\x1b[B\x1b[B\r'); await waitFor('从预设添加资源');
    terminal.write('\r'); output = ''; await waitFor('审阅并保存');
    terminal.write('\x1b[B'.repeat(6) + '\r'); await waitFor('保存 UI Writing');
    output = ''; terminal.write('\r'); await waitFor('Ctrl+n 创建');
    assert.doesNotMatch(output, /迁移 Perfect Pi/);
    const config = JSON.parse(readFileSync(join(h.agentPath(agent), 'wardrobe/native.json')));
    assert.ok(Object.values(config.profiles).some(p => p.name === 'UI Writing'));
    assert.equal(config.default, 'original');
    output = ''; terminal.write('UI Writing\r'); await waitFor('Preset: UI Writing');
    terminal.write('/public-reader\r'); await waitFor('Public companion loaded');
    assert.equal(JSON.parse(readFileSync(join(h.agentPath(agent), 'wardrobe/native.json'))).default, 'original');
  } finally { terminal.kill('SIGTERM'); await new Promise(done => setTimeout(done, 100)); }
});

test('real TUI hands a Pi-authored draft to the current native model without saving or activating it', async () => {
  const h = harness(), agent = 'pi-author'; h.sandbox.seedAgent(agent);
  await h.pi.runOk(agent, ['install', resolve('packages/wardrobe')]);
  const setup = await h.pi.rpc(agent);
  try { await setup.command('wardrobe adopt --yes'); } finally { await setup.close(); }
  // Register the isolated local provider again on replacement sessions, as a
  // persistent native provider would be. No account model or network is used.
  const driver = join(h.sandbox.work, 'auto-local-driver.mjs');
  writeFileSync(driver, readFileSync(h.pi.ensureDriver(), 'utf8')
    .replace('pi.registerCommand("fixture-use-local", {\n    handler: async (_args, ctx) => {', 'const useLocal = async (_args, ctx) => {')
    .replace('    },\n  });\n  pi.registerCommand("fixture-prompt", {', '    };\n  pi.registerCommand("fixture-use-local", {handler: useLocal});\n  pi.on("session_start", async (_event, ctx) => useLocal("", ctx));\n  pi.registerCommand("fixture-prompt", {'));
  const terminal = pty.spawn(process.execPath, [h.runtime.cliPath, '--offline', '--no-session', '-e', driver], { cwd: h.sandbox.project, env: launchEnv(h, {}, agent), cols: 110, rows: 36 });
  let output = '', exited = false;
  terminal.onData(chunk => { output += chunk; }); terminal.onExit(() => { exited = true; });
  const waitFor = async text => {
    const until = Date.now() + 15000;
    while (!output.includes(text)) {
      assert.ok(!exited && Date.now() < until, 'TUI did not show ' + text + ': ' + output.slice(-3500));
      await new Promise(done => setTimeout(done, 25));
    }
  };
  try {
    await waitFor('Preset: 我的原始配置');
    terminal.write('/fixture-use-local\r');
    const originalDir = JSON.parse(readFileSync(join(h.agentPath(agent), 'wardrobe/native.json'))).profiles.original.agentDir;
    const chosen = join(originalDir, 'fixture-model.txt');
    const until = Date.now() + 10000;
    while (!existsSync(chosen)) { assert.ok(Date.now() < until, output.slice(-3500)); await new Promise(done => setTimeout(done, 25)); }
    output = ''; terminal.write('/wardrobe\r'); await waitFor('Ctrl+n 创建');
    terminal.write('\x0e'); await waitFor('让 Pi 创建');
    terminal.write('\x1b[B'.repeat(3) + '\r'); await waitFor('预设名称');
    terminal.write('Pi Writing\r'); await waitFor('让 Pi 如何修改这个预设');
    terminal.write('Prepare a writing preset\r'); await waitFor('fixture reply');
    const root = join(h.agentPath(agent), 'wardrobe'), drafts = readdirSync(join(root, 'drafts'));
    assert.equal(drafts.length, 1);
    const task = readFileSync(join(root, 'drafts', drafts[0], 'TASK.md'), 'utf8');
    assert.match(task, /Prepare a writing preset/);
    assert.match(task, /Do not run save --yes/);
    assert.equal(existsSync(join(root, 'drafts', drafts[0], 'source', 'TASK.md')), false);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(root, 'native.json'))).profiles), ['original']);
    assert.doesNotMatch(output, /Error:|errorMessage/);
  } finally { terminal.kill('SIGTERM'); await new Promise(done => setTimeout(done, 100)); }
});

test('the original environment is editable and portable while private files stay device-bound', async () => {
  const h = harness(), agent = 'original-edit'; h.sandbox.seedAgent(agent);
  const dir = h.agentPath(agent);
  mkdirSync(join(dir, 'skills/custom'), { recursive: true });
  writeFileSync(join(dir, 'skills/custom/SKILL.md'), '---\nname: custom\ndescription: Local skill\n---\nKeep this skill.\n');
  writeFileSync(join(dir, 'skills/custom/REFERENCE.md'), 'Keep this companion.\n');
  writeFileSync(join(dir, 'mcp.json'), '{"privateToken":"device-only"}');
  await h.pi.runOk(agent, ['install', resolve('packages/wardrobe')]);
  const session = await h.pi.rpc(agent);
  const latest = async () => (await session.readCustomEntries('wardrobe.native-result')).at(-1)?.data;
  try {
    await session.command('wardrobe adopt --yes');
    const originalKey = (await latest()).profile.presetKey;
    await session.command('wardrobe maintain original --prepare --request "Improve the local method while preserving custom skills and companions"');
    assert.equal((await latest()).status, 'REVIEW_REQUIRED', JSON.stringify(await latest()));
    await session.command('wardrobe edit original');
    const created = await latest();
    assert.equal(created.state, 'draft', JSON.stringify(created));
    assert.equal(readFileSync(join(created.draft.source, 'skills/custom/REFERENCE.md'), 'utf8'), 'Keep this companion.\n');
    const skill = join(created.draft.source, 'skills/custom/SKILL.md');
    writeFileSync(skill, readFileSync(skill, 'utf8') + 'Our improvement.\n');
    await session.command(`wardrobe save ${created.draft.id} --yes`);
    const saved = await latest();
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.profile.presetKey, originalKey);
    assert.match(readFileSync(saved.profile.selectedSkills[0], 'utf8'), /Our improvement/);
    assert.equal(readFileSync(join(dir, 'wardrobe/profiles/original/skills/custom/SKILL.md'), 'utf8').includes('Our improvement'), false);
    const destination = join(h.sandbox.home, 'original-portable');
    await session.command(`wardrobe export ${saved.profile.id} ${JSON.stringify(destination)}`);
    assert.equal((await latest()).ok, true, JSON.stringify(await latest()));
    assert.equal(existsSync(join(destination, 'mcp.json')), false);
    const manifest = JSON.parse(readFileSync(join(destination, 'package.json')));
    assert.equal(manifest.wardrobe.deviceBindings[0].target, 'mcp.json');
    assert.doesNotMatch(JSON.stringify(manifest), /device-only|original-edit/);
    await session.command(`wardrobe maintain ${saved.profile.id} --prepare --request "Improve the local method while preserving custom skills and companions"`);
    assert.equal((await latest()).status, 'REVIEW_REQUIRED', JSON.stringify(await latest()));
  } finally { await session.close(); }
});

test('a local Pi directory travels to another user without model/auth files or device binding values', async () => {
  const h = harness(), agent = 'other-user'; h.sandbox.seedAgent(agent);
  await h.pi.runOk(agent, ['install', resolve('packages/wardrobe')]);
  const source = join(h.sandbox.home, 'local pi source');
  mkdirSync(join(source, 'extensions'), { recursive: true });
  writeFileSync(join(source, 'settings.json'), JSON.stringify({ theme: 'dark', extensions: ['extensions/device.mjs'], defaultProvider: 'private', defaultModel: 'keep-native' }));
  writeFileSync(join(source, 'models.json'), '{"private":"not-exported"}');
  writeFileSync(join(source, 'auth.json'), '{"private":"not-exported"}');
  writeFileSync(join(source, 'mcp.json'), '{"privateToken":"device-one"}');
  writeFileSync(join(source, 'extensions/device.mjs'), "export default pi=>pi.registerCommand('portable-device',{handler:async()=>pi.appendEntry('portable.device',{ok:true})});\n");
  const first = await h.pi.rpc(agent);
  const latest = async session => (await session.readCustomEntries('wardrobe.native-result')).at(-1)?.data;
  const destination = join(h.sandbox.home, 'portable-device');
  try {
    await first.command('wardrobe adopt --yes');
    const originalKey = (await latest(first)).profile.presetKey;
    await first.command(`wardrobe import ${JSON.stringify(source)} --yes`);
    const imported = await latest(first);
    assert.equal(imported.ok, true, JSON.stringify(imported));
    assert.notEqual(imported.profile.presetKey, originalKey);
    await first.command(`wardrobe export ${imported.profile.id} ${JSON.stringify(destination)}`);
    assert.equal((await latest(first)).ok, true, JSON.stringify(await latest(first)));
    assert.equal(existsSync(join(destination, 'settings.json')), false);
    assert.equal(existsSync(join(destination, 'models.json')), false);
    assert.doesNotMatch(readFileSync(join(destination, 'package.json'), 'utf8'), /keep-native|device-one/);
  } finally { await first.close(); }
  const secondAgent = 'second-device'; h.sandbox.seedAgent(secondAgent);
  await h.pi.runOk(secondAgent, ['install', resolve('packages/wardrobe')]);
  const second = await h.pi.rpc(secondAgent);
  let profile;
  try {
    await second.command('wardrobe adopt --yes');
    await second.command(`wardrobe import ${JSON.stringify(destination)} --yes`);
    profile = (await latest(second)).profile;
    assert.ok(profile, JSON.stringify(await latest(second)));
    await second.command(`wardrobe use ${profile.id}`);
    assert.match((await latest(second)).error, /缺少设备绑定/);
    const config = join(h.agentPath(secondAgent), 'mcp.json'); writeFileSync(config, '{"privateToken":"device-two"}');
    await second.command(`wardrobe bind ${profile.id} mcp ${JSON.stringify(config)}`);
    assert.equal((await latest(second)).state, 'bound', JSON.stringify(await latest(second)));
    await second.command(`wardrobe default ${profile.id}`);
  } finally { await second.close(); }
  const restarted = await h.pi.rpc(secondAgent);
  restarted.agentDir = profile.agentDir;
  try {
    const names = await restarted.commandNames();
    await restarted.command('wardrobe current');
    assert.ok(names.includes('portable-device'), JSON.stringify({ names, current: await latest(restarted), resources: profile.resources, stderr: restarted.stderr }));
  }
  finally { await restarted.close(); }
});
