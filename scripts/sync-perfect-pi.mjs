#!/usr/bin/env node
// Rebuild the optional full preset from fixed, reviewable source snapshots.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptMaintenance, reviewedPiVersion } from './perfect-pi-maintenance.mjs';
import { adaptWriteInterop } from './perfect-pi-write-interop.mjs';
import { adaptModelOwnership, excludedModelAdapters } from './perfect-pi-model-ownership.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.argv[2] ?? '/Users/superhacker/perfect-pi');
const cache = resolve(process.argv[3] ?? '/tmp/wardrobe-perfect-pi-upstreams');
const fetchBytes = url => execFileSync('curl', ['--fail','--location','--retry','3','--http1.1','--silent','--show-error',url], {maxBuffer:64*1024*1024});
const ref = '2b8f450d5fa1470e6715e1528b0cab0663bf4be1';
const destination = join(root, 'presets/perfect-pi');
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 });
if (git(source, ['rev-parse', 'HEAD']).toString().trim() !== ref) throw new Error('Perfect Pi source HEAD must match the reviewed pin');
if (git(source, ['status', '--porcelain']).length) throw new Error('Perfect Pi source must be clean');
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
execFileSync('tar', ['-x', '-C', destination], { input: git(source, ['archive', ref]) });
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => { mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); };
const walk = path => readdirSync(path, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)]);
const manifest = json(join(destination, 'manifest.json'));
manifest.piVersion = reviewedPiVersion;
save(join(destination, 'manifest.json'), manifest);
delete manifest.defaultSettings.perfectPiCompaction;
delete manifest.solPi.reducerPolicy.provider;
delete manifest.solPi.reducerPolicy.model;
const lineage = [];
for (const entry of manifest.skills.filter(entry => !entry.source.startsWith('local:'))) {
  const checkout = join(cache, entry.source.replaceAll('/', '-'));
  if (!existsSync(checkout)) { mkdirSync(checkout, {recursive:true}); execFileSync('git', ['init', checkout]); }
  try { git(checkout, ['cat-file', '-e', entry.ref + '^{commit}']); }
  catch { git(checkout, ['fetch', '--depth=1', 'https://github.com/' + entry.source + '.git', entry.ref]); }
  git(checkout, ['checkout', '--detach', entry.ref]);
  const candidates = walk(join(checkout, 'skills')).filter(path => path.endsWith('/SKILL.md'));
  for (const skill of candidates) {
    const text = readFileSync(skill, 'utf8');
    const name = text.match(/^name:\s*["']?([^\n"']+)/m)?.[1]?.trim();
    if (!name || manifest.skillPolicy.excludeFromPi.includes(name)) continue;
    if (entry.selection !== 'all' && !entry.selection.includes(name)) continue;
    const target = join(destination, 'skills', name);
    const local = existsSync(join(target, 'SKILL.md'));
    // Copy companions before overlaying all original local adaptation files.
    cpSync(dirname(skill), target, { recursive:true });
    if (local) cpSync(join(source, 'skills', name), target, {recursive:true});
    lineage.push({name, source:entry.source, ref:entry.ref, path:skill.slice(checkout.length+1), localOverride:local});
  }
  const licenseDir = join(destination, 'licenses', entry.source.replaceAll('/', '-'));
  mkdirSync(licenseDir, {recursive:true});
  save(join(licenseDir,'UPSTREAM.json'),{repository:'https://github.com/'+entry.source,commit:entry.ref,...(existsSync(join(checkout,'package.json'))?{declaredLicense:json(join(checkout,'package.json')).license??null}:{})});
  for (const name of readdirSync(checkout).filter(name => /^(LICENSE|NOTICE|COPYING|THIRD_PARTY_NOTICES)/i.test(name))) cpSync(join(checkout,name),join(licenseDir,name),{recursive:true});
}
const skillPaths = readdirSync(join(destination,'skills')).sort().filter(name => existsSync(join(destination,'skills',name,'SKILL.md')) && !manifest.skillPolicy.excludeFromPi.includes(name)).map(name=>'skills/'+name+'/SKILL.md');
for (const entry of manifest.skills) for (const name of entry.requiredSkills ?? (Array.isArray(entry.selection) ? entry.selection : [])) {
  if (!skillPaths.includes('skills/'+name+'/SKILL.md')) throw new Error('Missing required skill '+name);
}
for (const path of walk(join(destination,'skills')).filter(path => /\.(md|mjs|py|sh)$/.test(path))) {
  const text=readFileSync(path,'utf8');
  writeFileSync(path,text.replaceAll('~/.pi/agent/skills/', '${PI_CODING_AGENT_DIR}/wardrobe/preset/skills/').replaceAll('~/.pi/agent/', '${PI_CODING_AGENT_DIR}/'));
}
const maintenance=join(destination,'skills/maintain/SKILL.md');
// Apply after all upstream/local skill overlays so their prompts match the runtime.
adaptModelOwnership(destination);
adaptWriteInterop(destination);
const text=readFileSync(maintenance,'utf8');
writeFileSync(maintenance,text.replace('# Perfect Pi Maintenance', '# Perfect Pi Maintenance\n\nThis is a Wardrobe revision. Read `<agent-dir>/docs/wardrobe-maintenance.md` before the steps below. Perform source edits and setup experiments in a separate checkout; update this runtime by reviewing and installing a new Wardrobe revision. Installed package roots are immutable. Resolve all runtime paths from `PI_CODING_AGENT_DIR`.'));
adaptMaintenance(destination);
const usage=join(destination,'docs/USAGE.zh-CN.md');
writeFileSync(usage, '# Wardrobe 迁移说明\n\n本文件保留上游独立版操作参考。当前运行于 Wardrobe 修订时，使用 pi-wardrobe/docs/usage.zh-CN.md 的安装流程；模型与认证由 Pi 原生功能管理，并遵循同目录 wardrobe-maintenance.md；不要对已安装修订运行下面的全局同步步骤。\n\n'+readFileSync(usage,'utf8'));
// Preserve public MCP pins/exposure and render machine paths only on activation.
const { managedMcpConfigs } = await import(new URL('../presets/perfect-pi/scripts/managed-mcp.mjs',import.meta.url));
const mcp = {mcpServers:managedMcpConfigs(manifest,'{{agentDir}}')};
for (const server of Object.values(mcp.mcpServers)) server.command='{{node}}';
// Optional credentialed servers are configured through /mcp-setup, as in the original clean install.
save(join(destination,'wardrobe-resources/mcp.json'),mcp);
save(join(destination,'wardrobe-resources/web-search.json'),{toolActivation:'eager'});
const files=[];
const add=(source,target,options={})=>files.push({source,target,...options});
add('global/AGENTS.md','AGENTS.md');
add('global/sol-pi.json','sol-pi.json',{mutable:true});
for(const name of ['manifest.json','components.json']) add(name,name);
for(const folder of ['scripts','docs','habits']) for(const file of walk(join(destination,folder))) {const relative=file.slice(destination.length+1);add(relative,relative,folder==='habits'?{mutable:true}:{});}
for(const file of walk(join(destination,'global/agents'))) add(file.slice(destination.length+1),'agents/'+file.split('/').at(-1));
for(const file of walk(join(destination,'skills'))) add(file.slice(destination.length+1),'wardrobe/preset/'+file.slice(destination.length+1));
add('wardrobe-resources/mcp.json','mcp.json',{mutable:true,template:true});
add('wardrobe-resources/web-search.json','web-search.json',{mutable:true});
const extensions=walk(join(destination,'global/extensions')).filter(path=>path.endsWith('.ts')).map(path=>path.slice(destination.length+1)).filter(path=>!excludedModelAdapters.includes(path));
const prompts=walk(join(destination,'global/prompts')).map(path=>path.slice(destination.length+1));
const npmMetadata=[];
for(const pkg of manifest.packages.filter(p=>p.source.startsWith('npm:'))) {
 const spec=pkg.source.slice(4), at=spec.lastIndexOf('@');
 const meta=JSON.parse(fetchBytes('https://registry.npmjs.org/'+spec.slice(0,at)+'/'+spec.slice(at+1)));
 const unpacked=join(cache,'packages',spec.replaceAll('/','-'));
 if(!existsSync(join(unpacked,'package/package.json'))) {
   const tar=fetchBytes(meta.dist.tarball);
   const [algorithm,expected]=meta.dist.integrity.split('-');
   if(createHash(algorithm).update(tar).digest('base64')!==expected)throw new Error('Tarball integrity mismatch '+spec);
   const names=execFileSync('tar',['-tz'],{input:tar}).toString().trim().split('\n');
   if(names.some(name=>!name.startsWith('package/')||name.split('/').includes('..')))throw new Error('Unsafe npm tarball');
   mkdirSync(unpacked,{recursive:true});execFileSync('tar',['-xz','-C',unpacked],{input:tar});
 }
 const packageRoot=join(unpacked,'package');
 const expand=(path,kind)=>{
   const relative=path.replace(/^\.\//,'');const absolute=join(packageRoot,relative);
   if(statSync(absolute).isFile())return [relative];
   if(kind==='extensions') {
     for(const index of ['index.ts','index.js'])if(existsSync(join(absolute,index)))return [relative+'/'+index];
     return readdirSync(absolute,{withFileTypes:true}).filter(e=>!e.name.startsWith('.')).flatMap(e=>{
       if(e.isFile())return /\.(ts|js)$/.test(e.name)?[relative+'/'+e.name]:[];
       for(const index of ['index.ts','index.js'])if(existsSync(join(absolute,e.name,index)))return [relative+'/'+e.name+'/'+index];
       return [];
     }).sort();
   }
   return walk(absolute).filter(file=>kind==='skills'?file.endsWith('/SKILL.md'):file.endsWith(kind==='themes'?'.json':'.md')).map(file=>file.slice(packageRoot.length+1));
 };
 const resources=Object.fromEntries(['extensions','skills','prompts','themes'].map(kind=>[kind,(meta.pi?.[kind]??[]).flatMap(path=>expand(path,kind))]));
 npmMetadata.push({source:pkg.source,pi:resources,integrity:meta.dist.integrity});
}
const settings={...manifest.managedSettings,...manifest.defaultSettings};delete settings.defaultThinkingLevel;
save(join(destination,'package.json'),{name:'perfect-pi-full',version:'1.0.0',type:'module',license:'MIT',description:'Complete pinned Perfect Pi, isolated by Wardrobe',pi:{extensions,skills:skillPaths,prompts},wardrobe:{agent:{schemaVersion:1,files,directories:Object.keys(manifest.mcpServers).map(name=>'mcp-data/'+name),settings}}});
const packages={self:{source:'.'}};
const resources=[{package:'self',kind:'extensions',include:extensions},{package:'self',kind:'skills',include:skillPaths},{package:'self',kind:'prompts',include:prompts}];
for(const [i,pkg] of manifest.packages.entries()) {
 const alias='native-'+i;packages[alias]={source:pkg.source};
 const metadata=npmMetadata.find(meta=>meta.source===pkg.source);
 for(const kind of ['extensions','skills','prompts','themes']) {const include=pkg.source === 'npm:pi-cc-extensions@0.9.12' && kind === 'extensions' ? [] : pkg[kind]??metadata?.pi?.[kind]??[];if(include.length) resources.push({package:alias,kind,include});}
}
save(join(destination,'preset.json'),{schemaVersion:1,id:'perfect-pi/full',name:'Perfect Pi Full',version:'1.0.0',compatibility:{pi:manifest.piVersion,platforms:['darwin-arm64']},packages,resources,runtime:{thinking:'high'}});
const checksums = Object.fromEntries(walk(destination).filter(path=>!path.endsWith('/migration.json')).map(path=>[path.slice(destination.length+1),createHash('sha256').update(readFileSync(path)).digest('hex')]));
save(join(destination,'migration.json'),{schemaVersion:1,source:{repository:'https://github.com/CheeseFox259/perfect-pi',commit:ref},skills:lineage,nativePackages:npmMetadata,counts:{skills:skillPaths.length,extensions:extensions.length,prompts:prompts.length,agentFiles:files.length},adaptations:['Wardrobe native package manifest and explicit resource selection','Portable agent file templates; no credentials copied','Skill paths use the revision; maintenance creates new revisions','Pi owns models and authentication; no model defaults, role pins or model-policy adapters','Cooperate with pinned ccstyle write metadata without replacing SoL fusion'],checksums});
console.log(JSON.stringify({destination,skills:skillPaths.length,extensions:extensions.length,agentFiles:files.length}));
