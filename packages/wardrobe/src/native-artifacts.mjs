import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digestOf } from './plan.mjs';
import { git } from './proc.mjs';
import { readJson, writeJson } from './native-store.mjs';

// Preserve Git objects independently of staging and temporary source servers.
export async function preserveGitArtifacts(store, plan, record, env) {
  const index = join(store.root, 'artifacts/git.json'), artifacts = readJson(index, []);
  const latest = record.attempts.at(-1);
  for (const surface of plan.installationSurfaces.filter(entry => entry.artifact?.kind === 'git')) {
    const { url, commit } = surface.artifact;
    if (artifacts.some(entry => entry.url === url && entry.commit === commit && existsSync(entry.path))) continue;
    const installed = latest.installed.find(entry => entry.alias === surface.alias);
    const root = installed.installedRelative ? join(latest.agentDir, installed.installedRelative) : installed.installedPath;
    const path = join(store.root, 'artifacts/git', digestOf({ url, commit }).slice(0, 24) + '.git');
    mkdirSync(join(store.root, 'artifacts/git'), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) await git(['clone', '--bare', '--no-hardlinks', '-q', root, path], { env });
    await git(['--git-dir', path, 'cat-file', '-e', commit + '^{commit}'], { env });
    artifacts.push({ url, commit, path });
  }
  writeJson(index, artifacts);
}

export function artifactEnvironment(store, plan, env) {
  if (!plan) return env;
  const artifacts = readJson(join(store.root, 'artifacts/git.json'), []), result = { ...env };
  let count = Number(result.GIT_CONFIG_COUNT || 0);
  const urls = new Set();
  for (const surface of plan.installationSurfaces) {
    const artifact = artifacts.find(entry => entry.url === surface.artifact?.url && entry.commit === surface.artifact?.commit && existsSync(entry.path));
    if (!artifact || urls.has(artifact.url)) continue;
    urls.add(artifact.url);
    const variants = [artifact.url];
    if (/^github\.com\//.test(artifact.url)) variants.push('https://' + artifact.url);
    for (const url of variants) {
      result['GIT_CONFIG_KEY_' + count] = 'url.' + pathToFileURL(artifact.path).href + '.insteadOf';
      result['GIT_CONFIG_VALUE_' + count] = url; count++;
    }
  }
  result.GIT_CONFIG_COUNT = String(count);
  return result;
}
