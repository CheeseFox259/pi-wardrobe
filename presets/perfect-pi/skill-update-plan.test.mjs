import assert from 'node:assert/strict';
import * as processBoundary from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createReconcileFixture } from './reconcile.mjs';
import { planSkillUpdates } from './scripts/plan-skill-updates.mjs';

function fixture(t, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-skill-plan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = createReconcileFixture(dir, { commits: [
    { name: 'base', files: { 'skills/grilling/SKILL.md': '# Stable skill\n', 'skills/grilling/template.sh': 'first=base\n\n\nlast=base\n' } },
    { name: 'target', files: { 'skills/grilling/template.sh': 'first=base\n\n\nlast=upstream\n', ...files } },
  ], localContent: '# Stable skill\n' });
  writeFileSync(join(f.projectDir, 'skills/grilling/template.sh'), 'first=local\n\n\nlast=base\n');
  return f;
}

test('one plan merges changed companions and preserves local custom files without changing source or lineage', async t => {
  const f = fixture(t);
  writeFileSync(join(f.projectDir, 'skills/grilling/custom.md'), 'Keep my custom workflow.\n');
  const before = readFileSync(join(f.projectDir, 'components.json'), 'utf8');
  const report = await planSkillUpdates({ root: f.projectDir });
  assert.equal(report.ok, true);
  assert.equal(report.repositories.length, 1);
  assert.equal(report.repositories[0].targetRef, f.commitShas.target);
  const script = report.skills[0].files.find(x => x.path.endsWith('template.sh'));
  assert.equal(script.status, 'merged');
  assert.equal(script.mergedContent, 'first=local\n\n\nlast=upstream\n');
  assert.equal(report.skills[0].files.find(x => x.path.endsWith('custom.md')).status, 'local-preserved');
  assert.equal(readFileSync(join(f.projectDir, 'skills/grilling/template.sh'), 'utf8'), 'first=local\n\n\nlast=base\n');
  assert.equal(readFileSync(join(f.projectDir, 'components.json'), 'utf8'), before);
  assert.deepEqual(report.summary.changedSkills, ['grilling']);
});

test('offline replay uses recorded pins without claiming a fresh upstream check', async t => {
  const f = fixture(t);
  const report = await planSkillUpdates({ root: f.projectDir, offline: true });
  assert.equal(report.ok, true);
  assert.equal(report.repositories[0].targetRef, f.baseSha);
  assert.equal(report.repositories[0].freshness, 'not-checked');
  assert.equal(report.metrics.blobReads, 0);
  assert.deepEqual(report.summary.changedSkills, []);
});

test('conflicts in companions block the plan, and binary additions stay byte-exact', async t => {
  const f = fixture(t, { 'skills/grilling/icon.bin': Buffer.from([0, 255, 24]) });
  writeFileSync(join(f.projectDir, 'skills/grilling/template.sh'), 'first=base\n\n\nlast=local\n');
  const report = await planSkillUpdates({ root: f.projectDir });
  assert.equal(report.ok, false);
  assert.equal(report.summary.conflicts, 1);
  assert.equal(report.skills[0].files.find(f => f.path.endsWith('template.sh')).status, 'conflict');
  const binary = report.skills[0].files.find(f => f.path.endsWith('icon.bin'));
  assert.equal(binary.status, 'upstream-add');
  assert.deepEqual(Buffer.from(binary.contentBase64, 'base64'), Buffer.from([0, 255, 24]));
});

test('missing offline objects are blocked rather than treated as an unchanged skill', async t => {
  const f = fixture(t);
  const report = await planSkillUpdates({ root: f.projectDir, offline: true, targets: { [f.upstreamDir]: 'a'.repeat(40) } });
  assert.equal(report.ok, false);
  assert.equal(report.summary.blocked, 1);
});

test('a symlinked skill ancestor is rejected without reading outside source', async t => {
  const { renameSync, symlinkSync } = await import('node:fs');
  const f = fixture(t);
  renameSync(join(f.projectDir, 'skills'), join(f.baseDir, 'outside-skills'));
  symlinkSync(join(f.baseDir, 'outside-skills'), join(f.projectDir, 'skills'));
  const report = await planSkillUpdates({ root: f.projectDir });
  assert.equal(report.ok, false);
  assert.equal(report.summary.blocked, 1);
});

test('retired upstream skills and their companions remain present with the old base', async t => {
  const { execFileSync } = await import('node:child_process');
  const f = fixture(t);
  execFileSync('git', ['-C', f.upstreamDir, 'rm', '-r', 'skills/grilling']);
  execFileSync('git', ['-C', f.upstreamDir, 'commit', '-m', 'retire skill']);
  const report = await planSkillUpdates({ root:f.projectDir });
  assert.deepEqual(report.summary.retired, ['grilling']);
  assert.equal(report.skills[0].baseRef, f.baseSha);
  assert.ok(report.skills[0].files.every(f => f.status === 'retired-retained'));
  assert.equal(readFileSync(join(f.projectDir,'skills/grilling/SKILL.md'),'utf8'), '# Stable skill\n');
});

test('multiple skills share repository objects and mode-only updates are visible', async t => {
  const { execFileSync } = await import('node:child_process');
  const f = fixture(t);
  execFileSync('git', ['-C', f.upstreamDir, 'update-index', '--chmod=+x', 'skills/grilling/SKILL.md']);
  execFileSync('git', ['-C', f.upstreamDir, 'commit', '-m', 'make executable']);
  const c = JSON.parse(readFileSync(join(f.projectDir,'components.json')));
  c.skills.second = {...c.skills.grilling,localPath:'skills/second/SKILL.md'};
  writeFileSync(join(f.projectDir,'components.json'),JSON.stringify(c));
  mkdirSync(join(f.projectDir,'skills/second'));
  writeFileSync(join(f.projectDir,'skills/second/SKILL.md'),'# Stable skill\n');
  const report = await planSkillUpdates({root:f.projectDir});
  assert.equal(report.repositories.length,1);
  assert.equal(report.summary.skills,2);
  assert.ok(report.summary.changedSkills.includes('second'));
  assert.equal(report.skills[0].files.find(f => f.path.endsWith('SKILL.md')).modeChanged,true);
  assert.equal(report.metrics.blobReads,2,'shared changed companion blobs should be read once');
});

test('a misspelled CLI skill selector cannot claim a successful empty plan', t => {
  const { spawnSync } = processBoundary;
  const f = fixture(t);
  const result = spawnSync(process.execPath,[join(import.meta.dirname,'reconcile.mjs'),'plan','missing-skill','--root',f.projectDir,'--offline','--json'],{encoding:'utf8'});
  assert.notEqual(result.status,0);
});

test('a missing local skill entry is blocked instead of returning a clean update plan', async t => {
  const f = fixture(t);
  rmSync(join(f.projectDir,'skills/grilling/SKILL.md'));
  const report = await planSkillUpdates({root:f.projectDir});
  assert.equal(report.ok,false);
  assert.equal(report.summary.blocked,1);
});
