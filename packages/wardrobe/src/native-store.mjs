import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function projectKey(cwd) { return realpathSync(resolve(cwd)); }

export const NATIVE_RESULT = 'wardrobe.native-result';
export const managerPackage = resolve(import.meta.dirname, '..');
export const managerEntry = join(managerPackage, 'extensions/index.mjs');

export function nativeDirectory(env = process.env) {
  return resolve(env.WARDROBE_NATIVE_AGENT_DIR || env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), '.pi/agent'));
}

export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJson(path, value) {
  const current = lstatSync(path, { throwIfNoEntry: false });
  if (current && (!current.isFile() || current.isSymbolicLink())) throw new Error('Refusing non-file storage: ' + path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID();
  try { writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

export class NativeStore {
  constructor(nativeDir = nativeDirectory()) { this.nativeDir = resolve(nativeDir); this.root = join(this.nativeDir, 'wardrobe'); this.path = join(this.root, 'native.json'); }
  read() {
    const config = readJson(this.path, { schemaVersion: 1, initialized: false, default: null, projects: {}, profiles: {} });
    if (config.schemaVersion !== 1 || !config.profiles || !config.projects) throw new Error('Unsupported Wardrobe native configuration');
    return config;
  }
  save(config) { writeJson(this.path, config); return config; }
  select(cwd, session = null) {
    const config = this.read(), id = session || config.projects[projectKey(cwd)] || config.default;
    if (!id) return null;
    const profile = config.profiles[id];
    if (!profile) throw new Error('Selected preset is missing: ' + id);
    return profile;
  }
}
