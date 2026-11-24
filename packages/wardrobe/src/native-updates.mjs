import { PlanStore } from './approval.mjs';
import { parseSource } from './identity.mjs';
import { resolveNpmPackage } from './npm-source.mjs';
import { digestOf, sealPlan } from './plan.mjs';
import { resolveNativeSource } from './native-source.mjs';
import { nativeEnv } from './native-service.mjs';

export function profilePlan(store, profile) {
  if (!profile.revision) throw new Error('原始本机配置不是已锁定的上游 preset；先导入标准 preset，再升级其中的资源包。');
  return new PlanStore(store.nativeDir).read(profile.revision);
}

export async function reviewResourceUpgrade(store, profile, alias, target) {
  const base = profilePlan(store, profile), surface = base.installationSurfaces.find(entry => entry.alias === alias);
  if (!surface) throw new Error('没有此资源包：' + alias);
  if (surface.source === '.') throw new Error('此资源随 preset 一起发布，请更新整套 preset。');
  const env = nativeEnv(store);
  const resolved = await resolveNativeSource(target || surface.source, env, { latest: !target });
  const parsed = parseSource(resolved.exact), previous = parseSource(surface.source);
  if (parsed.kind !== previous.kind || (parsed.kind === 'npm' ? parsed.package !== previous.package : parsed.url !== previous.url)) throw new Error('单包升级必须保留原包身份；更换包请导入另一个 preset。');
  if (resolved.exact === surface.source) return null;
  let updated;
  if (parsed.kind === 'npm') {
    const meta = await resolveNpmPackage({ name: parsed.package, version: parsed.version, registry: env.WARDROBE_REGISTRY });
    updated = { ...surface, source: resolved.exact, resolvesTo: resolved.exact, artifact: { kind: 'npm', tarball: meta.tarball, integrity: meta.integrity }, installsCode: meta.hasInstallScript, scripts: Object.keys(meta.scripts) };
  } else updated = { ...surface, source: resolved.exact, resolvesTo: parsed.url, artifact: { kind: 'git', url: parsed.url, commit: parsed.ref } };
  const { digest, approved, planId, ...body } = structuredClone(base);
  const overrides = { ...(profile.overrides ?? {}), [alias]: resolved.exact };
  const tag = digestOf({ parent: profile.id, overrides }).slice(0, 12);
  body.identity = { source: 'local:wardrobe', id: 'derived/' + tag };
  body.declaration = { ...body.declaration, name: base.declaration.name.replace(/ · 本地派生$/, '') + ' · 本地派生', version: base.declaration.version.replace(/\+.*/, '') + '+local.' + tag };
  // This is a local reviewed delta, never a claim that the author's Git tree changed.
  body.source = { ...body.source, kind: 'local-derivative', parent: profile.id, overrides };
  body.installationSurfaces = body.installationSurfaces.map(entry => entry.alias === alias ? updated : entry);
  body.artifacts = [...body.installationSurfaces.map(entry => entry.artifact.kind === 'npm' ? entry.artifact.tarball : entry.artifact.url + '@' + entry.artifact.commit), ...body.resourceSelectors.flatMap(entry => entry.loaded.map(path => entry.package + ':' + path))].sort();
  body.executable = { ...body.executable, packages: body.installationSurfaces.map(entry => `${entry.alias}:${entry.source === '.' ? entry.resolvesTo : entry.source}`).sort() };
  const plan = sealPlan({ ...body, planId: digestOf({ parent: profile.id, overrides }).slice(0, 16) });
  new PlanStore(store.nativeDir).save(plan);
  return { plan, overrides, alias, before: surface.source, after: resolved.exact };
}

export async function rebaseResourceOverrides(store, old, reviewed, ctx) {
  if (!old.overrides || !Object.keys(old.overrides).length) return { ...reviewed, overrides: null };
  const base = new PlanStore(store.nativeDir).read(old.upstreamPlan || old.upstream || old.parent);
  let candidate = { id: reviewed.plan.planId, revision: reviewed.plan.planId };
  const overrides = {};
  for (const [alias, source] of Object.entries(old.overrides)) {
    const before = base.installationSurfaces.find(entry => entry.alias === alias);
    const after = reviewed.plan.installationSurfaces.find(entry => entry.alias === alias);
    if (!after || before?.source !== after.source && after.source !== source) {
      const choice = await ctx.ui.select('上游冲突：' + alias, ['保留本地升级：' + source, '采用上游：' + (after?.source || '已移除'), '取消更新']);
      if (!choice || choice === '取消更新') return null;
      if (choice.startsWith('采用上游')) continue;
      if (!after) throw new Error('上游移除了此包；保留本地包需要显式调整 preset，已取消更新。');
    }
    overrides[alias] = source;
    const delta = await reviewResourceUpgrade(store, candidate, alias, source);
    if (delta) candidate = { id: delta.plan.planId, revision: delta.plan.planId };
  }
  return { ...reviewed, plan: new PlanStore(store.nativeDir).read(candidate.revision), upstreamPlan: reviewed.plan.planId, overrides };
}
