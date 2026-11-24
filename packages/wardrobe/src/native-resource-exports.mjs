import { mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, sep, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageRootFor } from './agent-files.mjs';
import { nativeResourceFilters } from './resource-filters.mjs';

const kinds=['extensions','skills','prompts','themes'];

/** Discover paths with the installed Pi, without importing resources or installing packages. */
export async function checkNativeResourceExports({plan,inventory,cli,inspectionRoot,requiredResources=[]}) {
  const core=join(dirname(cli),'core');
  const [{SettingsManager},{DefaultPackageManager}]=await Promise.all(['settings-manager','package-manager'].map(name=>import(pathToFileURL(join(core,name+'.js')).href)));
  const roots=new Map(inventory.map(entry=>[entry.alias,packageRootFor(plan,entry)]));
  const packages=[...roots].map(([alias,source])=>({source,...Object.fromEntries(kinds.map(kind=>[kind,nativeResourceFilters(source,plan.resourceSelectors.filter(s=>s.package===alias&&s.kind===kind).flatMap(s=>s.loaded))]))}));
  mkdirSync(inspectionRoot,{recursive:true,mode:0o700});
  try {
    const settingsManager=SettingsManager.inMemory({packages});
    const resources=await new DefaultPackageManager({cwd:inspectionRoot,agentDir:inspectionRoot,settingsManager}).resolve(async()=> 'error');
    const enabledByKind=new Map(kinds.map(kind=>[kind,new Set((resources[kind]||[]).filter(entry=>entry.enabled).map(entry=>realpathSync(entry.path)))]));
    const missing=[];
    for(const selector of [...plan.resourceSelectors,...requiredResources]) {
      const enabled=enabledByKind.get(selector.kind)||new Set(),root=roots.get(selector.package);
      for(const path of selector.loaded) {
        let reason;
        try{
          if(!root)throw new Error('Resource package is missing from installed inventory');
          const target=realpathSync(join(root,path));
          if(!enabled.has(target)&&!(statSync(target).isDirectory()&&[...enabled].some(file=>file.startsWith(target+sep))))reason=`Not enabled by package.json pi.${selector.kind} exports and resource filters`;
        }catch(error){reason=error.message;}
        if(reason)missing.push({package:selector.package,kind:selector.kind,path,reason});
      }
    }
    if(missing.length)throw Object.assign(new Error('Native Pi cannot discover selected resources: '+missing.map(entry=>`${entry.kind}: ${entry.package}/${entry.path}`).join('; ')),{code:'RESOURCE_EXPORT_MISSING',resources:missing});
    return kinds.flatMap(kind=>(resources[kind]||[]).filter(entry=>entry.enabled).flatMap(entry=>{
      const file=realpathSync(entry.path),owner=[...roots].find(([,root])=>file===realpathSync(root)||file.startsWith(realpathSync(root)+sep));
      if(!owner)return [];
      const [alias,root]=owner,path=relative(realpathSync(root),file).replaceAll('\\','/');
      return [{id:alias+':'+kind+':'+path,package:alias,kind,path,file,enabled:true,selectors:plan.resourceSelectors.filter(s=>s.package===alias&&s.kind===kind).flatMap(s=>s.loaded).filter(p=>path===p||path.startsWith(p+'/'))}];
    }));
  } finally { rmSync(inspectionRoot,{recursive:true,force:true}); }
}
