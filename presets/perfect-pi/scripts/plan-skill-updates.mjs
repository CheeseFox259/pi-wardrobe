#!/usr/bin/env node
// A read-only, companion-aware merge plan. Applying it and advancing lineage
// remain explicit maintenance decisions after behavior verification.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { loadConfig, getSkillUpstreamInfo, getRemoteHead, resolveRepoGitDir, performThreeWayMerge } from '../reconcile.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (dir, args, options = {}) => execFileSync('git', ['-C', dir, ...args], {
  timeout: 30_000, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, GIT_NO_LAZY_FETCH: options.offline ? '1' : '0' }, ...options,
});
function safeRelative(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.startsWith('/') || path.split('/').some(p => p === '..' || p === '.' || !p)) throw new Error('Unsafe skill path');
  return path;
}
function localFiles(root, relativeRoot) {
  const files = new Map(), base = resolve(root);
  function walk(path) {
    const absolute = resolve(base, path);
    if (!absolute.startsWith(base + sep)) throw new Error('Skill path escapes source');
    let ancestor = base;
    for (const part of path.split('/')) {
      ancestor = join(ancestor, part);
      if (lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Skill symlinks must be reviewed separately: ' + path);
    }
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error('Skill symlinks must be reviewed separately: ' + path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) if (!['.git', 'node_modules', '__pycache__'].includes(name)) walk(posix.join(path, name));
    } else if (stat.isFile()) files.set(path, { bytes: readFileSync(absolute), mode: stat.mode & 0o111 ? '100755' : '100644' });
  }
  walk(relativeRoot);
  return files;
}
function tree(repo, ref, directory, options) {
  const result = new Map();
  const output = git(repo, ['ls-tree', '-r', '-z', ref, '--', ':(literal)' + directory], { ...options, encoding: 'utf8' });
  for (const line of output.split('\0').filter(Boolean)) {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
    if (!match || match[2] !== 'blob' || !['100644', '100755'].includes(match[1])) throw new Error('Unsupported upstream skill entry: ' + line);
    safeRelative(match[4]);
    result.set(match[4], { mode: match[1], oid: match[3] });
  }
  return result;
}
function readBlobs(repo, ids, options) {
  const result = new Map();
  if (!ids.length) return result;
  const bytes = git(repo, ['cat-file', '--batch'], { ...options, input: ids.join('\n') + '\n' });
  let offset = 0;
  for (const expected of ids) {
    const end = bytes.indexOf(10, offset), header = bytes.subarray(offset, end).toString('utf8');
    const match = /^([a-f0-9]+) blob (\d+)$/.exec(header);
    if (!match || match[1] !== expected) throw new Error('Missing upstream blob: ' + expected);
    const length = Number(match[2]);
    result.set(expected, bytes.subarray(end + 1, end + 1 + length)); offset = end + length + 2;
  }
  return result;
}
function matches(bytes, entry) {
  if (!entry || !bytes) return false;
  const hash = createHash(entry.oid.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  return hash === entry.oid;
}
function mergeFile(base, local, target, temporary) {
  // Binary changes need explicit review; decoding must never corrupt them.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try { for (const bytes of [base, local, target]) { if (bytes.includes(0)) return { status: 'conflict', reason: 'binary-change' }; decoder.decode(bytes); } }
  catch { return { status: 'conflict', reason: 'binary-change' }; }
  for (const [name, bytes] of Object.entries({ base, local, target })) writeFileSync(join(temporary, name), bytes);
  const merged = performThreeWayMerge(join(temporary, 'local'), join(temporary, 'base'), join(temporary, 'target'));
  if (merged.status === null || merged.status < 0 || merged.status > 127) throw new Error('Three-way merge failed');
  return { status: merged.clean ? 'merged' : 'conflict', mergedContent: merged.mergedContent, conflicts: merged.conflictCount };
}

export async function planSkillUpdates(options = {}) {
  const started = performance.now(), { projectRoot, components } = await loadConfig(options);
  for (const name of options.skills || []) getSkillUpstreamInfo(components, name);
  const groups = new Map(), skills = [], repositories = [];
  for (const [name, skill] of Object.entries(components.skills || {})) {
    if (skill.type !== 'override' || options.skills && !options.skills.includes(name)) continue;
    const info = getSkillUpstreamInfo(components, name);
    safeRelative(info.localPath); safeRelative(info.upstreamRelPath);
    if (posix.dirname(info.localPath) === '.' || posix.dirname(info.upstreamRelPath) === '.') throw new Error('Skill entry must have its own directory: ' + name);
    if (!groups.has(info.repoUrl)) groups.set(info.repoUrl, []);
    groups.get(info.repoUrl).push({ name, ...info });
  }
  const temporary = mkdtempSync(join(tmpdir(), 'pi-skill-plan-'));
  let blobReads = 0;
  try {
    for (const [repoUrl, entries] of groups) {
      const offline = Boolean(options.offline || options.skipNetwork);
      const configured = components.upstreams?.[entries[0].upstream];
      const targetRef = options.targets?.[repoUrl] || (offline ? (configured?.repo === repoUrl ? configured.pinnedRef : entries[0].baseRef) : getRemoteHead(repoUrl, options.timeout || 8000, options));
      const repository = { repo: repoUrl, targetRef, freshness: offline ? 'not-checked' : 'remote-head', skills: entries.length };
      repositories.push(repository);
      try {
        if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(targetRef || '')) throw new Error('Exact upstream target unavailable; retry online or supply a recorded target');
        const repo = await resolveRepoGitDir(repoUrl, options);
        const refs = [...new Set([targetRef, ...entries.map(e => e.baseRef)])];
        const missing = refs.filter(ref => { if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(ref)) throw new Error('Exact upstream base required'); try { git(repo, ['cat-file', '-e', ref + '^{commit}'], { offline }); return false; } catch { return true; } });
        if (missing.length) {
          if (offline) throw new Error('Recorded refs missing from offline cache');
          git(repo, ['fetch', '--no-tags', '--filter=blob:none', 'origin', ...missing]);
        }
        const inputs = entries.map(entry => ({ ...entry, base: tree(repo, entry.baseRef, posix.dirname(entry.upstreamRelPath), { offline }), target: tree(repo, targetRef, posix.dirname(entry.upstreamRelPath), { offline }) }));
        const required = new Set();
        for (const input of inputs) for (const [path, target] of input.target) {
          const base = input.base.get(path);
          if (base?.oid !== target.oid) { required.add(target.oid); if (base) required.add(base.oid); }
        }
        const blobs = readBlobs(repo, [...required], { offline }); blobReads += blobs.size;
        for (const input of inputs) {
          const localRoot = posix.dirname(input.localPath), upstreamRoot = posix.dirname(input.upstreamRelPath);
          const local = localFiles(projectRoot, localRoot);
          if (!local.has(input.localPath)) throw new Error("Local skill entry missing: " + input.localPath);
          const paths = new Set([...input.base.keys(), ...input.target.keys(), ...[...local.keys()].map(path => upstreamRoot + path.slice(localRoot.length))]);
          const retired = !input.target.has(input.upstreamRelPath);
          const files = [];
          for (const upstreamPath of [...paths].sort()) {
            const path = localRoot + upstreamPath.slice(upstreamRoot.length), b = input.base.get(upstreamPath), u = input.target.get(upstreamPath), l = local.get(path);
            const result = { path, upstreamPath, baseOid: b?.oid, targetOid: u?.oid, baseMode: b?.mode, targetMode: u?.mode, localSha256: l && digest(l.bytes), localMode: l?.mode, modeChanged: Boolean(b && u && b.mode !== u.mode && l?.mode !== u.mode) };
            if (retired) result.status = 'retired-retained';
            else if (!u) result.status = b ? 'retired-retained' : 'local-preserved';
            else if (!b) Object.assign(result, !l ? { status: 'upstream-add', contentBase64: blobs.get(u.oid).toString('base64') } : matches(l.bytes, u) ? { status: 'unchanged' } : { status: 'conflict', reason: 'both-added' });
            else if (b.oid === u.oid && b.mode === u.mode) result.status = !l ? 'local-deletion-retained' : matches(l.bytes, b) && l.mode === b.mode ? 'unchanged' : 'local-preserved';
            else if (!l) Object.assign(result, { status: 'conflict', reason: 'local-delete-upstream-modify' });
            else if (matches(l.bytes, u)) result.status = 'upstream-present';
            else if (matches(l.bytes, b)) Object.assign(result, { status: 'upstream-update', contentBase64: blobs.get(u.oid)?.toString('base64') });
            else if (b.oid === u.oid) result.status = 'local-preserved';
            else Object.assign(result, mergeFile(blobs.get(b.oid), l.bytes, blobs.get(u.oid), temporary));
            files.push(result);
          }
          skills.push({ name: input.name, baseRef: input.baseRef, targetRef, retired, preservedFeatures: input.preservedFeatures, files });
        }
      } catch (error) {
        repository.error = error.message;
        for (const entry of entries) if (!skills.some(s => s.name === entry.name)) skills.push({ name: entry.name, baseRef: entry.baseRef, targetRef, blocked: true, reason: error.message, files: [] });
      }
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  const changed = new Set(['upstream-add', 'upstream-update', 'merged', 'conflict']);
  const summary = { skills: skills.length, files: skills.reduce((n, s) => n + s.files.length, 0), changedSkills: skills.filter(s => s.files.some(f => changed.has(f.status) || f.modeChanged || f.baseOid && !f.targetOid)).map(s => s.name), conflicts: skills.flatMap(s => s.files).filter(f => f.status === 'conflict').length, blocked: skills.filter(s => s.blocked).length, retired: skills.filter(s => s.retired).map(s => s.name) };
  return { schemaVersion: 1, ok: !summary.conflicts && !summary.blocked, generatedAt: new Date().toISOString(), sourceUnchanged: true, repositories, summary, skills, metrics: { elapsedMs: Math.round(performance.now() - started), repositories: groups.size, blobReads, modelRequests: 0, agentCost: 'not-measured' } };
}
