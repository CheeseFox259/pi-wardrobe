import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { workflowContextFor } from '../packages/wardrobe/src/workflow-context.mjs';

function setup(t){
 const root=mkdtempSync(join(tmpdir(),'wardrobe-reading-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const source=join(root,'source');mkdirSync(source);mkdirSync(join(root,'base'));
 const handlers=new Map(),scope=workflowContextFor({on:(n,h)=>handlers.set(n,h)},{root});
 scope.accept({kind:'update',status:'REVIEW_REQUIRED',handle:'test',workspace:{root,source},batch:{id:'runtime'}});
 const messages=[{role:'user',content:'Preserve behavior; review the current change.'}];
 handlers.get('context_with_system')({messages});
 const read=(id,path,text,extra={})=>messages.push({role:'assistant',content:[{type:'toolCall',id,name:'read',arguments:{path,...extra}}]},{role:'toolResult',toolName:'read',toolCallId:id,content:[{type:'text',text}]});
 const view=()=>handlers.get('context_with_system')({messages}).messages;
 return {root,source,handlers,messages,read,view};
}

test('large native reads point to the original range, not a recursively archived observation',t=>{
 const s=setup(t),file=join(s.root,'changelog.md'),text=Array.from({length:400},(_,i)=>'CHANGE_'+i+' '+'.'.repeat(100)).join('\n');writeFileSync(file,text);
 s.read('large',file,text);
 const output=s.view().find(m=>m.toolCallId==='large').content[0].text;
 assert.doesNotMatch(output,/\/observations\//,'the read result must not redirect into a second copy of itself');
 assert.match(output,/offset/);assert.ok(output.includes(file));
 assert.equal(existsSync(join(s.root,'observations')),false);
});

test('same version and overlapping read ranges are sent once, but unseen ranges, edits and native rebuilds remain readable',t=>{
 const s=setup(t),file=join(s.source,'api.md'),alias=join(s.root,'alias.md');
 writeFileSync(file,'FIRST_LINE\nSECOND_LINE\nTHIRD_LINE\n');symlinkSync(file,alias);
 s.read('first',file,'FIRST_LINE\nSECOND_LINE\n',{offset:1,limit:2});s.view();
 s.read('overlap',alias,'SECOND_LINE\nTHIRD_LINE\n',{offset:2,limit:2});
 let output=s.view().find(m=>m.toolCallId==='overlap').content[0].text;
 assert.doesNotMatch(output,/SECOND_LINE/);assert.match(output,/THIRD_LINE/);
 s.read('repeat',file,'FIRST_LINE\nSECOND_LINE\n',{offset:1,limit:2});
 output=s.view().find(m=>m.toolCallId==='repeat').content[0].text;
 assert.doesNotMatch(output,/FIRST_LINE|SECOND_LINE/);assert.match(output,/already|earlier/i);
 writeFileSync(file,'FIRST_LINE\nUPDATED_LINE\nTHIRD_LINE\n');s.read('changed',file,'FIRST_LINE\nUPDATED_LINE\n',{offset:1,limit:2});
 assert.match(s.view().find(m=>m.toolCallId==='changed').content[0].text,/UPDATED_LINE/);
 const rebuilt=s.handlers.get('context_with_system')({messages:[{role:'compactionSummary',content:'Native compacted history'},...s.messages.slice(-2)]});
 assert.match(JSON.stringify(rebuilt),/UPDATED_LINE/,'a pointer to removed history cannot replace evidence');
});

test('aliases and archive copies do not manufacture fresh observations',async t=>{
 const {captureObservations}=await import('../packages/wardrobe/src/workflow-observations.mjs');
 const s=setup(t),path=join(s.source,'fact.md'),alias=join(s.root,'fact-alias.md');writeFileSync(path,'FACT\n');symlinkSync(path,alias);
 const read=(id,path,args={})=>[{role:'assistant',content:[{type:'toolCall',id,name:'read',arguments:{path,...args}}]},{role:'toolResult',toolName:'read',toolCallId:id,content:[{type:'text',text:'FACT\n'}]}];
 assert.equal(captureObservations(s.root,read('first',path)).length,1);
 assert.deepEqual(captureObservations(s.root,read('alias',alias,{offset:1,limit:100})),[]);
 const archive=join(s.root,'observations','old.txt');mkdirSync(join(s.root,'observations'));writeFileSync(archive,'FACT\n');
 assert.deepEqual(captureObservations(s.root,read('archive',archive)),[]);
});

test('a changed file with a common prefix cannot rewrite the actual earlier read',t=>{
 const s=setup(t),file=join(s.source,'changed.md');writeFileSync(file,'same\nOLD_CONTENT\n');
 s.read('old',file,'same\nOLD_CONTENT\n');writeFileSync(file,'same\nNEW_CONTENT\n');
 assert.equal(s.view().find(m=>m.toolCallId==='old').content[0].text,'same\nOLD_CONTENT\n');
});

test('a final line without a newline still receives a continuation pointer',t=>{
 const s=setup(t),file=join(s.source,'no-newline.md'),text='x'.repeat(7999)+'\nIMPORTANT_LAST_LINE';writeFileSync(file,text);s.read('long',file,text);
 const output=s.view().find(m=>m.toolCallId==='long').content[0].text;
 assert.ok(output.includes('IMPORTANT_LAST_LINE')||output.includes('"offset":2'));
});

test('native compaction that retains the last result replaces old bulk with the new summary',t=>{
 const s=setup(t),file=join(s.source,'bulk.md');writeFileSync(file,'OLD_BULK_TO_DROP\nTAIL_EVIDENCE');
 s.read('bulk',file,'OLD_BULK_TO_DROP\n',{limit:1});s.view();s.read('tail',file,'TAIL_EVIDENCE',{offset:2});s.view();
 const rebuilt=s.handlers.get('context_with_system')({messages:[{role:'compactionSummary',content:'NEW_NATIVE_SUMMARY'},...s.messages.slice(-2)]});
 assert.match(JSON.stringify(rebuilt),/NEW_NATIVE_SUMMARY/);assert.doesNotMatch(JSON.stringify(rebuilt),/OLD_BULK_TO_DROP/);assert.match(JSON.stringify(rebuilt),/TAIL_EVIDENCE/);
});

test('native read continuation footers do not defeat overlap detection',t=>{
 const s=setup(t),file=join(s.source,'footer.md');writeFileSync(file,'FIRST\nSECOND\nTHIRD');
 for(const [index,footer] of ['Showing lines 1-2 of 3.','Showing lines 1-2 of 3 (50KB limit).','1 more lines in file.'].entries()){
   const id='footer-'+index;s.read(id,file,'FIRST\nSECOND\n\n['+footer+' Use offset=3 to continue.]');
   const text=s.view().find(m=>m.toolCallId===id).content[0].text;
   assert.match(text,/"offset":3/);
   if(index)assert.doesNotMatch(text,/FIRST|SECOND/);
 }
});
