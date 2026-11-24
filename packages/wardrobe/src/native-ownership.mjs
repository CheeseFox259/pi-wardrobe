import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LeaseStore, isStale } from './lease.mjs';
import { readJson, writeJson } from './native-store.mjs';

// Preserve legacy exclusive writers; native Pi sessions can share read-only code
// while Pi's own stores serialize preference and model/auth writes.
export function checkNativeOwnership(store, profile) {
  const held = profile.revision && new LeaseStore(store.nativeDir).read(profile.revision);
  if (held && held.pid !== process.pid && !isStale(held)) throw new Error('此修订正在旧版 Wardrobe 中使用，请结束旧实例后再切换。');
}

let registered = false;
export function holdNativeProfile(store, profile) {
  const path = join(store.root, 'native-runs', process.pid + '.json');
  writeJson(path, { pid: process.pid, profile: profile.id, startedAt: new Date().toISOString() });
  if (!registered) { process.once('exit', () => rmSync(path, { force: true })); registered = true; }
}

export function nativeUsers(store, profile) {
  const directory = join(store.root, 'native-runs');
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap(file => {
    const path = join(directory, file), entry = readJson(path);
    if (!entry?.pid || isStale({ ...entry, host: undefined })) { rmSync(path, { force: true }); return []; }
    return entry.profile === profile.id ? [entry] : [];
  });
}

export function nativeReferences(store, revision) {
  const config = store.read(), profiles = Object.values(config.profiles).filter(profile => profile.revision === revision);
  const references = [];
  const directory = join(store.root, 'sessions');
  const sessions = existsSync(directory) ? readdirSync(directory).filter(file => file.endsWith('.json')).map(file => readJson(join(directory, file))) : [];
  for (const profile of profiles) {
    if (config.default === profile.id || Object.values(config.projects).includes(profile.id)) references.push({ kind: 'native-default', reason: '该修订仍是启动默认，请先选择另一个默认 preset。' });
    if (nativeUsers(store, profile).length) references.push({ kind: 'native-session', reason: '该修订正在原生 Pi 中运行。' });
    if (sessions.some(entry => entry?.profile === profile.id && entry.sessionFile && existsSync(entry.sessionFile))) references.push({ kind: 'native-history', reason: '旧对话仍绑定该修订；请保留资源以便恢复。' });
  }
  return references;
}
