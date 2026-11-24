import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, writeJson } from './native-store.mjs';
import { resolvePackagePath } from './git-source.mjs';

/** Preset entries delegate execution; old prose remains available as historical context. */
export function writeWorkflowGuidance(record,names){
  if(!Array.isArray(names)||!names.length||names.some(n=>!['update','maintain'].includes(n)))throw Error('guidance requires skills: ["update", "maintain"] or either name.');
  const definition=readJson(join(record.source,'preset.json')),self=Object.keys(definition.packages).find(k=>definition.packages[k].source==='.'),components=readJson(join(record.source,'components.json'),{});
  const resources=[];
  for(const name of new Set(names)){
    const selected=(record.resolvedResources||record.resources||[]).find(r=>r.package===self&&r.kind==='skills'&&r.path.endsWith('/'+name+'/SKILL.md'));
    const path=components.skills?.[name]?.localPath||selected?.path||'skills/'+name+'/SKILL.md';
    if(typeof path!=='string'||path.startsWith('/')||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Workflow skill needs a safe local path');
    let parent=dirname(path);while(!existsSync(join(record.source,parent)))parent=dirname(parent);
    resolvePackagePath(record.source,parent,'/workflow/guidance');
    const file=join(record.source,path),dir=dirname(file);if(existsSync(file))resolvePackagePath(record.source,path,'/workflow/guidance');mkdirSync(dir,{recursive:true});
    const previous=existsSync(file)?readFileSync(file,'utf8'):'';
    let archive=previous.includes('<!-- wardrobe:workflow:delegate -->')?previous.match(/\((legacy-workflow-[a-f0-9]+\.md)\)/)?.[1]:undefined;
    const description=name==='update'?'Update this preset against changed upstream capabilities while preserving local adaptations.':'Fix a requested preset bug or add a requested capability.';
    const lines=[`---\nname: ${name}\ndescription: ${description}\ndisable-model-invocation: true\n---`,
      '<!-- wardrobe:workflow:delegate -->',
      '# Preset '+name,
      `Call wardrobe_workflow with action "${name}", the current profile or local source${name==='maintain'?', and the concrete request':', and review: "human"'}. Follow the returned skills.shared method together with skills.preset design policy.`,
      name==='update'?'NO_UPDATE finishes the check. At READY_TO_INSTALL, install with existing authorization.':'At READY_TO_INSTALL, install with existing authorization.'];
    const generatedHeader=lines.shift(),frontmatter=previous.match(/^---\r?\n[\s\S]*?\r?\n---/)?.[0]||generatedHeader;
    const render=()=>frontmatter+'\n\n'+[...lines,...(archive?[`Legacy product context: [previous skill](${archive}). Consult only when a product constraint needs clarification; the shared method owns execution.`]:[])].join('\n\n')+'\n';
    if(previous&&previous.trim()!==render().trim()){
      archive='legacy-workflow-'+createHash('sha256').update(previous).digest('hex').slice(0,12)+'.md';
      if(existsSync(join(dir,archive)))resolvePackagePath(record.source,join(dirname(path),archive),'/workflow/guidance');
      writeFileSync(join(dir,archive),previous);
    }
    writeFileSync(file,render());
    components.skills||={};components.skills[name]={...components.skills[name],type:components.skills[name]?.type||'custom',localPath:path,workflowRole:name};
    resources.push({action:'add',package:self,kind:'skills',path,enabled:true});
  }
  writeJson(join(record.source,'components.json'),components);return resources;
}
