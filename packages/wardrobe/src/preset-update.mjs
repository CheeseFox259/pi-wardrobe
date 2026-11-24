import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { readJson, writeJson } from './native-store.mjs';
import { resolvePackagePath } from './git-source.mjs';
import { sourceDigest } from './native-snapshot.mjs';

export function skillReviewDigest(source, skill) {
  const root=join(source,dirname(skill.localPath));
  return existsSync(root)?sourceDigest(root):null;
}

const run = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = async (repo, args) => (await run('git', ['-C', repo, ...args], { timeout: 45000, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' } })).stdout;
const text = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const safe = path => typeof path === 'string' && path && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') && !path.split('/').some(p => !p || p === '.' || p === '..');

function localTree(root, directory) {
  if (!safe(directory)) throw new Error('Unsafe resource path: ' + directory);
  const files = new Map();
  const visit = path => {
    const absolute = resolvePackagePath(root, path, '/update/local');
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('Review resource symlinks separately: ' + path);
    if (stat.isDirectory()) for (const name of readdirSync(absolute).sort()) { if (!['.git', 'node_modules', '__pycache__'].includes(name)) visit(path + '/' + name); }
    else if (stat.isFile()) files.set(path, { bytes: readFileSync(absolute), mode: stat.mode & 0o111 ? '100755' : '100644' });
  };
  visit(directory); return files;
}

async function upstreamTree(repo, ref, directory) {
  const result = new Map();
  for (const row of text(await git(repo, ['ls-tree', '-rz', ref, ...(directory==='.'?[]:['--', ':(literal)' + directory])])).split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
    if (!match || !safe(match[3])) throw new Error('Unsupported upstream resource: ' + row);
    result.set(match[3], { oid: match[2], mode: match[1] });
  }
  return result;
}

function sameLocal(local, upstream) {
  if (!local || !upstream || local.mode !== upstream.mode) return false;
  const hash = createHash(upstream.oid.length === 64 ? 'sha256' : 'sha1').update(`blob ${local.bytes.length}\0`).update(local.bytes).digest('hex');
  return hash === upstream.oid;
}

async function repository(cacheDir, url, refs, metrics) {
  const root = join(cacheDir, sha(url).slice(0, 24) + '.git');
  if (!existsSync(root)) {
    mkdirSync(cacheDir, { recursive: true });
    await run('git', ['clone', '--bare', '--filter=blob:none', '--no-tags', '--', url, root], { timeout: 90000, maxBuffer: 1024 * 1024 });
    metrics.clones++;
  }
  const missing = [];
  for (const ref of new Set(refs)) {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(ref || '')) throw new Error('Exact upstream ref required');
    try { await git(root, ['cat-file', '-e', ref + '^{commit}']); } catch { missing.push(ref); }
  }
  if (missing.length) { await git(root, ['fetch', '--no-tags', 'origin', ...missing]); metrics.fetches++; }
  return root;
}

async function blob(repo, entry, metrics) {
  if (!entry) return null;
  // Read locally cached blobs; a partial clone may fetch a missing blob once.
  const { stdout } = await run('git', ['-C', repo, 'cat-file', 'blob', entry.oid], { timeout: 45000, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  metrics.blobsRead++; return stdout;
}

async function head(url) {
  const { stdout } = await run('git', ['ls-remote', '--', url, 'HEAD'], { timeout: 20000, maxBuffer: 1024 * 1024 });
  const ref = /^([a-f0-9]{40}(?:[a-f0-9]{24})?)\s+HEAD/m.exec(stdout)?.[1];
  if (!ref) throw new Error('Upstream HEAD unavailable: ' + url);
  return ref;
}

async function registryJson(url, metrics) {
  let response;
  for(let attempt=0;attempt<2;attempt++){
    try{
      response=await fetch(url,{signal:AbortSignal.timeout(15000)});
      if(response.status===429||response.status>=500){await response.body?.cancel();throw new Error('npm metadata '+response.status);}
      break;
    }catch(error){if(attempt===1)throw error;metrics.metadataRetries=(metrics.metadataRetries||0)+1;}
  }
  if(!response.ok)throw new Error('npm metadata '+response.status);
  return response.json();
}

async function changedFile({base,upstream,local,retired=false,metrics,...item}) {
  if(base?.oid===upstream?.oid && base?.mode===upstream?.mode)return null;
  Object.assign(item,{localHash:local?sha(local.bytes):null,localMode:local?.mode,baseMode:base?.mode,targetMode:upstream?.mode,baseOid:base?.oid,targetOid:upstream?.oid});
  if(retired||!upstream){item.action='REVIEW';item.reason=retired?'upstream-retired-or-moved; retain local':'upstream-deletion; retain local';}
  else if(sameLocal(local,upstream))item.action='PRESENT';
  else if(!base&&!local||sameLocal(local,base)){item.action='APPLY';item.contentBase64=(await blob(item.cache,upstream,metrics)).toString('base64');}
  else{item.action='REVIEW';item.reason=!local?'local-deletion/upstream-change':'upstream-touches-local-adaptation';}
  if(item.action==='REVIEW'){
    if(base)item.baseBase64=(await blob(item.cache,base,metrics)).toString('base64');
    if(upstream)item.targetBase64=(await blob(item.cache,upstream,metrics)).toString('base64');
  }
  return item;
}

async function presetFiles(plan,source,origin,cache,target) {
  const prefix=dirname(origin.path||'preset.json'),base=await upstreamTree(cache,origin.baseRef,prefix),incoming=await upstreamTree(cache,target,prefix);
  const handled=new Set(plan.files.map(f=>f.path));
  for(const path of new Set([...base.keys(),...incoming.keys()])){
    const destination=prefix==='.'?path:path.slice(prefix.length+1);
    if(handled.has(destination)||/(?:^|\/)(?:auth\.json|models\.json|node_modules|\.env(?:\.[^/]+)?)$/.test(destination))continue;
    let b=base.get(path);const u=incoming.get(path),file=join(source,destination);
    const savedBase=origin.fileBases?.[destination];
    if(savedBase)b=(await upstreamTree(cache,savedBase,prefix)).get(path);
    if(b?.oid===u?.oid&&b?.mode===u?.mode)continue;
    const local=existsSync(file)?{bytes:readFileSync(resolvePackagePath(source,destination,'/update/preset')),mode:lstatSync(file).mode&0o111?'100755':'100644'}:null;
    const item=await changedFile({skill:'preset',path:destination,upstreamPath:path,repo:origin.repo,baseRef:savedBase||origin.baseRef,targetRef:target,cache,preservedFeatures:['Local preset resources and preferences'],base:b,upstream:u,local,metrics:plan.metrics});
    if(item)plan.files.push(item);
  }
}

/** Read-only exact-input plan. No model requests, installs, or lineage writes. */
export async function planPresetUpdate({ source, cacheDir, piVersion, origin = null, registry = 'https://registry.npmjs.org/' }) {
  const started = Date.now(), components = readJson(join(source, 'components.json'), {}), manifest = readJson(join(source, 'manifest.json'), {}), definition = readJson(join(source, 'preset.json'));
  if (!definition) throw new Error('Standard preset.json required');
  const metrics = { clones: 0, fetches: 0, blobsRead: 0, modelRequests: 0 };
  const plan = { schemaVersion: 1, status: 'NO_UPDATE', source, runtime: null, repositories: [], files: [], capabilities: [], packages: [], lineage: {}, baselines: {}, blocked: [], metrics };
  const state = components.updateState || {}, groups = new Map();
  for (const [name, skill] of Object.entries(components.skills || {})) {
    if (skill.type !== 'override' || skill.enabled === false) continue;
    const upstream = components.upstreams?.[skill.upstream], url = skill.upstreamRepo || upstream?.repo;
    if (!url || !skill.baseRef || !safe(skill.localPath) || !safe(skill.upstreamRelPath || skill.localPath)) { plan.blocked.push({ skill: name, reason: 'Missing exact lineage or safe resource paths' }); continue; }
    if (!groups.has(url)) groups.set(url, []);
    groups.get(url).push({ name, ...skill, upstreamPath: skill.upstreamRelPath || skill.localPath });
  }
  const sources = new Map(Object.entries(components.upstreams || {}).map(([key, entry]) => [entry.repo, { key, ...entry }]));
  await Promise.all([...new Set([...sources.keys(), ...groups.keys()])].map(async url => {
    const config = sources.get(url), skills = groups.get(url) || [];
    try {
      const target = await head(url), checked = state.upstreams?.[url] || config?.pinnedRef;
      const record = { repo: url, target, previous: checked, key: config?.key }; plan.repositories.push(record);
      const repo = await repository(cacheDir, url, [target, ...skills.map(s => s.baseRef), ...(checked ? [checked] : [])], metrics); record.cache = repo;
      // Declared, previously unmodified skills need lineage too. Resolve unique
      // upstream names from the persisted exact manifest base, never from HEAD.
      const declaration = manifest.skills?.find(s => s.source === config?.key);
      if (declaration && checked) {
        const entries = text(await git(repo, ['ls-tree','-r','--name-only',checked])).split('\n').filter(p=>p.endsWith('/SKILL.md'));
        const names = declaration.requiredSkills || (Array.isArray(declaration.selection) ? declaration.selection : []);
        for (const name of names) {
          if (components.skills?.[name] || !existsSync(join(source,'skills',name,'SKILL.md'))) continue;
          const matches = entries.filter(p=>p.split('/').at(-2)===name);
          if (matches.length !== 1) { plan.capabilities.push({kind:'lineage-required',skill:name,repo:url,base:checked,matches}); continue; }
          const skill = {type:'override',upstream:config.key,baseRef:checked,localPath:'skills/'+name+'/SKILL.md',upstreamRelPath:matches[0]};
          skills.push({name,...skill,upstreamPath:matches[0]}); plan.lineage[name]=skill;
        }
      }
      const changed = target !== checked;
      if (changed) {
        record.diff = text(await git(repo, ['diff', '--no-renames', '--name-status', checked, target]));
        const before = text(await git(repo, ['ls-tree', '-r', '--name-only', checked])).split('\n');
        const after = text(await git(repo, ['ls-tree', '-r', '--name-only', target])).split('\n');
        const known = new Set(skills.map(s => s.upstreamPath));
        const addedSkills = after.filter(p => p.endsWith('/SKILL.md') && !before.includes(p) && !known.has(p));
        if (addedSkills.length) plan.capabilities.push({ kind: 'new-skills', repo: url, target, cache:repo, paths: addedSkills });
        if (!skills.length) plan.capabilities.push({ kind: 'source-update', repo: url, before: checked, target, cache:repo, diff: record.diff });
      }
      if (config?.upstreamRepo) {
        const targetOfficial = await head(config.upstreamRepo), checkedOfficial = state.upstreams?.[config.upstreamRepo] || config.upstreamRef;
        const official = await repository(cacheDir, config.upstreamRepo, [targetOfficial, checkedOfficial].filter(Boolean), metrics);
        plan.repositories.push({ repo: config.upstreamRepo, target: targetOfficial, previous: checkedOfficial, cache: official, key: config.key, official: true });
        if (targetOfficial !== checkedOfficial) plan.capabilities.push({ kind: 'official-update', repo: config.upstreamRepo, before: checkedOfficial, target: targetOfficial, cache: official, diff: checkedOfficial ? text(await git(official, ['diff', '--no-renames', '--name-status', checkedOfficial, targetOfficial])) : '' });
      }
      const reconsider=skill=>state.deferredSkills?.[skill.name]&&
        (state.deferredSkills[skill.name].local!==skillReviewDigest(source,skill)||state.deferredSkills[skill.name].pi!==piVersion);
      if (!changed&&!skills.some(reconsider)) return;
      for (const skill of skills) {
        if(!changed&&!reconsider(skill))continue;
        plan.baselines[skill.name]={baseRef:skill.baseRef,upstreamRelPath:skill.upstreamPath};
        const localRoot = dirname(skill.localPath).split('\\').join('/'), upstreamRoot = dirname(skill.upstreamPath).split('\\').join('/');
        const local = localTree(source, localRoot), base = await upstreamTree(repo, skill.baseRef, upstreamRoot), targetTree = await upstreamTree(repo, target, upstreamRoot);
        if (!local.has(skill.localPath)) throw new Error('Local skill entry missing: ' + skill.localPath);
        if (!base.has(skill.upstreamPath)) throw new Error('Recorded base entry missing: ' + skill.upstreamPath);
        const retired = !targetTree.has(skill.upstreamPath);
        if (retired && !changed) continue; // already retained at the recorded source-wide target
        for (const path of new Set([...base.keys(), ...targetTree.keys()])) {
          const b = base.get(path), u = targetTree.get(path), destination = localRoot + path.slice(upstreamRoot.length), l = local.get(destination);
          const item=await changedFile({skill:skill.name,path:destination,upstreamPath:path,repo:url,baseRef:skill.baseRef,targetRef:target,cache:repo,preservedFeatures:skill.preservedFeatures||[],base:b,upstream:u,local:l,retired,metrics});
          if(item)plan.files.push(item);
        }
      }
    } catch (error) { plan.blocked.push({ repo: url, reason: error.message }); }
  }));
  const presetOrigin = components.presetUpstream || (origin?.locator?.startsWith('git:') && origin.commit ? {repo:origin.locator.slice(4),baseRef:origin.commit,path:origin.presetPath || 'preset.json'} : null);
  if (presetOrigin) {
    try {
      const target = await head(presetOrigin.repo), previous = state.presetTarget || presetOrigin.baseRef;
      const cache = await repository(cacheDir,presetOrigin.repo,[previous,target,presetOrigin.baseRef,...Object.values(presetOrigin.fileBases||{})],metrics);
      plan.preset = {...presetOrigin,previous,target,cache};
      if (target !== previous) {
        plan.repositories.push({repo:presetOrigin.repo,previous,target,cache,preset:true});
        await presetFiles(plan,source,presetOrigin,cache,target);
        const prefix = dirname(presetOrigin.path || 'preset.json');
        // Whole-preset changes may overlap resource-level decisions. Hand this
        // delta to the model once rather than overwriting local adaptations.
        plan.capabilities.push({kind:'preset-update',repo:presetOrigin.repo,before:previous,target,cache,path:prefix,diff:text(await git(cache,['diff','--no-renames','--name-status',previous,target,'--',prefix]))});
      }
    } catch(error) { plan.blocked.push({repo:presetOrigin.repo,reason:error.message}); }
  }
  const oldPi = state.runtimePi || manifest.piVersion;
  if (oldPi && oldPi !== piVersion) plan.runtime = { before: oldPi, installed: piVersion, action: 'REVIEW', reason: 'Review native API/capability changes; Pi owns installation' };
  const packageSources = Object.values(definition.packages || {}).map(p => p.source).filter(p => p.startsWith('npm:'));
  await Promise.all(packageSources.map(async source => {
    const raw = source.slice(4), at = raw.lastIndexOf('@'), name = raw.slice(0, at), version = raw.slice(at + 1);
    try {
      const meta = await registryJson(new URL(name.replaceAll('/', '%2f') + '/latest', registry.endsWith('/') ? registry : registry + '/'),metrics), latest = meta.version;
      if (!latest) throw new Error('npm latest unavailable');
      plan.packages.push({ name, installed: version, latest, changed: latest !== (state.packages?.[name] || version), peerDependencies: meta.peerDependencies, repository: meta.repository, integrity: meta.dist?.integrity, action: 'REVIEW' });
    } catch (error) { plan.blocked.push({ package: name, reason: error.message }); }
  }));
  if (plan.blocked.length) plan.status = 'BLOCKED';
  else if (plan.runtime || plan.files.some(f => f.action !== 'PRESENT') || plan.capabilities.length || plan.packages.some(p => p.changed) || plan.repositories.some(r => r.target !== r.previous)) plan.status = 'REVIEW_REQUIRED';
  plan.repositories.sort((a,b)=>a.repo.localeCompare(b.repo));plan.files.sort((a,b)=>a.path.localeCompare(b.path));plan.capabilities.sort((a,b)=>(a.repo+a.kind).localeCompare(b.repo+b.kind));plan.packages.sort((a,b)=>a.name.localeCompare(b.name));
  metrics.elapsedMs = Date.now() - started;
  return plan;
}

/** Apply only deterministic changes to an editable candidate; never to an installed revision. */
export function applyUpdatePlan(plan, candidate, inputs) {
  if (plan.status === 'BLOCKED') throw new Error('Cannot apply a blocked update plan');
  const changes = [], originals = new Map();
  for (const item of plan.files) {
    if (!safe(item.path)) throw new Error('Unsafe update destination');
    const destination = join(candidate, item.path), current = existsSync(destination) ? readFileSync(resolvePackagePath(candidate, item.path, '/update/apply')) : null;
    if ((current ? sha(current) : null) !== item.localHash) throw new Error('Local source changed after planning: ' + item.path);
    originals.set(item.path,current);
  }
  for (const [index, item] of plan.files.entries()) {
    if (item.action === 'APPLY') {
      // Resolve the existing parent too, so additions cannot traverse a symlink.
      let parent = dirname(item.path);
      while (!existsSync(join(candidate, parent)) && parent !== '.') parent = dirname(parent);
      if (parent !== '.') resolvePackagePath(candidate, parent, '/update/apply');
      const destination = join(candidate, item.path); mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, Buffer.from(item.contentBase64, 'base64')); chmodSync(destination, item.targetMode === '100755' ? 0o755 : 0o644);
      changes.push(item.path);
    }
    const folder = join(inputs, String(index)); mkdirSync(folder, { recursive: true });
    const local=originals.get(item.path);
    const base=item.baseBase64!==undefined?Buffer.from(item.baseBase64,'base64'):item.action==='APPLY'&&item.baseOid?local:null;
    const upstream=item.targetBase64??item.contentBase64;
    const roles={base,local,upstream:upstream===undefined?null:Buffer.from(upstream,'base64')};
    const files={};
    for(const [role,bytes] of Object.entries(roles))if(bytes!==null){files[role]=join(folder,role);writeFileSync(files[role],bytes);}
    if(item.action==='REVIEW'){
      files.upstreamDiff=join(folder,'upstream.patch');files.localDiff=join(folder,'local.patch');
      writeFileSync(files.upstreamDiff,reviewDiff(files.base,files.upstream,item.path,'upstream'));
      writeFileSync(files.localDiff,reviewDiff(files.base,files.local,item.path,'local'));
      if(base&&local&&roles.upstream&&!base.includes(0)&&!local.includes(0)&&!roles.upstream.includes(0)){
        try{
          const merged=execFileSync('git',['merge-file','-p','--diff3',files.local,files.base,files.upstream],{encoding:'buffer',timeout:15000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']});
          files.merged=join(folder,'merged');writeFileSync(files.merged,merged);item.merge='CLEAN';
          item.mergedMode=item.baseMode===item.targetMode?item.localMode:item.targetMode;
          writeFileSync(join(candidate,item.path),merged);
          chmodSync(join(candidate,item.path),item.mergedMode==='100755'?0o755:0o644);
        }catch(error){if(!Number.isInteger(error.status)||error.status>127)throw error;item.merge='CONFLICT';}
      }
    }
    item.review=files;
    item.inputs = folder;delete item.baseBase64;delete item.targetBase64;delete item.contentBase64;
  }
  return changes;
}

function reviewDiff(before,after,path,role) {
  let output;
  try{output=execFileSync('git',['diff','--no-index','--no-ext-diff','--no-textconv','--no-color','--',before||'/dev/null',after||'/dev/null'],{encoding:'utf8',timeout:15000,maxBuffer:40*1024*1024,stdio:['ignore','pipe','pipe']});}
  catch(error){if(error.status!==1)throw error;output=String(error.stdout);}
  return output.replace(/^diff --git .*$/m,`diff --git base/${path} ${role}/${path}`).replace(/^--- .*$/m,'--- '+(before?'base/'+path:'/dev/null')).replace(/^\+\+\+ .*$/m,'+++ '+(after?role+'/'+path:'/dev/null'));
}

export function newSkillDecisions(capability) {
  return capability.kind==='new-skills' ? capability.paths.map(path=>({id:'new-skill:'+capability.repo+'#'+path,path})) : [];
}

export function updateMessage(plan, workspace) {
  if (plan.status === 'NO_UPDATE') return { status: 'NO_UPDATE', message: '无需更新', modelRequired: false, metrics: plan.metrics };
  return {
    status: plan.status, modelRequired: plan.status === 'REVIEW_REQUIRED', workspace,
    runtime: plan.runtime, releaseNotes:plan.releaseNotes, blocked: plan.blocked,
    applied: plan.files.filter(f => f.action === 'APPLY').map(f => f.path),
    decisions: [...new Set(plan.files.filter(f=>f.action==='REVIEW').map(f=>f.skill))].map(skill=>({id:'skill:'+skill,skill,preservedFeatures:plan.files.find(f=>f.skill===skill).preservedFeatures,files:plan.files.filter(f=>f.skill===skill&&f.action==='REVIEW').map(({path,reason,inputs,review})=>({path,reason,inputs,review}))})),
    capabilities: plan.capabilities.map(({diff,...entry})=>({...entry,...(entry.kind==='new-skills'?{decisions:newSkillDecisions(entry)}:{}),...(diff?{diffSummary:diff.split('\n').slice(-2).join('\n')}: {})})), packages: plan.packages.filter(p => p.changed),
    details: workspace && join(workspace.root, 'update-plan.json'), metrics: plan.metrics,
    next: plan.status === 'BLOCKED' ? 'Resolve blocked inputs; no candidate was applied.' : 'Review changed capabilities and local conflicts only. Record adopt/adapt/defer decisions, verify affected behavior, then install with wardrobe_workflow. Read TASK.md in workspace for the completion contract.',
  };
}

export async function advanceUpdateLineage(source, plan, decisions) {
  const components = readJson(join(source, 'components.json'), {}), manifest = readJson(join(source, 'manifest.json'), {});
  components.updateState = { ...components.updateState, ...(plan.preset?{presetTarget:plan.preset.target}:{}), runtimePi: plan.runtime?.installed || components.updateState?.runtimePi || manifest.piVersion, upstreams: {...components.updateState?.upstreams,...Object.fromEntries(plan.repositories.map(r => [r.repo, r.target]))}, packages: {...components.updateState?.packages,...Object.fromEntries(plan.packages.map(p => [p.name, p.latest]))}, decisions };
  components.updateState.deferredSkills={...components.updateState.deferredSkills};
  for(const [name,skill] of Object.entries(components.skills||{})){
    const decision=decisions.find(d=>d.id==='skill:'+name);
    if(decision?.action==='defer')components.updateState.deferredSkills[name]={local:skillReviewDigest(source,skill),pi:plan.runtime?.installed||components.updateState.runtimePi};
    else if(decision)delete components.updateState.deferredSkills[name];
  }
  if(plan.preset){
    components.presetUpstream={...plan.preset};delete components.presetUpstream.cache;delete components.presetUpstream.previous;delete components.presetUpstream.target;
    const deferred=decisions.some(d=>(d.id==='skill:preset'||d.id==='upstream:'+plan.preset.repo)&&d.action==='defer');
    if(!deferred){
      const fileBases={...components.presetUpstream.fileBases};
      for(const file of plan.files.filter(f=>f.skill==='preset')){
        const retained=decisions.some(d=>d.id===file.path&&d.action==='defer');
        if(!file.targetOid||retained)fileBases[file.path]=file.baseRef;else delete fileBases[file.path];
      }
      components.presetUpstream.baseRef=plan.preset.target;components.presetUpstream.fileBases=fileBases;
    }
  }
  for (const repository of plan.repositories.filter(r => !r.official && !r.preset)) {
    const deferred=decisions.some(d=>d.id==='upstream:'+repository.repo&&d.action==='defer');
    if (!deferred && repository.key && components.upstreams?.[repository.key]) components.upstreams[repository.key].pinnedRef = repository.target;
    components.skills = {...plan.lineage,...components.skills};
    for (const [name,skill] of Object.entries(components.skills || {})) {
      if (skill.type !== 'override' || skill.enabled === false || (skill.upstreamRepo || components.upstreams?.[skill.upstream]?.repo) !== repository.repo) continue;
      const relevant = plan.files.filter(f => f.path.startsWith(dirname(skill.localPath) + '/'));
      // Deferred or retained retired content keeps its real older baseline.
      if (!deferred && !relevant.some(f => decisions.some(d => (d.id === 'skill:'+f.skill || d.id === f.path) && d.action === 'defer'))) {
        const path = skill.upstreamRelPath || skill.localPath;
        if (!safe(path)) throw new Error('Unsafe integrated lineage path');
        try { await git(repository.cache,['cat-file','-e',repository.target+':'+path]); skill.baseRef=repository.target; }
        catch { /* Retired content retains the actual older base. */ }
      } else if(plan.baselines?.[name]) {
        Object.assign(skill,plan.baselines[name]);
      }
    }
    for (const skill of manifest.skills || []) if (!deferred && skill.source === repository.key) skill.ref = repository.target;
  }
  writeJson(join(source, 'components.json'), components); if (existsSync(join(source, 'manifest.json'))) writeJson(join(source, 'manifest.json'), manifest);
}
