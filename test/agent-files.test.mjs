import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { reviewAgentFiles, activateAgentFiles, combineAgentFiles } from '../packages/wardrobe/src/agent-files.mjs';
import { configurePerfectPi } from '../scripts/configure-perfect-pi.mjs';
function fixture(t,agent){
 const root=mkdtempSync(join(tmpdir(),'wardrobe-agent-files-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const source=join(root,'source'),destination=join(root,'agent');mkdirSync(source);mkdirSync(destination);
 writeFileSync(join(source,'seed.json'),'{"enabled":true}\n');
 writeFileSync(join(source,'package.json'),JSON.stringify({wardrobe:{agent:{schemaVersion:1,files:[],...agent}}}));
 const reviewed=()=>reviewAgentFiles({captured:{root:source},alias:'self'});
 return {root,source,destination,reviewed,activate:()=>activateAgentFiles({plan:{installationSurfaces:[{alias:'self'}],agent:reviewed()},inventory:[{alias:'self',installedPath:source}],agentDir:destination})};
}
test('agent file approval refuses private destinations, mutable code and path escapes',t=>{
 for(const target of ['models.json','auth.json','../scripts/check.mjs','scripts/../../escape']) {
  const f=fixture(t,{files:[{source:'seed.json',target}]});assert.throws(f.reviewed,error=>{
   assert.match(error.message,/unsafe/);assert.equal(error.diagnostics[0].path,'/wardrobe/agent/files/0');assert.match(error.diagnostics[0].hint,/wardrobe:agent-files/);return true;
  });
 }
 const f=fixture(t,{files:[{source:'seed.json',target:'scripts/check.mjs',mutable:true}]});assert.throws(f.reviewed,/only configuration seeds/);
 for(const settings of [{defaultTools:{}},{compaction:{auth:'private'}},{compaction:{constructor:'private'}},{perfectPiCompaction:{provider:'cpa',model:'test',apiKey:'private'}}]) assert.throws(fixture(t,{settings}).reviewed,/unsupported or private/);
});
test('agent defaults cannot configure a model or provider, including compaction', t => {
 for (const settings of [{perfectPiCompaction:{provider:'other',model:'choice'}},{defaultModel:'choice'},{defaultProvider:'other'},{enabledModels:['other/choice']},{modelThinkingLevels:{'other/choice':'high'}}]) {
  assert.throws(fixture(t,{settings}).reviewed,/unsupported or private/);
 }
});
test('device requirements are reviewed without an agent payload and conflict checks span packages', t => {
 const f=fixture(t,{});
 const requirement={id:'mcp',name:'MCP',kind:'file',target:'mcp.json',required:true};
 writeFileSync(join(f.source,'package.json'),JSON.stringify({wardrobe:{deviceBindings:[requirement]}}));
 assert.deepEqual(f.reviewed().deviceBindings,[requirement]);
 const seed=fixture(t,{files:[{source:'seed.json',target:'mcp.json',mutable:true}]}).reviewed();
 assert.throws(()=>combineAgentFiles([f.reviewed(),seed]),/device binding conflicts/);
 assert.throws(()=>combineAgentFiles([f.reviewed(),f.reviewed()]),/设备需求|绑定目标/);
});
test('failed activation rolls back files and directories and rejects destination symlinks',t=>{
 const f=fixture(t,{files:[{source:'seed.json',target:'scripts/first.json'},{source:'seed.json',target:'docs/second.json'}],directories:['mcp-data/context-mode']});
 mkdirSync(join(f.destination,'docs'));writeFileSync(join(f.destination,'docs/second.json'),'different');
 assert.throws(f.activate,/differs/);assert.equal(existsSync(join(f.destination,'scripts')),false);assert.equal(existsSync(join(f.destination,'mcp-data')),false);
 const outside=join(f.root,'outside');mkdirSync(outside);symlinkSync(outside,join(f.destination,'scripts'));
 assert.throws(f.activate,/symlink/);assert.equal(existsSync(join(outside,'first.json')),false);
});
test('mutable configuration seeds preserve existing private content and private directories use 0700',t=>{
 const f=fixture(t,{files:[{source:'seed.json',target:'mcp.json',mutable:true}],directories:['mcp-data/context-mode']});
 const privateText='{"mcpServers":{"private":{"token":"fixture-private-value"}}}\n';writeFileSync(join(f.destination,'mcp.json'),privateText);
 const undo=f.activate();assert.equal(readFileSync(join(f.destination,'mcp.json'),'utf8'),privateText);assert.equal(statSync(join(f.destination,'mcp-data/context-mode')).mode&0o777,0o700);undo();assert.equal(readFileSync(join(f.destination,'mcp.json'),'utf8'),privateText);
 assert.throws(()=>combineAgentFiles([f.reviewed(),f.reviewed()]),/conflicting agent file/);
});
test('retired model configuration helper never reads or writes private configuration', t => {
 const f=fixture(t,{});
 assert.throws(()=>configurePerfectPi({agentDir:f.destination,config:join(f.root,'nonexistent-private-file')}),/belongs to Pi/);
 assert.equal(existsSync(join(f.destination,'models.json')),false);
});
test('retired configuration CLI explains Pi ownership from paths with spaces and Unicode', t => {
 const f=fixture(t,{}), script=join(f.root,'旧 model helper.mjs');
 writeFileSync(script,readFileSync(new URL('../scripts/configure-perfect-pi.mjs',import.meta.url)));
 const result=spawnSync(process.execPath,[script,'--config',join(f.root,'nonexistent-private-file')],{encoding:'utf8'});
 assert.equal(result.status,1,result.stderr);
 assert.match(result.stderr,/belongs to Pi/);
 assert.equal(existsSync(join(f.destination,'models.json')),false);
});
