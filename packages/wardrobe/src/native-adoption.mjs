import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { NativeStore, managerPackage, readJson, writeJson } from './native-store.mjs';

const PREFERENCES = new Set(['theme', 'tuiMode', 'quietStartup', 'enableSkillCommands', 'defaultTools', 'compaction', 'hideThinkingBlock', 'showCacheMissNotices', 'collapseChangelog', 'terminal', 'images', 'fullscreenExitOutput', 'fullscreenScrollbar', 'fullscreenCopyOnSelect', 'fullscreenWheelScrollLines', 'doubleEscapeAction', 'treeFilterMode', 'showHardwareCursor', 'editorPaddingX', 'outputPad', 'autocompleteMaxVisible', 'mermaidRenderingMode', 'warnings', 'steeringMode', 'followUpMode']);
const RESOURCE_KINDS = ['extensions', 'skills', 'prompts', 'themes'];
const SNAPSHOT_DIRS = [...RESOURCE_KINDS, 'npm', 'git', 'scripts', 'agents', 'habits', 'docs'];
const PRIVATE = /^(?:auth\.json|models(?:-store)?\.json|\.env(?:\..*)?|\.npmrc|\.netrc|credentials(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/;
const localPath = (nativeDir, source) => source.startsWith('~/') ? join(process.env.HOME || homedir(), source.slice(2)) : resolve(nativeDir, source);
const canonicalLocal = path => existsSync(path) ? realpathSync(path) : resolve(path);
export const ownedManager = (entry, nativeDir) => {
  const source = typeof entry === 'string' ? entry : entry.source;
  return typeof source === 'string' && (source.startsWith('npm:@pi-wardrobe/manager') || source.startsWith('npm:pi-wardrobe') || /github\.com[/:]CheeseFox259\/pi-wardrobe(?:\.git)?(?:@|$)/.test(source) || canonicalLocal(localPath(nativeDir, source)) === canonicalLocal(managerPackage) || canonicalLocal(localPath(nativeDir, source)) === canonicalLocal(resolve(managerPackage, '../..')));
};

export function adoptionPreview(nativeDir) {
  const settings = readJson(join(nativeDir, 'settings.json'), {});
  return { packages: (settings.packages ?? []).filter(entry => !ownedManager(entry, nativeDir)).map(entry => typeof entry === 'string' ? entry : entry.source), localResources: RESOURCE_KINDS.filter(kind => existsSync(join(nativeDir, kind))), preferences: Object.keys(settings).filter(key => PREFERENCES.has(key)), models: 'Pi', project: 'Pi' };
}

export function adoptOriginal(nativeDir, { piVersion = '1.1.0', restore = false } = {}) {
  const store = new NativeStore(nativeDir), config = store.read();
  if (config.initialized && !restore) return { ok: true, state: 'already-adopted', profile: config.profiles.original };
  if (restore && !config.adoption?.backup) throw new Error('未找到原始配置备份，无法自动恢复。');
  const original = restore ? readJson(config.adoption.backup) : readJson(join(nativeDir, 'settings.json'), {});
  if (!original) throw new Error('原始配置备份缺失，无法自动恢复。');
  const inventoryPath = config.adoption?.resourceInventory || join(store.root, 'backups/original-resources.json');
  if (restore) {
    const inventory = readJson(inventoryPath);
    if (!Array.isArray(inventory)) throw new Error('原始资源清单缺失，无法确认完整恢复。');
    const missing = inventory.filter(path => !existsSync(join(nativeDir, path)));
    if (missing.length) throw new Error('原始本机资源已丢失，请恢复后再重试：\n' + missing.join('\n'));
  }
  const target = join(store.root, 'profiles', restore ? 'original-restored-' + randomUUID() : 'original');
  const presetKey = config.profiles.original?.presetKey || 'local/' + randomUUID();
  if (existsSync(target)) throw new Error('An incomplete original preset exists; inspect ' + target + ' before retrying');
  const snapshot = Object.fromEntries(Object.entries(original).filter(([key]) => PREFERENCES.has(key) || RESOURCE_KINDS.includes(key)));
  snapshot.packages = (original.packages ?? []).filter(entry => !ownedManager(entry, nativeDir));
  snapshot.enableInstallTelemetry = false;
  const localDependencies = [];
  const mapLocal = value => {
    if (typeof value !== 'string') return value;
    const prefix = /^[!+-]/.test(value) ? value[0] : '';
    const raw = prefix ? value.slice(1) : value;
    if (/^(?:npm:|git:|https?:|github:|github\.com\/)/.test(raw)) return value;
    const absolute = localPath(nativeDir, raw), suffix = relative(nativeDir, absolute);
    if (!suffix.startsWith('..') && !isAbsolute(suffix) && SNAPSHOT_DIRS.includes(suffix.split('/')[0])) return prefix + join(target, suffix);
    // Pi's disabled/excluded resource selectors remain useful even when the
    // target was removed. Preserve their paths, but require only enabled inputs.
    if (prefix !== '-' && prefix !== '!') localDependencies.push(absolute);
    return prefix + absolute;
  };
  for (const kind of RESOURCE_KINDS) if (Array.isArray(snapshot[kind])) snapshot[kind] = snapshot[kind].map(mapLocal);
  snapshot.packages = snapshot.packages.map(entry => typeof entry === 'string' ? mapLocal(entry) : { ...entry, source: mapLocal(entry.source) });
  let bootstrapWritten = false;
  mkdirSync(target, { recursive: true, mode: 0o700 });
  try {
    for (const dir of SNAPSHOT_DIRS) {
      const source = join(nativeDir, dir);
      if (existsSync(source)) cpSync(source, join(target, dir), { recursive: true, verbatimSymlinks: true, filter: file => !PRIVATE.test(basename(file)) });
    }
    if (existsSync(join(nativeDir, 'AGENTS.md'))) cpSync(join(nativeDir, 'AGENTS.md'), join(target, 'AGENTS.md'));
    for (const name of ['mcp.json', 'sol-pi.json', 'web-search.json']) if (existsSync(join(nativeDir, name))) {
      symlinkSync(join(nativeDir, name), join(target, name)); localDependencies.push(join(nativeDir, name));
    }
    writeJson(join(target, 'settings.json'), snapshot);
    writeJson(join(target, 'preset.json'), { schemaVersion: 1, id: presetKey, name: '我的原始配置', version: '1.0.0', compatibility: { pi: '>=' + piVersion }, packages: { self: { source: '.' } }, resources: RESOURCE_KINDS.map(kind => ({ package: 'self', kind, include: existsSync(join(target, kind)) ? [kind + '/**'] : [] })) });
    writeJson(join(target, 'package.json'), { name: 'wardrobe-original-local', version: '1.0.0', pi: Object.fromEntries(RESOURCE_KINDS.map(kind => [kind, existsSync(join(target, kind)) ? [kind] : []])) });
    // Full original settings are a private recovery backup in the native directory,
    // never a preset input or an exported artifact.
    const backup = join(store.root, 'backups/original-settings.json');
    if (!restore) {
      writeJson(backup, original);
      const inventory = [];
      const walk = path => {
        inventory.push(path);
        for (const entry of readdirSync(join(nativeDir, path), { withFileTypes: true })) {
          if (PRIVATE.test(entry.name)) continue;
          const child = join(path, entry.name);
          if (entry.isDirectory()) walk(child); else inventory.push(child);
        }
      };
      for (const dir of SNAPSHOT_DIRS) if (existsSync(join(nativeDir, dir))) walk(dir);
      writeJson(inventoryPath, inventory);
    }
    const missing = localDependencies.filter(path => {
      const wildcard = path.search(/[?*\[]/);
      return !existsSync(wildcard < 0 ? path : dirname(path.slice(0, wildcard) + '_'));
    });
    if (missing.length) throw new Error('这些本机依赖已丢失，请恢复后再重试：\n' + missing.join('\n'));
    const profile = { id: 'original', presetKey, name: '我的原始配置', version: '1.0.0', kind: 'original', agentDir: target, source: { kind: 'local', nativeDir }, createdAt: new Date().toISOString(), localOnly: true, localDependencies: [...new Set(localDependencies)], compatibility: config.profiles.original?.compatibility ?? { pi: '>=' + piVersion } };

    // Keep native model/auth settings and package installation ownership here.
    // On future launches the manager starts before the archived global extensions.
    const current = readJson(join(nativeDir, 'settings.json'), {});
    if (!restore && ['packages', ...RESOURCE_KINDS].some(key => JSON.stringify(current[key]) !== JSON.stringify(original[key]))) throw new Error('全局资源配置在归档期间发生变化，请重新归档。');
    const managers = (original.packages ?? []).filter(entry => ownedManager(entry, nativeDir));
    const bootstrap = { ...current, packages: managers.length ? managers : [managerPackage] };
    for (const kind of RESOURCE_KINDS) bootstrap[kind] = ['!' + join(nativeDir, kind, '**')];
    if (!restore) { writeJson(join(nativeDir, 'settings.json'), bootstrap); bootstrapWritten = true; }
    store.save({ ...config, initialized: true, default: restore ? config.default : 'original', profiles: { ...config.profiles, original: profile }, adoption: restore ? config.adoption : { backup, resourceInventory: inventoryPath, privateFiles: ['models.json', 'auth.json'], project: 'native' } });
    return { ok: true, state: restore ? 'restored' : 'adopted', profile };
  } catch (error) { if (bootstrapWritten) writeJson(join(nativeDir, 'settings.json'), original); rmSync(target, { recursive: true, force: true }); throw error; }
}
