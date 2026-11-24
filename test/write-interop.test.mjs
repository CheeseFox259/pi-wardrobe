import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { useHarness } from './support/harness.mjs';
const harness = useHarness('write-interop');

test('footer-only statusline leaves SoL guarded writes and native edit diffs intact', async t => {
 const h=harness(),root=dirname(dirname(h.runtime.cliPath));
 const {createJiti}=await import(pathToFileURL(join(root,'dist/core/extensions/jiti-loader.js')));
 const require=createRequire(join(root,'dist/index.js'));
 const jiti=createJiti(join(root,'dist/index.js'),{alias:{'@earendil-works/pi-coding-agent':join(root,'dist/index.js'),'@earendil-works/pi-tui':require.resolve('@earendil-works/pi-tui'),typebox:require.resolve('typebox')}});
 const styleRoot=process.env.WARDROBE_TUI_FIXTURE;
 if(!styleRoot||!existsSync(join(styleRoot,'package.json'))){t.skip('set WARDROBE_TUI_FIXTURE to the real pinned pi-statusline package');return;}
 assert.equal(JSON.parse(readFileSync(join(styleRoot,'package.json'))).version,'0.50.2');
 const {default:registerStyle}=await jiti.import(join(styleRoot,'dist/index.ts'));
 const sol=await jiti.import(resolve('presets/perfect-pi/global/extensions/sol-pi.ts'));
 const tools=new Map(),handlers=new Map(),commands=new Map();let queued=0,hashChecks=0;
 const api={registerTool(tool){tools.set(tool.name,tool)},appendEntry(){},registerCommand(name,definition){commands.set(name,definition)},on(name,fn){handlers.set(name,fn)},getThinkingLevel:()=> 'high'};
 const queue={resolveToolPath:(cwd,p)=>resolve(cwd,p),withFusedFileQueue:async(_path,run)=>{queued++;return run()}};
 sol.registerSafeFusion(api,queue,async()=>{hashChecks++});const write=tools.get('write'),edit=tools.get('edit');
 registerStyle(api);
 const statuses=[];const ctx={cwd:process.cwd(),mode:'rpc',sessionManager:{},ui:{setStatus:(...a)=>statuses.push(a),setFooter(){},notify(){}}};
 await handlers.get('session_start')({},ctx);
 assert.equal(tools.size,2);assert.equal(tools.get('write'),write);assert.equal(tools.get('edit'),edit);assert.ok(commands.has('statusline'));
 const cwd=mkdtempSync(join(tmpdir(),'wardrobe-native-write-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));writeFileSync(join(cwd,'file.txt'),'before\n');let checks=0;
 const context={cwd,executeTool:async()=>{checks++;return {isError:false,result:{content:[{type:'text',text:'checked'}]}}}};
 const result=await write.execute('write',{path:'file.txt',content:'after\n',then_run:{command:'check'}},undefined,undefined,context);
 assert.equal(readFileSync(join(cwd,'file.txt'),'utf8'),'after\n');assert.match(result.content.at(-1).text,/then_run:succeeded/);assert.equal(checks,1);assert.equal(hashChecks,1);assert.equal(queued,1);
 const edited=await edit.execute('edit',{path:'file.txt',edits:[{oldText:'after',newText:'final'}]},undefined,undefined,context);
 assert.equal(readFileSync(join(cwd,'file.txt'),'utf8'),'final\n');assert.ok(edited.details.diff);assert.match(edited.details.diff,/after/);assert.match(edited.details.diff,/final/);
 await handlers.get('session_shutdown')({},ctx);assert.equal(tools.get('write'),write,'footer cleanup must never replace a tool');
});
