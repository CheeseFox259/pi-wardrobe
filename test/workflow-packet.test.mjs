import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupWork } from '../packages/wardrobe/src/workflow-packet.mjs';

test('independent update work stays independently verifiable instead of joining fixed-size batches',()=>{
  const work=[
    {id:'runtime',required:['runtime'],files:[],runtime:{installed:'1.3.0'}},
    ...['one','two','three','four'].map(name=>({id:'skill:'+name,required:['skill:'+name],files:['skills/'+name+'/SKILL.md']})),
    {id:'package:ui',required:['package:ui'],files:[],package:{name:'ui'}},
    {id:'requested',required:['request'],files:[]},
  ];
  const grouped=groupWork(work,'also satisfy the requested feature');
  assert.deepEqual(grouped.map(item=>item.id),work.map(item=>item.id));
  assert.ok(grouped.every(item=>item.required.length===1));
});

test('small clean skill documents share review while code, conflicts and unbounded inputs stay separate',()=>{
  const names=['a','b','c','d','e','conflict','code'];
  const items=names.map(name=>({id:'skill:'+name,title:name,required:['skill:'+name],files:['skills/'+name+(name==='code'?'/run.mjs':'/SKILL.md')],repo:'upstream'}));
  const files=items.map((item,i)=>({path:item.files[0],merge:names[i]==='conflict'?'CONFLICT':'CLEAN',review:{}}));
  // No available diff is not proof of a small document; explicit byte sizes are
  // measured by the planner from immutable review files, not guessed here.
  assert.equal(groupWork(items,{files}).length,7);
});

test('bounded Markdown reviews combine decisions but leave code and conflicts isolated',t=>{
  const root=mkdtempSync(join(tmpdir(),'packet-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const work=Array.from({length:6},(_,i)=>({id:'skill:'+i,title:String(i),repo:'same',required:['skill:'+i],files:['skills/'+i+'/SKILL.md']}));
  const files=work.map((w,i)=>{const path=join(root,String(i));writeFileSync(path,'small change');return {path:w.files[0],merge:i===5?'CONFLICT':'CLEAN',review:{upstreamDiff:path}};});
  const grouped=groupWork(work,{files});
  assert.deepEqual(grouped.map(g=>g.required.length),[4,1,1]);
  assert.deepEqual(grouped.flatMap(g=>g.required),work.flatMap(g=>g.required));
  writeFileSync(join(root,'0'),'x'.repeat(12001));
  assert.deepEqual(groupWork(work,{files}).map(g=>g.required.length),[1,4,1]);
});
