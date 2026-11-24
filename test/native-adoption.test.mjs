import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { adoptOriginal } from '../packages/wardrobe/src/native-adoption.mjs';

for (const prefix of ['-', '!']) test(`original adoption preserves ${prefix} exclusions without requiring their targets`, t => {
  const root = mkdtempSync(join(tmpdir(), 'wardrobe-excluded-resource-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nativeDir = join(root, 'agent');
  mkdirSync(nativeDir);
  const absentSkill = join(root, '.agents/skills/archify/SKILL.md');
  const disabledSkill = join(root, '.agents/skills/disabled/SKILL.md');
  mkdirSync(join(root, '.agents/skills/disabled'), { recursive: true });
  writeFileSync(disabledSkill, 'Disabled skill.');
  const settings = { skills: [prefix + absentSkill, prefix + disabledSkill, prefix + 'skills/removed/SKILL.md'], extensions: [prefix + join(root, 'removed.mjs')], defaultModel: 'native-model' };
  writeFileSync(join(nativeDir, 'settings.json'), JSON.stringify(settings));
  const result = adoptOriginal(nativeDir);
  assert.equal(result.state, 'adopted');
  assert.deepEqual(result.profile.localDependencies, []);
  const archived = JSON.parse(readFileSync(join(result.profile.agentDir, 'settings.json')));
  assert.deepEqual(archived.skills, [prefix + absentSkill, prefix + disabledSkill, prefix + join(result.profile.agentDir, 'skills/removed/SKILL.md')]);
  assert.deepEqual(archived.extensions, settings.extensions);
  assert.equal(JSON.parse(readFileSync(join(nativeDir, 'settings.json'))).defaultModel, 'native-model');
  assert.equal(existsSync(absentSkill), false);
  rmSync(result.profile.agentDir, { recursive: true });
  const restored = adoptOriginal(nativeDir, { restore: true });
  assert.equal(restored.state, 'restored');
  assert.deepEqual(restored.profile.localDependencies, []);
});

test('original adoption still rejects a missing enabled local resource without changing native settings', t => {
  const root = mkdtempSync(join(tmpdir(), 'wardrobe-missing-resource-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settingsPath = join(root, 'settings.json');
  const settings = JSON.stringify({ skills: ['+' + join(root, 'missing/SKILL.md')] });
  writeFileSync(settingsPath, settings);
  assert.throws(() => adoptOriginal(root), /这些本机依赖已丢失/);
  assert.equal(readFileSync(settingsPath, 'utf8'), settings);
  assert.equal(existsSync(join(root, 'wardrobe/native.json')), false);
  assert.equal(existsSync(join(root, 'wardrobe/profiles/original')), false);
});
