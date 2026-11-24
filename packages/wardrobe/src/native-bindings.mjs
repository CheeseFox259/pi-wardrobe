import { existsSync, lstatSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readJson, writeJson } from './native-store.mjs';

const KINDS = ['file', 'command', 'extensions', 'skills', 'prompts', 'themes'];
export function validateBindings(value = []) {
  if (!Array.isArray(value)) throw new Error('deviceBindings 必须为列表');
  const seen = new Set(), targets = new Set();
  return value.map(item => {
    if (!item || Object.keys(item).some(key => !['id', 'name', 'kind', 'required', 'target'].includes(key)) || !/^[a-zA-Z0-9_-]+$/.test(item.id) || typeof item.name !== 'string' || !item.name.trim() || !KINDS.includes(item.kind) || typeof item.required !== 'boolean' || seen.has(item.id)) throw new Error('无效的设备需求');
    if (item.kind === 'file' ? !['mcp.json', 'sol-pi.json', 'web-search.json'].includes(item.target) || targets.has(item.target) : item.target !== undefined) throw new Error('无效的设备绑定目标');
    seen.add(item.id); if (item.target) targets.add(item.target);
    return { ...item };
  });
}

const keyFor = profile => profile.presetKey || (profile.id === 'original' ? 'local/original' : profile.source?.id || profile.id);
export function deviceValues(store, profile) { return readJson(join(store.root, 'bindings.json'), {})[keyFor(profile)] || {}; }

function checkedPath(requirement, path) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error('本机资源不存在：' + absolute);
  const real = realpathSync(absolute), info = lstatSync(real);
  if ((requirement.kind === 'file' || requirement.kind === 'command') && !info.isFile()) throw new Error('请选择文件');
  if (requirement.kind === 'command' && process.platform !== 'win32' && !(info.mode & 0o111)) throw new Error('工具文件不可执行');
  return real;
}

export function bindDevice(store, profile, id, path) {
  const requirement = validateBindings(profile.deviceBindings).find(item => item.id === id);
  if (!requirement) throw new Error('设备需求不存在：' + id);
  const real = checkedPath(requirement, path);
  const all = readJson(join(store.root, 'bindings.json'), {}), key = keyFor(profile);
  all[key] = { ...all[key], [id]: real }; writeJson(join(store.root, 'bindings.json'), all); return real;
}

/** Resolve before starting Pi; nothing private enters a source or exported tree. */
export function prepareDeviceBindings(store, profile) {
  const values = deviceValues(store, profile), args = [], env = {};
  for (const item of validateBindings(profile.deviceBindings)) {
    let path = values[item.id];
    if (!path || !existsSync(path)) { if (item.required) throw new Error('缺少设备绑定：' + item.name + '。请在预设管理 → 更多 → 设备绑定中设置。'); continue; }
    try { path = checkedPath(item, path); }
    catch (error) { if (item.required) throw error; continue; }
    if (item.kind === 'file') {
      const target = join(profile.agentDir, item.target), existing = lstatSync(target, { throwIfNoEntry: false });
      if (existing && !existing.isSymbolicLink()) throw new Error('设备绑定与预设文件冲突：' + item.target);
      if (existing && readlinkSync(target) !== path) rmSync(target);
      if (!existsSync(target)) symlinkSync(path, target);
    } else if (item.kind === 'command') env['WARDROBE_DEVICE_' + item.id.toUpperCase().replaceAll('-', '_')] = path;
    else args.push({ extensions: '-e', skills: '--skill', prompts: '--prompt-template', themes: '--theme' }[item.kind], path);
  }
  return { args, env };
}
