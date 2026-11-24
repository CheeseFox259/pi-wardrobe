import { join } from 'node:path';
import { captureSource } from './discover.mjs';
import { githubUrl, isGithubLocator, normalizeGithub } from './github.mjs';
import { resolveGitRef } from './git-source.mjs';
import { planFor } from './review.mjs';
import { PlanStore } from './approval.mjs';

export async function npmTarget(source, registry, { latest = false } = {}) {
  const raw = source.slice(4), at = raw.lastIndexOf('@');
  const name = at > 0 ? raw.slice(0, at) : raw;
  let version = at > 0 ? raw.slice(at + 1) : 'latest';
  if (latest) version = 'latest';
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
    const response = await fetch(new URL(name.replace(/\//g, '%2f'), registry.endsWith('/') ? registry : registry + '/'), { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`npm 元数据读取失败：${response.status} ${name}`);
    const metadata = await response.json();
    version = metadata['dist-tags']?.[version];
    if (!version) throw new Error('npm 未提供该版本标签：' + name);
  }
  return `npm:${name}@${version}`;
}

export async function resolveNativeSource(source, env, { ref = null, latest = false } = {}) {
  if (!source || /\s/.test(source)) throw new Error('请输入一个 GitHub、Git 或 npm 来源。');
  const hash = source.indexOf('#'), presetPath = hash >= 0 ? source.slice(hash + 1) : null;
  const locator = hash >= 0 ? source.slice(0, hash) : source;
  if (locator.startsWith('npm:')) return { exact: await npmTarget(locator, env.WARDROBE_REGISTRY, { latest }), locator, presetPath, ref: null };
  let url, selectedRef = ref || 'HEAD', exactCommit = null;
  if (isGithubLocator(locator) || locator.startsWith('github:') || /^[\w.-]+\/[\w.-]+@.+$/.test(locator)) {
    // A branch/tag can be supplied after @, including refs containing '/'.
    const raw = locator.replace(/^git@github\.com:/, '').replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//, '').replace(/^github:/, '');
    const at = raw.lastIndexOf('@');
    const repository = at > 0 ? raw.slice(0, at) : raw;
    if (at > 0 && !ref) selectedRef = raw.slice(at + 1);
    url = githubUrl(normalizeGithub(repository).slice(7), env);
  } else {
    const raw = locator.replace(/^git@github\.com:/, '').replace(/^git:/, '');
    const at = raw.lastIndexOf('@');
    // An SSH username is part of the URL, not a revision separator.
    const protocol = raw.indexOf('://');
    const pathAt = protocol >= 0 ? raw.indexOf('/', protocol + 3) : raw.startsWith('git@') ? raw.indexOf(':') : raw.indexOf('/');
    const revisionAt = pathAt >= 0 && at > pathAt;
    url = revisionAt ? raw.slice(0, at) : raw;
    if (revisionAt && !ref) {
      const value = raw.slice(at + 1);
      if (/^[0-9a-f]{40}$/.test(value) && !latest) exactCommit = value;
      else if (!/^[0-9a-f]{40}$/.test(value)) selectedRef = value;
    }
    if (/^(?:github\.com|[\w.-]+\.[\w.-]+)\//.test(url)) url = 'https://' + url;
    if (!/^(?:https?:\/\/|ssh:\/\/|git:\/\/|git@)/.test(url)) throw new Error('不支持的 Git 来源：' + source);
  }
  const commit = exactCommit || await resolveGitRef(url, selectedRef, env);
  return { exact: `git:${url}@${commit}`, locator: `git:${url}`, presetPath, ref: selectedRef };
}

export async function prepareNativeImport(store, source, env, { presetPath = null, ref = null, latest = false, choose = null } = {}) {
  const resolved = await resolveNativeSource(source, env, { ref, latest });
  const captured = await captureSource(resolved.exact, { workDir: join(store.root, 'captures'), env: { ...env, GIT_TERMINAL_PROMPT: '0' }, registry: env.WARDROBE_REGISTRY });
  let wanted = presetPath || resolved.presetPath;
  if (!wanted && captured.presets.length > 1 && choose) wanted = await choose(captured.presets);
  if (wanted === undefined && choose && captured.presets.length > 1) return null;
  const preset = wanted ? captured.presets.find(entry => entry.path === wanted || entry.path === wanted.replace(/\/$/, '') + '/preset.json') : captured.presets.length === 1 ? captured.presets[0] : null;
  if (!preset) throw new Error('请选择一个有效 preset：\n' + captured.presets.map(entry => entry.path + ' · ' + entry.definition.name).join('\n'));
  const plan = await planFor({ captured, preset, workDir: join(store.root, 'captures'), registry: env.WARDROBE_REGISTRY, env });
  new PlanStore(store.nativeDir).save(plan);
  return { plan, source: { locator: resolved.locator, ref: resolved.ref, presetPath: preset.path, exact: resolved.exact, id: preset.definition.id } };
}
