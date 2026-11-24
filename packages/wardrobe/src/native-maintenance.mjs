import { draftFromProfile, readDraft } from './native-authoring.mjs';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { packageRootFor } from './agent-files.mjs';
import { resolvePackagePath } from './git-source.mjs';
import { PlanStore } from './approval.mjs';
import { assertSafeId, StagingStore } from './staging.mjs';
import { readJson, writeJson } from './native-store.mjs';

import { publicSource, withLocalSnapshot } from './native-snapshot.mjs';
import { deviceValues } from './native-bindings.mjs';

export function maintenancePaths(store, profile, mode = 'maintain') {
  assertSafeId(profile.id);
  const root = profile.workflowRoot || join(store.root, mode === 'update' ? 'updates' : 'maintenance', profile.id);
  return { root, source: join(root, 'source'), record: join(root, 'maintenance.json'), task: join(root, 'TASK.md') };
}

/** Editable public source, separate from the running revision and private state. */
export async function prepareMaintenance(store, profile, { mode = 'maintain', request = '' } = {}) {
  const paths = maintenancePaths(store, profile, mode);
  const existing = readJson(paths.record);
  if (existing) {
    if (existing.profile !== profile.id || !existsSync(join(paths.source, 'preset.json'))) throw new Error('维护工作区不完整：' + paths.root);
    return { ...paths, ...existing };
  }
  if (existsSync(paths.root)) throw new Error('维护工作区不完整：' + paths.root);
  let plan, source, installedPackages=[], bindingValues = deviceValues(store, profile);
  if (profile.revision) {
    plan = new PlanStore(store.nativeDir).read(profile.revision);
    const surface = plan.installationSurfaces.find(entry => entry.source === '.');
    const attempt = new StagingStore(store.nativeDir).read(profile.revision)?.attempts.at(-1);
    installedPackages=(attempt?.installed||[]).map(entry=>({alias:entry.alias,source:plan.installationSurfaces.find(surface=>surface.alias===entry.alias)?.source,root:packageRootFor(plan,{...entry,installedPath:entry.installedRelative?join(attempt.agentDir,entry.installedRelative):entry.installedPath}),baselineOnly:true}));
    const installed = attempt?.installed.find(entry => entry.alias === surface?.alias);
    if (!installed) {
      const draft = await draftFromProfile(store, profile, { hidden: true }); source = draft.source; bindingValues = draft.bindingValues;
    } else source = packageRootFor(plan, { ...installed, installedPath: installed.installedRelative ? join(attempt.agentDir, installed.installedRelative) : installed.installedPath });
  } else {
    const draft = await draftFromProfile(store, profile, { hidden: true }), data = readDraft(store, draft.id);
    source = draft.source;
    bindingValues = draft.bindingValues;
    plan = { resourceSelectors: data.definition.resources, installationSurfaces: [] };
  }
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  try {
    cpSync(source, paths.source, { recursive: true, filter: publicSource });
    // Materialize prior package overrides in this source, including old local
    // derivatives, so maintenance never starts from an unmodified ancestor.
    const definition = readJson(join(paths.source, 'preset.json'));
    const version = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(profile.version);
    if (!version) throw new Error('无法递增预设版本：' + profile.version);
    definition.version = `${version[1]}.${version[2]}.${Number(version[3]) + 1}`;
    for (const entry of plan.installationSurfaces) if (definition.packages?.[entry.alias] && entry.source !== '.') definition.packages[entry.alias].source = entry.source;
    writeJson(join(paths.source, 'preset.json'), definition);
    const pkg=readJson(join(paths.source,'package.json')); if(pkg){pkg.version=definition.version;writeJson(join(paths.source,'package.json'),pkg);}
    cpSync(paths.source, join(paths.root, 'base'), { recursive: true, filter: publicSource });
    const record = { profile: profile.id, name: profile.name, origin: profile.source, pi: profile.compatibility?.pi, upstream: profile.maintenance?.upstream || profile.source, bindingValues, createdAt: new Date().toISOString() };
    writeJson(paths.record, record);
    const task = `# ${mode}\n\nEdit only ${JSON.stringify(paths.source)}. Local starting snapshot: ${JSON.stringify(join(paths.root, 'base'))}; upstream baseline is each resource's exact baseRef, not this local snapshot.\n\n${mode === 'maintain' ? 'Only implement the requested bug fix or capability: ' + request + '. Do not check unrelated upstream updates.' : 'Use the prepared incremental update inputs; preserve local customizations and judge only changed capabilities.'}\n\nUse affected checks only. Native Pi owns models, authentication and program updates. Installed revisions and defaults stay unchanged.\n`;
    writeJson(join(paths.root, 'inventory.json'), { resources: plan.resourceSelectors, packages: plan.installationSurfaces, installedPackages, customSkills: readJson(join(paths.source, 'components.json'), {})?.skills || {} });
    // A task file is agent guidance, not an extension hook or an auto-run script.
    writeFileSync(paths.task, task, { mode: 0o600 });
    return { ...paths, ...record };
  } catch (error) { rmSync(paths.root, { recursive: true, force: true }); throw error; }
}

function publicFiles(root) {
  return readdirSync(root).filter(name => publicSource(join(root, name))).flatMap(name => {
    const path = join(root, name);
    return lstatSync(path).isDirectory() ? publicFiles(path) : [path];
  });
}

// Check literal local Markdown links in skills, excluding code examples. Old
// unrelated broken links are tolerated; new breaks and removed targets are not.
function localSkillReferences(text) {
  let fence=null;
  const prose=text.split('\n').filter(line=>{
    const boundary=/^ {0,3}(`{3,}|~{3,})/.exec(line);
    if(fence){if(boundary&&boundary[1][0]===fence[0]&&boundary[1].length>=fence.length)fence=null;return false;}
    if(boundary){fence=boundary[1];return false;}return true;
  }).join('\n').replace(/(`+)[^`]*?\1/g,'');
  const targets=[];
  for(const match of prose.matchAll(/\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s()]+))(?:\s+["'][^\n]*?["'])?\s*\)/g)){
    const raw=(match[1]||match[2]).split(/[?#]/)[0];
    if(!raw||/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(raw))continue;
    try{targets.push(decodeURIComponent(raw));}catch{targets.push(raw);}
  }
  return [...new Set(targets)];
}

export function checkMaintenance(store, profile, plan = null, {mappings=new Map()} = {}) {
  const paths = maintenancePaths(store, profile), inventory = readJson(join(paths.root, 'inventory.json'));
  if (!inventory) throw new Error('维护清单缺失，请重新准备');
  for (const [name, skill] of Object.entries(inventory.customSkills).filter(([, entry]) => entry.type === 'custom')) {
    const local = skill.localPath || `skills/${name}/SKILL.md`;
    const base = resolvePackagePath(join(paths.root, 'base'), local, '/maintenance/custom');
    for (const file of publicFiles(dirname(base))) {
      const path = relative(join(paths.root, 'base'), file);
      if (!existsSync(join(paths.source, path))) {
        if(!mappings.has(path))throw new Error('自定义技能文件缺失：' + path);
        for(const target of mappings.get(path))resolvePackagePath(paths.source,target,'/maintenance/migration');
      } else resolvePackagePath(paths.source, path, '/maintenance/custom');
    }
    if (plan && skill.enabled !== false && !plan.resourceSelectors.some(entry => entry.kind === 'skills' && entry.loaded.some(path => path === local || local.startsWith(path + '/') && lstatSync(join(paths.source,path),{throwIfNoEntry:false})?.isDirectory()))) throw new Error('自定义技能未启用：' + name);
  }
  const missingReferences=[];
  for (const file of publicFiles(paths.source)) {
    const bytes = readFileSync(file);
    if (!bytes.includes(0) && /^(?:<<<<<<< |>>>>>>> )/m.test(bytes.toString('utf8'))) throw new Error('合并冲突未解决：' + relative(paths.source, file));
    if(basename(file)==='SKILL.md'&&!bytes.includes(0)){
      const local=relative(paths.source,file),baseFile=join(paths.root,'base',local);
      const prior=new Set(existsSync(baseFile)?localSkillReferences(readFileSync(baseFile,'utf8')):[]);
      for(const target of localSkillReferences(bytes.toString('utf8'))){
        const resolved=resolve(dirname(file),target);
        if(existsSync(resolved)||prior.has(target)&&!existsSync(resolve(dirname(baseFile),target)))continue;
        missingReferences.push({file:local,target,resolved:relative(paths.source,resolved)});
      }
    }
  }
  if(missingReferences.length)throw Object.assign(new Error('Broken skill links (relative to each SKILL.md): '+missingReferences.map(entry=>entry.file+' -> '+entry.target).join('; ')),{code:'SKILL_REFERENCE_MISSING',references:missingReferences});
  if (!existsSync(join(paths.root, 'REPORT.md')) || !readFileSync(join(paths.root, 'REPORT.md'), 'utf8').trim()) throw new Error('请先完成维护验证报告');
}

/** Serve one fixed public snapshot only for review/install, then close it. */
export async function withMaintenanceSource(store, profile, callback, env) {
  const paths = maintenancePaths(store, profile);
  if (readJson(paths.record)?.profile !== profile.id) throw new Error('请先维护此 preset');
  checkMaintenance(store, profile);
  resolvePackagePath(paths.source, 'preset.json', '/maintenance/preset');
  return withLocalSnapshot(join(paths.root, 'snapshots'), paths.source, source => callback(source, readJson(paths.record)), env);
}
