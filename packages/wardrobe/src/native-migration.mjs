import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { preserveGitArtifacts } from './native-artifacts.mjs';
import { PlanStore } from './approval.mjs';
import { diagnoseRevision } from './doctor.mjs';
import { StagingStore, verifyPlanConfinement } from './staging.mjs';
import { nativeEnv, registerInstalledNative } from './native-service.mjs';
import { readJson } from './native-store.mjs';

export function perfectPiMigrationPreview(store, sourceDir = join(process.env.HOME, '.pi/wardrobe-perfect-pi')) {
  sourceDir = resolve(sourceDir);
  const state = readJson(join(sourceDir, 'wardrobe/perfect-pi.json'));
  if (!state?.revision) throw new Error('未找到现有 Perfect Pi 安装：' + sourceDir);
  const record = new StagingStore(sourceDir).read(state.revision);
  const plan = new PlanStore(sourceDir).read(state.revision);
  if (!record || record.state !== 'available') throw new Error('现有 Perfect Pi 修订不可用；请先修复旧安装。');
  verifyPlanConfinement({ stagingRoot: join(sourceDir, 'wardrobe/staging'), planId: record.planId, attemptDirs: [record.attempts.at(-1).agentDir] });
  return { sourceDir, revision: state.revision, name: plan.declaration.name, version: plan.declaration.version, record, plan };
}

export async function migratePerfectPi(store, preview) {
  if (store.read().profiles[preview.revision]) return store.read().profiles[preview.revision];
  const report = await diagnoseRevision(preview.record, { env: nativeEnv(store), plan: preview.plan });
  if (report.state !== 'available') throw new Error('旧安装完整校验未通过：' + report.state);
  const old = preview.record.attempts.at(-1), records = new StagingStore(store.nativeDir);
  const target = records.attemptDir(preview.revision, 1);
  if (existsSync(target)) throw new Error('目标修订已存在；请检查 /wardrobe doctor 后重试。');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  try {
    const privateName = /^(?:auth\.json|models(?:-store)?\.json|\.env(?:\..*)?|\.npmrc|\.netrc|credentials(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/;
    for (const kind of ['npm', 'git']) if (existsSync(join(old.agentDir, kind))) cpSync(join(old.agentDir, kind), join(target, kind), { recursive: true, verbatimSymlinks: true, filter: path => !privateName.test(basename(path)) });
    cpSync(join(old.agentDir, 'settings.json'), join(target, 'settings.json'));
    // Re-render package-owned agent files for the new path; do not copy model/auth stores.
    const copied = JSON.parse(JSON.stringify({ ...preview.record, attempts: [{ ...old, attempt: 1, agentDir: target }] }).split(old.agentDir).join(target));
    new PlanStore(store.nativeDir).save(preview.plan);
    const profile = registerInstalledNative(store, preview.plan, copied, { source: { locator: 'github:CheeseFox259/pi-wardrobe', ref: 'HEAD', presetPath: 'presets/perfect-pi/preset.json', commit: preview.plan.source.commit, migratedFrom: preview.sourceDir }, persist: false });
    const copiedReport = await diagnoseRevision(copied, { env: nativeEnv(store), plan: preview.plan });
    if (copiedReport.state !== 'available') throw new Error('迁移副本完整校验未通过：' + copiedReport.state);
    await preserveGitArtifacts(store, preview.plan, copied, nativeEnv(store));
    records.write(copied);
    const config = store.read(); config.profiles[profile.id] = profile; store.save(config);
    return profile;
  } catch (error) { rmSync(target, { recursive: true, force: true }); throw error; }
}
