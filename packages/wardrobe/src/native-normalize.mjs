import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { publicSource, sourceDigest } from './native-snapshot.mjs';
import { readJson, writeJson } from './native-store.mjs';
import { captureSource } from './discover.mjs';
import { nativeEnv } from './native-service.mjs';
import { presetPreferences } from './agent-files.mjs';

/** Normalize declared legacy resource layouts without running their installer.
 * This preserves pins and source; runtime/capability adoption is a later update. */
export async function normalizePresetSource(store, input) {
  input=resolve(input);const manifest=readJson(join(input,'manifest.json'));
  if(!manifest?.piVersion||!Array.isArray(manifest.packages))throw new Error('Legacy source needs a declared manifest.piVersion and packages; otherwise author package.json/preset.json explicitly');
  const key=createHash('sha256').update(input+'\0'+sourceDigest(input)).digest('hex').slice(0,16),root=join(store.root,'normalizations',key),source=join(root,'source');
  if(existsSync(join(source,'preset.json')))return {status:'NORMALIZED',source,next:'import this standard source, then update; pins are unchanged'};
  mkdirSync(root,{recursive:true,mode:0o700});cpSync(input,source,{recursive:true,filter:publicSource});
  const files=(folder)=>existsSync(join(source,folder))?readdirSync(join(source,folder),{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(folder+'/'+e.name):[folder+'/'+e.name]):[];
  const global=existsSync(join(source,'global/extensions'))?'global/':'',kinds=['extensions','skills','prompts','themes'];
  const resources=[],pi={},packages={self:{source:'.'}};
  for(const kind of kinds){
    const folder=existsSync(join(source,global+kind))?global+kind:kind;
    const paths=files(folder).filter(p=>kind==='skills'?p.endsWith('/SKILL.md'):kind==='extensions'?/\.[cm]?[jt]s$/.test(p)&&/\bexport\s+default\b|\bexport\s*\{[^}]*\bdefault\b[^}]*\}\s*from\b|\bmodule\.exports\s*=/.test(readFileSync(join(source,p),'utf8')) :kind==='prompts'?p.endsWith('.md'):p.endsWith('.json'));
    const excluded=manifest.skillPolicy?.excludeFromPi||[];
    pi[kind]=paths.filter(p=>kind!=='skills'||!excluded.includes(p.split('/').at(-2)));
    resources.push({package:'self',kind,include:pi[kind]});
  }
  await Promise.all(manifest.packages.map(async (entry,index)=>{
    const alias='addon-'+index, locator=entry.source.replace(/^git:github\.com\//,'git:https://github.com/');packages[alias]={source:locator};
    let metadata;
    if(locator.startsWith('npm:')){
      const raw=locator.slice(4),at=raw.lastIndexOf('@'),name=raw.slice(0,at),version=raw.slice(at+1);
      const embedded=join(import.meta.dirname,'embedded-packuments',(name+'@'+version).replaceAll('/','__')+'.json');
      if(existsSync(embedded)){
        metadata=readJson(embedded,{});
      }else{
        const response=await fetch(new URL(name.replaceAll('/','%2f')+'/'+version,nativeEnv(store).WARDROBE_REGISTRY),{signal:AbortSignal.timeout(15000)});
        if(!response.ok)throw new Error('Cannot read declared resource metadata: '+locator+' HTTP '+response.status);
        metadata=await response.json();
      }
    }else{
      const captured=await captureSource(locator,{workDir:join(store.root,'normalization-captures'),env:nativeEnv(store),registry:nativeEnv(store).WARDROBE_REGISTRY});
      metadata=readJson(join(captured.root,'package.json'),{});
    }
    for(const kind of kinds){
      const include=entry[kind]===undefined?(metadata.pi?.[kind]||[]):entry[kind];
      if(include.some(p=>/[?*[{]/.test(p)))throw new Error('Resource patterns need explicit paths before import: '+locator+' '+kind);
      resources.push({package:alias,kind,include:include.map(p=>p.replace(/^\.\//,''))});
    }
  }));
  resources.sort((a,b)=>(a.package+'/'+a.kind).localeCompare(b.package+'/'+b.kind));
  if(existsSync(join(input,'.git'))){
    const git=(...args)=>execFileSync('git',['-C',input,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    let repo,baseRef;
    try{repo=git('remote','get-url','origin');baseRef=git('rev-parse','HEAD');}catch{ /* An unpublished local repository has no upstream lineage. */ }
    if(baseRef&&/^https?:\/\/|^ssh:\/\/|^git@/.test(repo||'')){
      const components=readJson(join(source,'components.json'),{});components.presetUpstream={repo,baseRef,path:'preset.json'};writeJson(join(source,'components.json'),components);
    }
  }
  const agentFiles=[];
  for(const [folder,target] of [['scripts','scripts'],['docs','docs'],['habits','habits'],[global+'agents','agents']])for(const path of files(folder))agentFiles.push({source:path,target:target+path.slice(folder.length),...(/^habits\/[^/]+\.md$/.test(path)?{mutable:true}:{})});
  for(const [path,target] of [[global+'AGENTS.md','AGENTS.md'],['manifest.json','manifest.json'],['components.json','components.json'],[global+'sol-pi.json','sol-pi.json']])if(existsSync(join(source,path)))agentFiles.push({source:path,target,...(target==='sol-pi.json'?{mutable:true}:{})});
  const title=existsSync(join(source,'README.md'))?/^#\s+(.+)$/m.exec(readFileSync(join(source,'README.md'),'utf8'))?.[1]:null;
  const name=manifest.name||title||'Imported preset',version='1.0.0';
  const portableDocs=[];
  for(const path of files('docs').filter(p=>p.endsWith('.md'))){
    const before=readFileSync(join(source,path),'utf8'),after=before.replace(/\/(Users|home)\/[^/\s"']+\//g,'/$1/user/');
    if(after!==before){writeFileSync(join(source,path),after);portableDocs.push(path);}
  }
  const portableFixtures=[];
  // This explicit synthetic sentinel is public test data, never a real key.
  // Keep the private-data scanner strict by spelling the same sentinel with
  // its supported fixture prefix everywhere in that test file.
  for(const path of files('.').filter(p=>/\.test\.[cm]?[jt]s$/.test(p))){
    const before=readFileSync(join(source,path),'utf8'),after=before.replaceAll('synthetic-secret','fixture-secret');
    if(after!==before){writeFileSync(join(source,path),after);portableFixtures.push(path);}
  }
  writeJson(join(source,'package.json'),{name:'wardrobe-import-'+key,version,type:'module',license:'MIT',pi,wardrobe:{agent:{schemaVersion:1,files:agentFiles,settings:{...presetPreferences(manifest.managedSettings||{}),...presetPreferences(manifest.defaultSettings||{})}}}});
  writeJson(join(source,'preset.json'),{schemaVersion:1,id:'imported/'+key,name,version,compatibility:{pi:'>='+manifest.piVersion},packages,resources});
  writeJson(join(root,'normalization.json'),{source:input,pi:manifest.piVersion,portableDocs,portableFixtures,policy:'Pins, source and local resources preserved; documentation user paths and explicit synthetic test sentinel made portable; no installer executed'});
  return {status:'NORMALIZED',source,baselinePi:manifest.piVersion,next:'Import this standard source before update. Normalization does not upgrade pins or judge capabilities.'};
}
