import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { foldResources } from './compose.mjs';
import { readJson, writeJson } from './native-store.mjs';
import { resolvePackagePath } from './git-source.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
const run=promisify(execFile);

const kinds=['extensions','skills','prompts','themes'];
const key=r=>JSON.stringify([r.package,r.kind,r.path]);
const safe=path=>typeof path==='string'&&path&&!path.startsWith('/')&&!path.includes('\\')&&!path.split('/').some(p=>!p||p==='.'||p==='..');

export function resourceTable(source) {
  const definition=readJson(join(source,'preset.json')),pkg=readJson(join(source,'package.json'),{}),table=new Map();
  const self=Object.keys(definition.packages||{}).find(alias=>definition.packages[alias].source==='.');
  for(const r of pkg.wardrobe?.resourceCatalog||[])table.set(key(r),{...r,enabled:false});
  for(const kind of kinds)for(const path of pkg.pi?.[kind]||[]) {
    const r={package:self,kind,path};table.set(key(r),{...r,enabled:false});
  }
  for(const selector of foldResources([{kind:'preset',identity:definition.id,definition}],Object.keys(definition.packages||{}).map(alias=>({alias}))))for(const path of selector.loaded) {
    const r={package:selector.package,kind:selector.kind,path};table.set(key(r),{...r,enabled:true});
  }
  return [...table.values()];
}

function owned(components={}) {
  return {upstreams:components.upstreams,presetUpstream:components.presetUpstream,updateState:components.updateState,
    skills:Object.fromEntries(Object.entries(components.skills||{}).map(([name,s])=>[name,
      s.type==='override'?{type:s.type,baseRef:s.baseRef,upstream:s.upstream,upstreamRepo:s.upstreamRepo,upstreamRelPath:s.upstreamRelPath}: {type:s.type}]))};
}

/** Restore frozen lineage before the program applies reviewed resource decisions. */
export function restoreOwnedFields(source, base, {piVersion}={}) {
  const componentsPath=join(source,'components.json'),baseComponents=readJson(join(base,'components.json'),{});
  if(existsSync(componentsPath)){
    const components=readJson(componentsPath),baseline=owned(baseComponents);
    components.upstreams=baseline.upstreams;components.presetUpstream=baseline.presetUpstream;components.updateState=baseline.updateState;
    const skills={...baseComponents.skills,...components.skills};
    for(const [name,skill] of Object.entries(skills)){
      if(!Object.hasOwn(baseComponents.skills||{},name)){if(skill.type!=='custom')delete skills[name];continue;}
      skills[name]={...skill,...baseline.skills[name]};
    }
    if(baseComponents.skills||components.skills)components.skills=skills;
    writeJson(componentsPath,components);
  }
  const manifestPath=join(source,'manifest.json');
  if(existsSync(manifestPath)){
    const manifest=readJson(manifestPath),before=readJson(join(base,'manifest.json'),{}),skills=manifest.skills||[];
    manifest.piVersion=piVersion||before.piVersion;
    if(before.skills||manifest.skills)manifest.skills=(before.skills||[]).map((skill,index)=>({...skill,...skills[index],source:skill.source,ref:skill.ref}));
    writeJson(manifestPath,manifest);
  }
}

export function compileResources(source, current, changes=[], {persist=true}={}) {
  const definition=readJson(join(source,'preset.json')),pkg=readJson(join(source,'package.json'));
  const table=new Map(current.map(r=>[key(r),{...r}])),aliases=Object.keys(definition.packages||{});
  const fail=(code,message,index,change,field,details={})=>{throw Object.assign(new Error(message),{code,resourceChange:{index,field,change,...details}});};
  for(const [index,change] of changes.entries()) {
    if(!aliases.includes(change.package)&&!(change.action==='retire'&&table.has(key(change))))fail('WORKFLOW_RESOURCE_PACKAGE',`resources[${index}].package ${JSON.stringify(change.package)} is not a declared package alias in preset.json; use one of: ${aliases.join(', ')}. A removed alias may only retire an existing workflow resource.`,index,change,'package',{allowedPackages:aliases});
    if(!kinds.includes(change.kind))fail('WORKFLOW_RESOURCE_KIND',`resources[${index}].kind ${JSON.stringify(change.kind)} is not supported; use one of: ${kinds.join(', ')}`,index,change,'kind',{allowedKinds:kinds});
    if(!safe(change.path))fail('WORKFLOW_RESOURCE_PATH',`resources[${index}].path ${JSON.stringify(change.path)} must be a safe relative path`,index,change,'path');
    const id=key(change),prior=table.get(id);
    if(change.action==='add'||change.action==='replace'){
      if(change.action==='replace'){
        if(!safe(change.oldPath))fail('WORKFLOW_RESOURCE_PATH',`resources[${index}].oldPath ${JSON.stringify(change.oldPath)} must be the old resource's safe relative path, not a package source`,index,change,'oldPath');
        const old=key({...change,path:change.oldPath});
        if(!table.has(old))fail('WORKFLOW_RESOURCE_REPLACE',`resources[${index}].oldPath ${JSON.stringify(change.oldPath)} does not identify an existing ${change.package}/${change.kind} resource`,index,change,'oldPath');
        table.delete(old);
      }
      if(definition.packages[change.package].source==='.')resolvePackagePath(source,change.path,'/workflow/resources');
      table.set(id,{package:change.package,kind:change.kind,path:change.path,enabled:change.enabled!==false});
    } else if(['enable','disable','retire'].includes(change.action)) {
      if(!prior)fail('WORKFLOW_RESOURCE_MISSING',`resources[${index}] does not identify an existing ${change.package}/${change.kind}/${change.path} resource`,index,change,'path');
      if(change.action==='retire')table.delete(id);else prior.enabled=change.action==='enable';
    } else fail('WORKFLOW_RESOURCE_ACTION',`resources[${index}].action ${JSON.stringify(change.action)} is not supported`,index,change,'action');
  }
  const resources=[...table.values()],selectors=new Map(),orphaned=resources.filter(r=>!aliases.includes(r.package));
  if(orphaned.length)throw Object.assign(new Error(`preset.json removed package aliases still used by workflow resources. Restore the package declaration or explicitly retire each resource: ${JSON.stringify(orphaned.map(({package:alias,kind,path})=>({action:'retire',package:alias,kind,path})))}`),{code:'WORKFLOW_RESOURCE_PACKAGE'});
  // Preserve explicit empty selections: Pi empty exports are NOT a no-discovery declaration.
  for(const r of [...current,...resources])if(aliases.includes(r.package))selectors.set(r.package+'/'+r.kind,{package:r.package,kind:r.kind,include:[]});
  for(const r of resources.filter(r=>r.enabled))selectors.get(r.package+'/'+r.kind).include.push(r.path);
  definition.resources=[...selectors.values()];
  pkg.pi||={};
  for(const kind of kinds)pkg.pi[kind]=[...new Set(resources.filter(r=>definition.packages[r.package]?.source==='.'&&r.kind===kind).map(r=>r.path))];
  pkg.wardrobe||={};pkg.wardrobe.resourceCatalog=resources.map(({package:alias,kind,path})=>({package:alias,kind,path}));
  if(persist){writeJson(join(source,'preset.json'),definition);writeJson(join(source,'package.json'),pkg);}
  return resources;
}

export function validateMigrations(source, base, migrations=[]) {
  const mappings=new Map();
  for(const migration of migrations) {
    if(!migration.reason?.trim()||!Array.isArray(migration.from)||!migration.from.length||!Array.isArray(migration.to)||!migration.to.length)throw new Error('Migration requires from/to path arrays and a preservation reason');
    for(const path of migration.to){if(!safe(path))throw new Error('Unsafe migration target');resolvePackagePath(source,path,'/workflow/migration');if(!readFileSync(join(source,path)).length)throw new Error('Migration target is empty: '+path);}
    for(const path of migration.from){
      if(!safe(path)||!existsSync(join(base,path))||mappings.has(path))throw new Error('Invalid or duplicate migration source: '+path);
      mappings.set(path,migration.to);
    }
  }
  return mappings;
}

/** An adopt decision copies the exact upstream skill tree, including companions. */
export async function adoptNewSkills(source, batch, submission) {
  const capability=batch.capability,registrations=[],resources=[...(submission.resources||[])];
  if(capability?.kind!=='new-skills')return {resources,registrations};
  const definition=readJson(join(source,'preset.json')),self=Object.keys(definition.packages).find(k=>definition.packages[k].source==='.');
  for(const path of capability.paths){
    const decision=submission.decisions.find(d=>d.id==='new-skill:'+capability.repo+'#'+path);
    if(!decision||decision.action==='defer')continue;
    const name=path.split('/').at(-2),selected=resources.find(r=>r.upstreamPath===path),local=selected?.path||'skills/'+name+'/SKILL.md';
    if(!safe(local)||!local.endsWith('/SKILL.md'))throw new Error('New skill needs a safe local SKILL.md entry');
    if(decision.action==='adopt'){
      const folder=dirname(path),destination=dirname(local);
      const {stdout}=await run('git',['-C',capability.cache,'ls-tree','-rz',capability.target,'--',':(literal)'+folder],{encoding:'utf8',timeout:45000,maxBuffer:4*1024*1024});
      for(const row of stdout.split('\0').filter(Boolean)){
        const match=/^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(row);
        if(!match)throw new Error('Unsupported upstream skill file');
        const relative=match[3].slice(folder.length+1);if(!safe(relative))throw new Error('Unsafe upstream companion path');
        const {stdout:bytes}=await run('git',['-C',capability.cache,'cat-file','blob',match[2]],{encoding:'buffer',timeout:45000,maxBuffer:16*1024*1024});
        const target=join(source,destination,relative);mkdirSync(dirname(target),{recursive:true});
        if(existsSync(target)&&!readFileSync(target).equals(bytes))throw new Error('New upstream skill overlaps a local file; adapt instead: '+local);
        writeFileSync(target,bytes);chmodSync(target,match[1]==='100755'?0o755:0o644);
      }
    }
    resolvePackagePath(source,local,'/workflow/new-skill');
    if(!selected)resources.push({action:'add',package:self,kind:'skills',path:local,enabled:true});
    registrations.push({name,type:'override',upstreamRepo:capability.repo,baseRef:capability.target,upstreamRelPath:path,localPath:local});
  }
  return {resources,registrations};
}
