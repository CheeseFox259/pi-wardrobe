import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PlanStore } from './approval.mjs';
import { activateAgentFiles, packageRootFor } from './agent-files.mjs';
import { artifactEnvironment, preserveGitArtifacts } from './native-artifacts.mjs';
import { supportsPi } from './semver.mjs';
import { prepareNativeImport } from './native-source.mjs';
import { installApprovedPlan } from './install.mjs';
import { activatedSettingsFor } from './launch.mjs';
import { EXCLUSIONS } from './lock.mjs';
import { readJson, writeJson } from './native-store.mjs';
import { validateBindings } from './native-bindings.mjs';
import { checkNativeResourceExports } from './native-resource-exports.mjs';
import { currentPiCli, currentPiVersion, checkPreparedProfile, resourceConfiguration } from './native-runtime.mjs';
export { currentPiCli, currentPiVersion, checkPreparedProfile } from './native-runtime.mjs';

export function nativeEnv(store, plan = null) {
  return artifactEnvironment(store, plan, { ...process.env, PI_CODING_AGENT_DIR: store.nativeDir, WARDROBE_AGENT_DIR: store.nativeDir,
    WARDROBE_PI_CLI: currentPiCli(), WARDROBE_REGISTRY: process.env.WARDROBE_REGISTRY || 'https://registry.npmjs.org/' });
}

export async function reviewNativeImport(store, source, presetPath = null, options = {}) {
  return prepareNativeImport(store, source, nativeEnv(store), { presetPath, ...options });
}

export async function installNativePlan(store, plan, { source, parent = null, onProgress, repair = false, requiredResources = [] } = {}) {
  const existingProfile = store.read().profiles[plan.planId];
  if (existingProfile && !repair && !requiredResources.length) { checkPreparedProfile(existingProfile); return existingProfile; }
  const materialized = await materializeNativePlan(store, plan, {source,parent,onProgress,requiredResources});
  return promoteNativePlan(store, materialized);
}

/** Prepare the actual installation at its stable path without registering or selecting it. */
export async function materializeNativePlan(store, plan, { source, parent = null, onProgress, requiredResources = [], env, reuseStage } = {}) {
  const existingProfile = store.read().profiles[plan.planId];
  const cli = nativeEnv(store).WARDROBE_PI_CLI;
  const manifest = JSON.parse(readFileSync(join(dirname(cli), '..', 'package.json'), 'utf8'));
  if (supportsPi(plan.declaration.compatibility.pi, manifest.version) !== true) throw new Error('Preset 与当前 Pi ' + manifest.version + ' 不兼容：' + plan.declaration.compatibility.pi);
  if (plan.declaration.compatibility.platforms?.length && !plan.declaration.compatibility.platforms.some(platform => platform === process.platform || platform === process.platform + '-' + process.arch)) throw new Error('Preset 不支持当前平台：' + process.platform);
  const approved = new PlanStore(store.nativeDir).approve({ planId: plan.planId, digest: plan.digest });
  let reuseNpm = null;
  if(parent && store.read().profiles[parent]?.revision){
    const ancestor=store.read().profiles[parent], previous=new PlanStore(store.nativeDir).read(ancestor.revision);
    const npmSources=p=>p.installationSurfaces.map(e=>e.resolvesTo||e.source).filter(source=>source.startsWith('npm:')).sort();
    if(npmSources(plan).length && JSON.stringify(npmSources(plan))===JSON.stringify(npmSources(previous))){
      try{checkPreparedProfile(ancestor);if(existsSync(join(ancestor.agentDir,'npm')))reuseNpm=ancestor.agentDir;}catch{ /* A drifted parent is never reused. */ }
    }
  }
  if(reuseStage){
    const npmSources=p=>p.installationSurfaces.map(e=>e.resolvesTo||e.source).filter(s=>s.startsWith('npm:')).sort();
    if(JSON.stringify(npmSources(plan))===JSON.stringify(npmSources(reuseStage.plan))){
      try{checkPreparedProfile(reuseStage.profile);if(existsSync(join(reuseStage.profile.agentDir,'npm')))reuseNpm=reuseStage.profile.agentDir;}catch{/* Never reuse drifted dependencies. */}
    }
  }
  const environment = env ? artifactEnvironment(store,plan,env) : nativeEnv(store,plan);
  const installed = await installApprovedPlan({ reuseNpm, plan: approved, agentDir: store.nativeDir, env: environment, registry: environment.WARDROBE_REGISTRY, onProgress });
  if (installed.state !== 'available') throw new Error(installed.record.attempts.at(-1)?.failure?.message || 'Preset installation failed; inspect /wardrobe doctor');
  const attempt=installed.record.attempts.at(-1);
  const resources=await checkNativeResourceExports({plan,requiredResources,inventory:attempt.installed.map(entry=>({...entry,installedPath:entry.installedRelative?join(attempt.agentDir,entry.installedRelative):entry.installedPath})),cli,inspectionRoot:join(store.root,'resource-checks',plan.planId)});
  await preserveGitArtifacts(store, plan, installed.record, environment);
  const prepared = registerInstalledNative(store, plan, installed.record, { source, parent, persist: false });
  const profile = existingProfile ? { ...existingProfile, ...prepared, kind: existingProfile.kind, overrides: existingProfile.overrides, upstream: existingProfile.upstream, upstreamPlan: existingProfile.upstreamPlan } : prepared;
  return {profile,plan,record:installed.record,resources};
}

/** Promote the same measured artifact; no network, re-resolution or install scripts. */
export function promoteNativePlan(store, {profile}) {
  checkPreparedProfile(profile);
  const config=store.read();config.profiles[profile.id]=profile;store.save(config);
  return profile;
}

export function registerInstalledNative(store, plan, record, { source, parent = null, persist = true } = {}) {
  const latest = record.attempts.at(-1), agentDir = latest.agentDir;
  const inventory = latest.installed.map(entry => ({ ...entry, installedPath: entry.installedRelative ? join(agentDir, entry.installedRelative) : entry.installedPath }));
  const previous = JSON.parse(readFileSync(join(agentDir, 'settings.json')));
  const settings = activatedSettingsFor({ plan, inventory, previous });
  for (const key of ['defaultProvider', 'defaultModel', 'enabledModels', 'modelThinkingLevels', 'defaultThinkingLevel', 'thinkingBudgets']) delete settings[key];
  activateAgentFiles({ plan, inventory, agentDir });
  writeJson(join(agentDir, 'settings.json'), settings);
  const selectedSkills = [], resources = [];
  for (const selector of plan.resourceSelectors) {
    const entry = inventory.find(item => item.alias === selector.package), root = packageRootFor(plan, entry);
    for (const relative of selector.loaded) {
      const path = join(root, relative), info = lstatSync(path);
      resources.push({ path, size: info.size, mtimeMs: info.mtimeMs });
      if (selector.kind === 'skills') selectedSkills.push(path);
    }
  }
  const profile = { id: plan.planId, name: plan.declaration.name, version: plan.declaration.version, kind: 'revision',
    agentDir, revision: plan.planId, source: { ...(typeof source === 'object' ? source : { locator: source || plan.source.locator, presetPath: plan.source.declarationPath }), commit: source?.commit || plan.source.commit },
    compatibility: plan.declaration.compatibility, selectedSkills, resources, persona: (plan.persona?.append ?? []).map(entry => typeof entry === 'string' ? entry : entry.text),
    parent, verifiedAt: new Date().toISOString(), verification: 'install', createdAt: new Date().toISOString() };
  profile.presetKey = source?.kind === 'local' ? source.id : (source?.locator || plan.source.locator) + '#' + plan.identity.id;
  profile.deviceBindings = validateBindings(plan.agent?.deviceBindings || inventory.flatMap(entry => readJson(join(packageRootFor(plan, entry), 'package.json'), {}).wardrobe?.deviceBindings || []));
  profile.cache = join(store.root, 'cache', profile.id + '.json');
  writeJson(profile.cache, { node: process.version, pi: currentPiVersion(), platform: process.platform, stamps: codeStamps(agentDir, plan), verifiedAt: profile.verifiedAt, configuration: resourceConfiguration(agentDir), agentFiles: (plan.agent?.files ?? []).filter(file => !file.mutable) });
  if (persist) { const config = store.read(); config.profiles[profile.id] = profile; store.save(config); }
  return profile;
}

function codeStamps(agentDir, plan) {
  const stamps = [];
  const walk = relative => {
    const path = join(agentDir, relative), parts = relative.split('/');
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info || EXCLUSIONS.some(rule => rule.test(parts) || info.isDirectory() && rule.directory?.(parts))) return;
    stamps.push([relative, info.size, info.mtimeMs, info.ctimeMs, info.mode, info.isSymbolicLink() ? readlinkSync(path) : null]);
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) walk(relative + '/' + name);
  };
  for (const root of ['npm', 'git']) walk(root);
  for (const file of plan?.agent?.files ?? []) if (!file.mutable) walk(file.target);
  return stamps;
}

export function refreshProfileCache(profile, plan, record) {
  const latest = record.attempts.at(-1);
  const inventory = latest.installed.map(entry => ({ ...entry, installedPath: entry.installedRelative ? join(profile.agentDir, entry.installedRelative) : entry.installedPath }));
  const expected = activatedSettingsFor({ plan, inventory });
  const configuration = resourceConfiguration(profile.agentDir);
  const approved = Object.fromEntries(['packages', 'extensions', 'skills', 'prompts', 'themes'].filter(key => Object.hasOwn(expected, key)).map(key => [key, expected[key]]));
  if (JSON.stringify(configuration) !== JSON.stringify(approved)) throw new Error('资源配置与已审核计划不一致；请用 /wardrobe repair 恢复原固定版本，或导入新的 preset。');
  writeJson(profile.cache, { node: process.version, pi: currentPiVersion(), platform: process.platform, stamps: codeStamps(profile.agentDir, plan), configuration, agentFiles: (plan.agent?.files ?? []).filter(file => !file.mutable), verifiedAt: new Date().toISOString() });
}
