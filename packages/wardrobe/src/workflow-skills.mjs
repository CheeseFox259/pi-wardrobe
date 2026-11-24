import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePackagePath } from './git-source.mjs';
import { readJson } from './native-store.mjs';

/** Product policy is frozen with the input; execution belongs to the manager. */
export function workflowSkills(record) {
  const sharedPath=join(import.meta.dirname,'../skills','wardrobe-'+record.mode,'SKILL.md');
  const base=join(record.root,'base'),policyPath='skills/preset-policy/SKILL.md';
  const shared={path:sharedPath,body:readFileSync(sharedPath,'utf8')};
  if(existsSync(join(base,policyPath))){
    resolvePackagePath(base,policyPath,'/workflow/policy');
    const contracts='skills/preset-policy/COMPONENTS.md';
    if(existsSync(join(base,contracts)))resolvePackagePath(base,contracts,'/workflow/policy/contracts');
    return {shared,preset:{origin:'preset',path:join(base,policyPath),body:readFileSync(join(base,policyPath),'utf8'),
      ...(existsSync(join(base,contracts))?{contracts:{path:join(base,contracts),scope:'Read the affected component contract for defaults, overrides, preservation and behavior evidence.'}}:{})}};
  }
  const features=Object.entries(readJson(join(base,'components.json'),{}).skills||{}).flatMap(([name,skill])=>(skill.preservedFeatures||[]).map(feature=>({skill:name,feature})));
  return {shared,preset:{origin:'fallback',body:[
    'Preserve this preset’s existing behavior and local adaptations. Implement explicit user requirements.',
    'For optional changes with ambiguous behavior tradeoffs, retain existing behavior and record a reason for deferral. Ask only when an explicit requirement depends on that choice.',
    'No preset-specific design policy was supplied. Consult the frozen preset README when a product choice requires context; do not infer a new philosophy from upstream features.',
    ...(features.length?['Declared preserved features: '+JSON.stringify(features)]:[]),
  ].join('\n'),reference:existsSync(join(base,'README.md'))?join(base,'README.md'):undefined}};
}
