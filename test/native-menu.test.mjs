import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleNativeCommand, recordNativeSession } from '../packages/wardrobe/src/native-flow.mjs';
import { NativeStore } from '../packages/wardrobe/src/native-store.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wardrobe-menu-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new NativeStore(dir);
  const profile = { id: 'original', name: '我的原始配置', version: '1.0.0', kind: 'original' };
  store.save({ schemaVersion: 1, initialized: true, profiles: { original: profile }, projects: {}, default: 'original' });
  const menus = [], notices = [], entries = [], widgets = [];
  const ctx = { cwd: dir, ui: {
    select: async (title, options) => { menus.push({ title, options }); },
    notify: text => notices.push(text),
    setWidget: (...args) => widgets.push(args), setStatus() {},
  }, sessionManager: { getSessionId: () => 'menu-session', getSessionFile: () => null, getBranch: () => [] } };
  const pi = { appendEntry: (type, data) => entries.push({ type, data }) };
  return { store, ctx, pi, menus, notices, entries, widgets };
}

test('wardrobe offers short preset actions and leaves runtime updates to Pi', async t => {
  const f = fixture(t);
  await handleNativeCommand(f.pi, '', f.ctx, f.store);
  assert.equal(f.menus[0].title, 'Wardrobe');
  assert.ok(f.menus[0].options.includes('创建'));
  assert.ok(f.menus[0].options.includes('导入'));
  assert.ok(!f.menus[0].options.some(label => /迁移|更新 preset|搜索/.test(label)));
  await handleNativeCommand(f.pi, 'help', f.ctx, f.store);
  assert.equal(f.menus.at(-1).title, 'Wardrobe');
  await handleNativeCommand(f.pi, 'updates', f.ctx, f.store);
  assert.ok(!f.menus.at(-1).options.some(label => /Pi 本体|Wardrobe 扩展/.test(label)));
  for (const command of ['update-pi', 'update-manager']) {
    await handleNativeCommand(f.pi, command, f.ctx, f.store);
    assert.equal(f.entries.at(-1).data.state, 'native-update');
    assert.match(f.notices.at(-1), /pi update/);
  }
});

test('preset list groups revisions and distinguishes unrelated same-name presets', async t => {
  const f = fixture(t), config = f.store.read();
  config.profiles.first = { id: 'first', name: 'Same', version: '1.0.0', presetKey: 'one', source: { locator: 'invalid' } };
  config.profiles.second = { ...config.profiles.first, id: 'second', maintenance: {} };
  config.profiles.third = { ...config.profiles.first, id: 'third', presetKey: 'two' };
  f.store.save(config);
  f.ctx.isIdle = () => true;
  f.ctx.ui.select = async (title, options) => {
    f.menus.push({ title, options });
  };
  await handleNativeCommand(f.pi, '', f.ctx, f.store);
  assert.equal(new Set(f.menus[0].options).size, f.menus[0].options.length);
  assert.deepEqual(f.menus[0].options.filter(label => label.startsWith('Same')), ['Same · second', 'Same · third']);
});

test('the current preset is visible beside the composer independently of the footer', t => {
  const f = fixture(t);
  recordNativeSession(f.pi, f.ctx, f.store);
  assert.deepEqual(f.widgets, [['wardrobe', ['Preset: 我的原始配置'], { placement: 'aboveEditor' }]]);
});
