import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { useHarness } from './support/harness.mjs';
import { NativeStore,writeJson } from '../packages/wardrobe/src/native-store.mjs';
import { registerWorkflowTool } from '../packages/wardrobe/src/workflow-tool.mjs';
const harness=useHarness('workflow-layers');

test('starting maintenance loads one shared method and the selected preset design policy together',async()=>{
 const h=harness(),source=join(h.sandbox.work,'layers');mkdirSync(join(source,'skills/preset-policy'),{recursive:true});
 writeJson(join(source,'package.json'),{name:'layered-preset',version:'1.0.0',type:'module',pi:{}});
 writeJson(join(source,'preset.json'),{schemaVersion:1,id:'layers/local',name:'Local Notebook',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[]});
 writeFileSync(join(source,'skills/preset-policy/SKILL.md'),'---\nname: preset-policy\ndescription: Notebook product choices.\n---\nKeep OFFLINE_NOTEBOOK_POLICY. Synchronization is opt-in.\n');
 writeFileSync(join(source,'skills/preset-policy/COMPONENTS.md'),'OFFLINE_COMPONENT_CONTRACT: preserve explicit local selection.');
 const old=process.env.WARDROBE_PI_CLI;process.env.WARDROBE_PI_CLI=h.runtime.cliPath;
 try{
  let tool;registerWorkflowTool({registerTool:t=>tool=t,appendEntry(){}},new NativeStore(h.sandbox.seedAgent('layers')));
  const result=await tool.execute('layers',{action:'maintain',source,request:'Improve local export'},undefined,undefined,{cwd:h.sandbox.project});
  assert.equal(result.isError,undefined,JSON.stringify(result.details));
  const visible=JSON.parse(result.content[0].text);
  assert.match(visible.skills.shared.body,/wardrobe_workflow/);
  assert.match(visible.skills.preset.body,/OFFLINE_NOTEBOOK_POLICY/);
  assert.equal(visible.skills.preset.origin,'preset');
  assert.match(readFileSync(visible.skills.preset.contracts.path,'utf8'),/OFFLINE_COMPONENT_CONTRACT/);
  assert.ok(visible.skills.preset.contracts.path.startsWith(result.details.workspace.root+'/base/'));
  assert.doesNotMatch(visible.skills.shared.body,/OFFLINE_NOTEBOOK_POLICY|Perfect Pi/);
  const saved=await tool.execute('save',{action:'save',submission:{summary:'Plan the local export repair',checks:[]}},undefined,undefined,{cwd:h.sandbox.project});
  assert.equal(saved.isError,undefined,JSON.stringify(saved.details));
  const receipt=JSON.parse(saved.content[0].text);
  assert.equal(receipt.skills.preset.body,undefined,'routine receipts refer to the already loaded policy');
  assert.equal(receipt.skills.preset.origin,'preset');
  assert.equal(receipt.skills.preset.path,visible.skills.preset.path);
  assert.equal(receipt.saved.summary,'Plan the local export repair');
  assert.deepEqual(receipt.detailsCall,{action:'details'});
  assert.match(saved.details.skills.preset.body,/OFFLINE_NOTEBOOK_POLICY/,'native session keeps the full evidence');
  writeFileSync(join(result.details.workspace.source,'skills/preset-policy/SKILL.md'),'Erased policy');
  writeFileSync(join(result.details.workspace.source,'skills/preset-policy/COMPONENTS.md'),'Erased contract');
  const resumed=await tool.execute('details',{action:'details'},undefined,undefined,{cwd:h.sandbox.project});
  assert.match(JSON.parse(resumed.content[0].text).skills.preset.body,/OFFLINE_NOTEBOOK_POLICY/,'candidate edits cannot erase the starting design constraints');
  assert.match(readFileSync(JSON.parse(resumed.content[0].text).skills.preset.contracts.path,'utf8'),/OFFLINE_COMPONENT_CONTRACT/);
 }finally{if(old===undefined)delete process.env.WARDROBE_PI_CLI;else process.env.WARDROBE_PI_CLI=old;}
});

test('legacy presets get a conservative policy without inheriting another preset design',async()=>{
 const h=harness(),source=join(h.sandbox.work,'legacy');mkdirSync(source);
 writeJson(join(source,'package.json'),{name:'legacy',version:'1.0.0',pi:{}});
 writeJson(join(source,'preset.json'),{schemaVersion:1,id:'legacy/local',name:'Legacy',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[]});
 writeJson(join(source,'components.json'),{skills:{custom:{type:'override',preservedFeatures:['LOCAL_BEHAVIOR']}}});
 const old=process.env.WARDROBE_PI_CLI;process.env.WARDROBE_PI_CLI=h.runtime.cliPath;
 try{
  let tool;registerWorkflowTool({registerTool:t=>tool=t,appendEntry(){}},new NativeStore(h.sandbox.seedAgent('legacy')));
  const result=await tool.execute('legacy',{action:'maintain',source,request:'Repair export'},undefined,undefined,{cwd:h.sandbox.project});
  assert.equal(result.isError,undefined,JSON.stringify(result.details));
  const policy=JSON.parse(result.content[0].text).skills.preset;
  assert.equal(policy.origin,'fallback');assert.match(policy.body,/LOCAL_BEHAVIOR/);
  assert.doesNotMatch(policy.body,/Perfect Pi|Matt Pocock/);
 }finally{if(old===undefined)delete process.env.WARDROBE_PI_CLI;else process.env.WARDROBE_PI_CLI=old;}
});
