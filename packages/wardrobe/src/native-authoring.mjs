import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, writeJson } from './native-store.mjs';
import { currentPiCli, currentPiVersion, checkPreparedProfile, nativeEnv, reviewNativeImport, installNativePlan } from './native-service.mjs';
import { copyPublicSource, inspectPublicSource, withLocalSnapshot, sourceDigest } from './native-snapshot.mjs';
import { PlanStore } from './approval.mjs';
import { StagingStore } from './staging.mjs';
import { packageRootFor, presetPreferences } from './agent-files.mjs';
import { ownedManager } from './native-adoption.mjs';
import { bindDevice, deviceValues, validateBindings } from './native-bindings.mjs';
import { parseSource } from './identity.mjs';

const KINDS = ['extensions', 'skills', 'prompts', 'themes'];
const within = (root, path) => { const rel = relative(root, path); return !rel.startsWith('..') && !isAbsolute(rel); };
const updateRecord = (store, draft) => { writeJson(join(store.root, 'drafts', draft.id, 'draft.json'), draft); return draft; };

export function draftRecord(store, id) {
  if (!/^[\w-]+$/.test(id || '')) throw new Error('无效草稿');
  const record = readJson(join(store.root, 'drafts', id, 'draft.json'));
  if (!record || record.id !== id) throw new Error('草稿不存在');
  return record;
}

export function createDraft(store, { name = '新预设' } = {}) {
  const id = randomUUID(), root = join(store.root, 'drafts', id), source = join(root, 'source');
  mkdirSync(source, { recursive: true, mode: 0o700 });
  const definition = { schemaVersion: 1, id: 'local/' + id, name, version: '1.0.0', compatibility: { pi: '>=' + currentPiVersion() }, packages: { self: { source: '.' } }, resources: [] };
  writeJson(join(source, 'preset.json'), definition);
  writeJson(join(source, 'package.json'), { name: 'wardrobe-local-' + id, version: '1.0.0', pi: {}, wardrobe: { agent: { schemaVersion: 1, files: [], settings: {} } } });
  const record = { id, source, presetId: definition.id, name, createdAt: new Date().toISOString() };
  writeJson(join(root, 'draft.json'), record); return record;
}

export function readDraft(store, id) {
  const draft = draftRecord(store, id), { definition, manifest } = draftFiles(draft);
  const catalog = [...(draft.available || []), ...(manifest.wardrobe?.resourceCatalog || [])];
  const available = definition.resources.flatMap((r, selector) => [...new Set([...(r.include || []), ...catalog.filter(item => item.package === r.package && item.kind === r.kind && typeof item.path === 'string').map(item => item.path)])].map(path => ({ selector, path, kind: r.kind, package: r.package })));
  updateRecord(store, { ...draft, available });
  return { ...draft, definition, manifest, available, bindings: validateBindings(manifest.wardrobe?.deviceBindings), preferences: presetPreferences(manifest.wardrobe?.agent?.settings || {}) };
}

export function editDraft(store, id, change) {
  const draft = readDraft(store, id), { definition, manifest } = draft;
  if(draft.saved)throw new Error('草稿已保存，请从已保存的预设创建编辑草稿');
  if (change.name !== undefined) { if (!change.name.trim()) throw new Error('请填写预设名称'); definition.name = change.name.trim(); }
  if (change.resource !== undefined) {
    const item = draft.available[change.resource]; if (!item) throw new Error('资源不存在');
    const selected = definition.resources[item.selector].include;
    definition.resources[item.selector].include = selected.includes(item.path) ? selected.filter(path => path !== item.path) : [...selected, item.path];
    if (item.package === 'self' && definition.resources[item.selector].include.includes(item.path)) {
      manifest.pi ||= {};
      manifest.pi[item.kind] = [...new Set([...(manifest.pi[item.kind] || []), item.path])];
    }
    if (item.kind === 'skills' && item.package === 'self') {
      const path = join(draft.source, 'components.json'), components = readJson(path);
      if (components) {
        for (const skill of Object.values(components.skills || {})) if (skill.localPath === item.path) skill.enabled = definition.resources[item.selector].include.includes(item.path);
        writeJson(path, components);
      }
    }
  }
  if (change.preferences) {
    const preferences = presetPreferences(change.preferences);
    if (Object.keys(preferences).length !== Object.keys(change.preferences).length) throw new Error('偏好含有不支持或属于 Pi 的字段');
    manifest.wardrobe ||= {}; manifest.wardrobe.agent ||= { schemaVersion: 1, files: [], settings: {} }; manifest.wardrobe.agent.settings = preferences;
  }
  if (change.bindings) { manifest.wardrobe ||= {}; manifest.wardrobe.deviceBindings = validateBindings(change.bindings); }
  saveFiles(draft, definition, manifest); return readDraft(store, id);
}

export async function addProfileResources(store, id, profile) {
  const target = readDraft(store, id);
  if(target.saved)throw new Error('草稿已保存，请从已保存的预设创建编辑草稿');
  const imported = await draftFromProfile(store, profile, { copy: true, hidden: true });
  const from = readDraft(store, imported.id), prefix = 'imports/' + imported.id;
  copyPublicSource(imported.source, join(target.source, prefix));
  mergeDependencies(target.manifest, from.manifest);
  const aliases = {};
  for (const [alias, value] of Object.entries(from.definition.packages)) {
    if (value.source === '.') { aliases[alias] = 'self'; continue; }
    const present = Object.entries(target.definition.packages).find(([, entry]) => entry.source === value.source);
    const key = present?.[0] || 'import-' + Object.keys(target.definition.packages).length;
    target.definition.packages[key] = value; aliases[alias] = key;
  }
  for (const resource of from.definition.resources) {
    const selector = { ...resource, package: aliases[resource.package], include: (resource.include || []).map(path => from.definition.packages[resource.package].source === '.' ? prefix + '/' + path : path) };
    let index = target.definition.resources.findIndex(item => item.package === selector.package && item.kind === selector.kind);
    if (index >= 0) target.definition.resources[index].include = [...new Set([...(target.definition.resources[index].include || []), ...selector.include])];
    else { index = target.definition.resources.length; target.definition.resources.push(selector); }
    target.available.push(...selector.include.map(path => ({ selector: index, path, package: selector.package, kind: selector.kind })));
  }
  for (const kind of KINDS) target.manifest.pi[kind] = target.definition.resources.filter(r => r.package === 'self' && r.kind === kind).flatMap(r => r.include || []);
  target.manifest.wardrobe ||= {}; target.manifest.wardrobe.deviceBindings ||= [];
  for (const binding of from.bindings) {
    const old = target.manifest.wardrobe.deviceBindings.find(item => item.id === binding.id || item.target && item.target === binding.target);
    if (old && JSON.stringify(old) !== JSON.stringify(binding)) throw new Error('设备需求冲突：' + binding.name);
    if (!old) target.manifest.wardrobe.deviceBindings.push(binding);
  }
  const components = readJson(join(target.source, 'components.json'), { skills: {} }); components.skills ||= {};
  for (const [key, skill] of Object.entries(readJson(join(from.source, 'components.json'), {}).skills || {})) components.skills[prefix + '/' + key] = { ...skill, localPath: prefix + '/' + (skill.localPath || `skills/${key}/SKILL.md`) };
  target.manifest.wardrobe.agent ||= { schemaVersion: 1, files: [], settings: {} };
  for (const file of from.manifest.wardrobe?.agent?.files || []) {
    if (file.target === 'components.json') continue;
    const importedFile = { ...file, source: prefix + '/' + file.source };
    const existing = target.manifest.wardrobe.agent.files.find(entry => entry.target === file.target);
    if (existing) {
      if (JSON.stringify({ ...existing, source: null }) !== JSON.stringify({ ...file, source: null }) || !readFileSync(join(target.source, existing.source)).equals(readFileSync(join(target.source, importedFile.source)))) throw new Error('辅助文件冲突，请通过 Pi 编辑草稿解决：' + file.target);
    } else target.manifest.wardrobe.agent.files.push(importedFile);
  }
  if (!target.manifest.wardrobe.agent.files.some(file => file.target === 'components.json')) target.manifest.wardrobe.agent.files.push({ source: 'components.json', target: 'components.json' });
  writeJson(join(target.source, 'components.json'), components);
  saveFiles(target, target.definition, target.manifest);
  const record = draftRecord(store, id); record.available = target.available; record.bindingValues = { ...record.bindingValues, ...from.bindingValues }; updateRecord(store, record);
  return readDraft(store, id);
}

function draftFiles(draft) {
  return { definition: readJson(join(draft.source, 'preset.json')), manifest: readJson(join(draft.source, 'package.json')) };
}

function saveFiles(draft, definition, manifest) {
  writeJson(join(draft.source, 'preset.json'), definition); writeJson(join(draft.source, 'package.json'), manifest);
}

/** Native resolver only discovers paths; it does not load extensions or install missing packages. */
async function globalResources(store, agentDir, includeShared) {
  const core = join(dirname(currentPiCli()), 'core');
  const [{ SettingsManager }, { DefaultPackageManager }] = await Promise.all(['settings-manager', 'package-manager'].map(name => import(pathToFileURL(join(core, name + '.js')).href)));
  const cwd = join(store.root, 'global-inventory'); mkdirSync(cwd, { recursive: true });
  const settings = SettingsManager.create(cwd, agentDir);
  const global = readJson(join(agentDir, 'settings.json'), {});
  global.packages = (global.packages || []).filter(entry => !ownedManager(entry, agentDir));
  const isolated = new Proxy(settings, { get(target, key) {
    if (key === 'getGlobalSettings') return () => global;
    if (key === 'getProjectSettings') return () => ({});
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const resources = await new DefaultPackageManager({ cwd, agentDir, settingsManager: isolated }).resolve(async () => 'error');
  if (!includeShared) for (const kind of KINDS) resources[kind] = resources[kind].filter(entry => entry.metadata.source !== 'auto' || resolve(entry.metadata.baseDir) === resolve(agentDir));
  return resources;
}

function mergeDependencies(target, manifest) {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, version] of Object.entries(manifest?.[field] || {})) {
      target[field] ||= {};
      if (target[field][name] && target[field][name] !== version) throw new Error('本地资源依赖冲突，请通过 Pi 编辑草稿解决：' + name);
      target[field][name] = version;
    }
  }
}

export async function draftFromDirectory(store, agentDir, { name = '本地工作环境', presetKey = null, parent = null, includeShared = false } = {}) {
  agentDir = realpathSync(agentDir);
  const draft = createDraft(store, { name });
  const { definition, manifest } = draftFiles(draft), resources = await globalResources(store, agentDir, includeShared), copied = new Map();
  const copy = (source, destination) => { if (!copied.has(source)) { copyPublicSource(source, join(draft.source, destination)); copied.set(source, destination); } return copied.get(source); };
  for (const kind of KINDS) {
    const include = [];
    for (const entry of resources[kind].filter(entry => entry.enabled && entry.metadata.scope !== 'project')) {
      if (entry.path.startsWith('builtin:')) continue;
      const path = realpathSync(entry.path);
      let destination;
      // Keep native package dependencies in their own install graph. Flattening
      // unrelated extension manifests changes resolution and rejects valid Pi environments.
      let external;
      try { external = parseSource(entry.metadata.source); } catch {}
      if (entry.metadata.packageRoot && external && external.kind !== 'self') {
        const root = realpathSync(entry.metadata.packageRoot);
        const source = external.kind === 'npm' ? `npm:${external.package}@${readJson(join(root, 'package.json')).version}` : entry.metadata.source;
        const alias = Object.entries(definition.packages).find(([, value]) => value.source === source)?.[0] || 'native-' + Object.keys(definition.packages).length;
        definition.packages[alias] = { source };
        let selector = definition.resources.find(item => item.package === alias && item.kind === kind);
        if (!selector) { selector = { package: alias, kind, include: [] }; definition.resources.push(selector); }
        selector.include.push(relative(root, path).split('\\').join('/'));
        continue;
      }
      if (entry.metadata.packageRoot) {
        const root = realpathSync(entry.metadata.packageRoot);
        const prefix = copy(root, 'vendor/package-' + (copied.size + 1));
        destination = join(prefix, relative(root, path));
        mergeDependencies(manifest, readJson(join(root, 'package.json')));
      } else if (within(agentDir, path) && !['npm', 'git', 'wardrobe'].includes(relative(agentDir, path).split('/')[0])) {
        const rel = relative(agentDir, path), top = rel.split('/')[0];
        if (rel.includes('/')) copy(join(agentDir, top), top); else copy(path, rel);
        destination = rel;
      } else {
        const root = kind === 'skills' ? dirname(path) : path;
        const prefix = copy(root, kind + '/imported-' + (copied.size + 1) + (lstatSync(root).isFile() ? '-' + basename(root) : ''));
        destination = lstatSync(root).isDirectory() ? join(prefix, basename(path)) : prefix;
      }
      include.push(destination.split('\\').join('/'));
    }
    definition.resources.push({ package: 'self', kind, include: [...new Set(include)] });
    manifest.pi[kind] = [...new Set(include)];
  }
  for (const folder of ['scripts', 'agents', 'habits', 'docs']) if (existsSync(join(agentDir, folder))) {
    copy(join(agentDir, folder), folder);
    const register = relative => {
      for (const entry of readdirSync(join(draft.source, relative), { withFileTypes: true })) {
        const path = relative + '/' + entry.name;
        if (entry.isDirectory()) register(path);
        else manifest.wardrobe.agent.files.push({ source: path, target: path, ...(/^habits\/[^/]+\.md$/.test(path) ? { mutable: true } : {}) });
      }
    };
    register(folder);
  }
  if (existsSync(join(agentDir, 'AGENTS.md'))) {
    copy(join(agentDir, 'AGENTS.md'), 'AGENTS.md'); manifest.wardrobe.agent.files.push({ source: 'AGENTS.md', target: 'AGENTS.md' });
  }
  manifest.wardrobe.agent.settings = presetPreferences(readJson(join(agentDir, 'settings.json'), {}));
  const privateValues = {};
  manifest.wardrobe.deviceBindings = [];
  for (const name of ['mcp.json', 'sol-pi.json', 'web-search.json']) if (existsSync(join(agentDir, name))) {
    const id = name.replace('.json', '');
    manifest.wardrobe.deviceBindings.push({ id, name, kind: 'file', target: name, required: true });
    privateValues[id] = realpathSync(join(agentDir, name));
  }
  // Custom skill registration makes later maintenance preserve untracked local work.
  const components = readJson(join(agentDir, 'components.json'), {}), skills = { ...(components.skills || {}) };
  for (const path of definition.resources.filter(r => r.package === 'self' && r.kind === 'skills').flatMap(r => r.include || [])) {
    const name = basename(dirname(path)), registered = Object.entries(skills).find(([key, value]) => key === name || value.localPath === path);
    if (registered) skills[registered[0]] = { ...registered[1], localPath: path };
    else skills[path] = { type: 'custom', localPath: path };
  }
  writeJson(join(draft.source, 'components.json'), { ...components, skills });
  manifest.wardrobe.agent.files.push({ source: 'components.json', target: 'components.json' });
  if (existsSync(join(agentDir, 'manifest.json'))) { copy(join(agentDir, 'manifest.json'), 'manifest.json'); manifest.wardrobe.agent.files.push({ source: 'manifest.json', target: 'manifest.json' }); }
  if (presetKey) { definition.id = presetKey; draft.presetId = presetKey; }
  draft.parent = parent; draft.bindingValues = privateValues;
  saveFiles(draft, definition, manifest); return updateRecord(store, draft);
}

/** Materialize the effective plan, keeping companions, preferences and exact dependencies. */
export async function draftFromProfile(store, profile, { copy = false, hidden = false, name = copy ? profile.name + ' 副本' : profile.name } = {}) {
  if (!profile.revision) {
    if (!profile.presetKey) {
      profile = { ...profile, presetKey: 'local/' + randomUUID() };
      const config = store.read(); config.profiles[profile.id] = profile; store.save(config);
    }
    const draft = await draftFromDirectory(store, profile.agentDir, { name, presetKey: copy ? null : profile.presetKey, parent: copy ? null : profile.id, includeShared: true });
    return updateRecord(store, { ...draft, hidden });
  }
  const draft = createDraft(store, { name }), { definition, manifest } = draftFiles(draft);
  const plan = new PlanStore(store.nativeDir).read(profile.revision), attempt = new StagingStore(store.nativeDir).read(profile.revision)?.attempts.at(-1);
  const prefixes = {}, self = plan.installationSurfaces.filter(entry => entry.source === '.');
  definition.packages = {};
  for (const surface of plan.installationSurfaces) {
    if (surface.source !== '.') { definition.packages[surface.alias] = { source: surface.source }; continue; }
    const installed = attempt.installed.find(entry => entry.alias === surface.alias);
    const root = packageRootFor(plan, { ...installed, installedPath: installed.installedRelative ? join(attempt.agentDir, installed.installedRelative) : installed.installedPath });
    const prefix = self.length === 1 ? '' : 'vendor/' + surface.alias;
    copyPublicSource(root, join(draft.source, prefix)); prefixes[surface.alias] = prefix;
    mergeDependencies(manifest, readJson(join(root, 'package.json')));
  }
  definition.packages.self = { source: '.' };
  const selectors = new Map();
  for (const selector of plan.resourceSelectors) {
    const alias = Object.hasOwn(prefixes, selector.package) ? 'self' : selector.package, key = alias + ':' + selector.kind;
    const item = selectors.get(key) || { package: alias, kind: selector.kind, include: [] };
    item.include = [...new Set([...item.include, ...selector.loaded.map(path => Object.hasOwn(prefixes, selector.package) ? [prefixes[selector.package], path].filter(Boolean).join('/') : path)])];
    selectors.set(key, item);
  }
  definition.resources = [...selectors.values()];
  for (const kind of KINDS) manifest.pi[kind] = definition.resources.filter(r => r.package === 'self' && r.kind === kind).flatMap(r => r.include);
  const sourceManifest = self.length === 1 ? readJson(join(draft.source, 'package.json'), {}) : {};
  for (const key of ['name', 'type', 'main', 'exports', 'imports', 'engines', 'bin', 'scripts', 'license', 'peerDependenciesMeta']) if (sourceManifest[key] !== undefined) manifest[key] = sourceManifest[key];
  manifest.wardrobe = { ...(sourceManifest.wardrobe || {}), agent: { schemaVersion: 1, files: (plan.agent?.files || []).filter(file => Object.hasOwn(prefixes, file.package)).map(file => ({ source: [prefixes[file.package], file.source].filter(Boolean).join('/'), target: file.target, ...(file.mutable ? { mutable: true } : {}), ...(file.template ? { template: true } : {}) })), settings: presetPreferences(readJson(join(profile.agentDir, 'settings.json'), plan.agent?.settings || {})) } };
  definition.persona = { append: (plan.persona?.append || profile.persona || []).map(entry => typeof entry === 'string' ? entry : entry.text) };
  definition.runtime = { tools: { enable: (plan.runtime?.tools?.enabled || []).map(entry => entry.tool), disable: (plan.runtime?.tools?.disabled || []).map(entry => entry.tool) }, ...(plan.runtime?.thinking?.value ? { thinking: plan.runtime.thinking.value } : {}) };
  definition.compatibility = structuredClone(plan.declaration.compatibility);
  if (!copy && profile.authored) { definition.id = profile.presetKey; draft.presetId = profile.presetKey; }
  else if (!copy) draft.upstream = profile.upstream || profile.source;
  if (!copy) {
    const version = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(profile.version);
    if (!version) throw new Error('无法递增预设版本：' + profile.version);
    definition.version = `${version[1]}.${version[2]}.${Number(version[3]) + 1}`;
  }
  draft.parent = copy ? null : profile.id;
  draft.hidden = hidden;
  draft.bindingValues = deviceValues(store, profile);
  saveFiles(draft, definition, manifest); return updateRecord(store, draft);
}

export async function saveDraft(store, id, { confirm = async () => true, onProgress } = {}) {
  const draft = readDraft(store, id);
  if(draft.saved){
    if(draft.savedDigest!==sourceDigest(draft.source))throw new Error('草稿已保存且源码发生变化，请从已保存的预设创建编辑草稿');
    const profile=store.read().profiles[draft.saved];
    if(!profile)throw new Error('已保存的修订缺失，请使用 /wardrobe repair');
    checkPreparedProfile(profile);return profile;
  }
  const { definition, manifest } = draft; validateBindings(manifest.wardrobe?.deviceBindings);
  if (definition.id !== draft.presetId) throw new Error('预设身份不能在草稿中改写，请创建副本');
  manifest.wardrobe ||= {};
  manifest.wardrobe.resourceCatalog = draft.available.map(({ package: alias, kind, path }) => ({ package: alias, kind, path }));
  saveFiles(draft, definition, manifest);
  inspectPublicSource(draft.source);
  return withLocalSnapshot(join(store.root, 'snapshots'), draft.source, async source => {
    const reviewed = await reviewNativeImport(store, source, 'preset.json');
    if (!await confirm(reviewed.plan)) return null;
    const profile = await installNativePlan(store, reviewed.plan, { source: { kind: 'local', id: draft.presetId, draft: draft.id }, parent: draft.parent || null, onProgress });
    const config = store.read();
    Object.assign(profile, { presetKey: draft.presetId, authored: true, kind: draft.upstream ? 'derivative' : 'local', ...(draft.upstream ? { upstream: draft.upstream } : {}) });
    config.profiles[profile.id] = profile; store.save(config);
    for (const [id, path] of Object.entries(draft.bindingValues || {})) if (profile.deviceBindings.some(item => item.id === id) && existsSync(path)) bindDevice(store, profile, id, path);
    writeJson(join(store.root, 'drafts', id, 'draft.json'), { ...draftRecord(store, id), saved: profile.id, savedDigest: sourceDigest(draft.source) });
    return profile;
  }, nativeEnv(store));
}

export function exportDraft(store, id, destination) {
  const draft = draftRecord(store, id), target = resolve(destination);
  if (within(draft.source, target)) throw new Error('导出目录不能放在草稿内部');
  if (existsSync(target)) throw new Error('导出目录已存在，请选择新目录');
  inspectPublicSource(draft.source); copyPublicSource(draft.source, target); return target;
}

export async function exportProfile(store, profile, destination) {
  const draft = await draftFromProfile(store, profile, { hidden: true });
  const files = draftFiles(draft);
  files.definition.id = profile.revision ? new PlanStore(store.nativeDir).read(profile.revision).identity.id : store.read().profiles[profile.id].presetKey;
  files.definition.version = profile.version; files.definition.name = profile.name;
  saveFiles(draft, files.definition, files.manifest);
  return exportDraft(store, draft.id, destination);
}

export async function importLocal(store, source, { confirm, onProgress, choose, presetPath = null } = {}) {
  const path = resolve(source), root = lstatSync(path).isFile() ? dirname(path) : path;
  if (!existsSync(join(root,'preset.json')) && readJson(join(root,'manifest.json'))?.piVersion && Array.isArray(readJson(join(root,'manifest.json'))?.packages)) {
    const {normalizePresetSource}=await import('./native-normalize.mjs');
    const normalized=await normalizePresetSource(store,root);
    return importLocal(store,normalized.source,{confirm,onProgress,choose,presetPath});
  }
  if (!existsSync(join(root, 'preset.json')) && !readJson(join(root, 'package.json'), {}).wardrobe?.presets?.length) {
    if (!existsSync(join(root, 'settings.json')) && !KINDS.some(kind => existsSync(join(root, kind)))) throw new Error('未发现预设或 Pi 配置');
    const draft = await draftFromDirectory(store, root);
    return saveDraft(store, draft.id, { confirm, onProgress });
  }
  if (!existsSync(join(root, 'preset.json'))) {
    return withLocalSnapshot(join(store.root, 'snapshots'), root, async source => {
      const reviewed = await reviewNativeImport(store, source, presetPath, { choose }); if (!reviewed) return null;
      if (confirm && !await confirm(reviewed.plan)) return null;
      return installNativePlan(store, reviewed.plan, { source: { kind: 'local', id: reviewed.plan.identity.id }, onProgress });
    }, nativeEnv(store));
  }
  const draft = createDraft(store);
  // Standard local packages are captured before review, never referenced live.
  copyPublicSource(root, draft.source);
  const definition = readJson(join(draft.source, 'preset.json'));
  writeJson(join(store.root, 'drafts', draft.id, 'draft.json'), { ...draft, presetId: definition.id, name: definition.name });
  return saveDraft(store, draft.id, { confirm, onProgress });
}
