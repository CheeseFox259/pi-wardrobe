import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {test} from 'node:test';
import {useHarness} from './support/harness.mjs';
import {NativeStore,writeJson} from '../packages/wardrobe/src/native-store.mjs';
const harness=useHarness('implementation-native');

test('real Pi executes compound implementation, partial checks, final verification and inactive install',async()=>{
 const h=harness(),agent='implementation-native',dir=h.sandbox.seedAgent(agent),source=join(h.sandbox.work,'source');mkdirSync(source);
 writeJson(join(source,'package.json'),{name:'implementation-native',version:'1.0.0',type:'module',pi:{}});
 writeJson(join(source,'preset.json'),{schemaVersion:1,id:'implementation/native',name:'Native',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[]});
 writeJson(join(dir,'implementation-case.json'),{source});
 await h.pi.runOk(agent,['install',resolve('packages/wardrobe')]);
 const session=await h.pi.rpc(agent,{extraArgs:['-e',resolve('test/support/implementation-provider.mjs')]});
 try{
  await session.command('implementation-local');const before=(await session.request('get_state')).data.model;
  await session.request('prompt',{message:'Maintain the fixture and install the verified inactive revision. Installation is authorized.'});
  const log=join(dir,'implementation-requests.jsonl'),deadline=Date.now()+60000;let requests=[];
  while(Date.now()<deadline){
   if(existsSync(log))requests=readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
   if(requests.at(-1)?.name===null||requests.at(-1)?.state.status==='INSTALLED')break;
   await new Promise(r=>setTimeout(r,50));
  }
  assert.equal(requests.at(-1)?.state.status,'INSTALLED',JSON.stringify(requests));
  const focused=requests.find(r=>r.state.focus?.id==='implementation:second');
  assert.equal(focused.state.material.implementation.goal,'Deliver second');
  assert.ok(requests.some(r=>r.state.partialCheck?.passed));
  assert.ok(requests.some(r=>r.state.items?.some(i=>i.id==='implementation:first'&&i.status==='ready')));
  assert.equal(Object.keys(new NativeStore(dir).read().profiles).length,1);assert.equal(new NativeStore(dir).read().default,null);
  assert.deepEqual((await session.request('get_state')).data.model,before);
 }finally{await session.close();}
});

test('real Pi presents a capability report and applies the confirmed update',async()=>{
 const h=harness(),agent='proposal-native',dir=h.sandbox.seedAgent(agent),source=join(h.sandbox.work,'proposal-source');mkdirSync(source);
 writeJson(join(source,'package.json'),{name:'proposal-native',version:'1.0.0',type:'module',pi:{}});
 writeJson(join(source,'preset.json'),{schemaVersion:1,id:'proposal/native',name:'Proposal',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[]});
 writeJson(join(source,'manifest.json'),{piVersion:h.runtime.version});
 writeJson(join(dir,'implementation-case.json'),{source,updateReview:true});
 await h.pi.runOk(agent,['install',resolve('packages/wardrobe')]);
 const confirmations=[];
 const session=await h.pi.rpc(agent,{extraArgs:['-e',resolve('test/support/implementation-provider.mjs')],onConfirm:row=>{confirmations.push(row);return row.title==='Wardrobe · 更新方案';}});
 try{
  await session.command('implementation-local');
  await session.request('prompt',{message:'Update the fixture using the proposed scope. Installation is authorized after verification.'});
  const log=join(dir,'implementation-requests.jsonl'),deadline=Date.now()+20000;let requests=[],continued=false;
  while(Date.now()<deadline){
   if(existsSync(log))requests=readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
   if(!continued&&requests.at(-1)?.state.status==='PLAN_APPROVED'&&requests.at(-1)?.name===null&&!(await session.request('get_state')).data.isStreaming){
    await session.request('prompt',{message:'Implement the confirmed proposal.'});continued=true;
   }
   if(requests.at(-1)?.state.status==='INSTALLED')break;
   await new Promise(r=>setTimeout(r,50));
  }
  assert.equal(confirmations.length,1,JSON.stringify(requests.map(r=>[r.input?.action,r.state.status])));
  assert.match(JSON.stringify(confirmations[0]),/Expose the local status/);
  const editing=requests.find(r=>r.name==='write');
  assert.equal(editing?.state.planReview.phase,'approved');
  assert.match(editing.state.next,/submission\.resources/);
  assert.equal(requests.at(-1)?.state.status,'INSTALLED',JSON.stringify(requests.map(r=>[r.input?.action,r.state.status])));
  const config=new NativeStore(dir).read();
  assert.equal(config.default,null);
  assert.ok(Object.values(config.profiles)[0].resources.some(resource=>resource.path.endsWith('/prompts/indicator.md')));
 }finally{await session.close();}
});
