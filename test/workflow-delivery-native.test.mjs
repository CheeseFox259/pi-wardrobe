import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { useHarness } from './support/harness.mjs';
import { NativeStore, writeJson } from '../packages/wardrobe/src/native-store.mjs';

const harness=useHarness('workflow-delivery-native');

for(const settlementRecovery of [false,true])test(settlementRecovery?'real Pi continues an independent item after premature settlement and resolves the remaining blocker before installation':'real Pi constrains repeated exploration, rejects an incomplete decision, then reviews two skill updates together and installs inactive',async()=>{
  const h=harness(),agent=settlementRecovery?'settlement':'delivery',dir=h.sandbox.seedAgent(agent),source=join(h.sandbox.work,'source-'+agent);
  const skill=(name,text)=>`---\nname: ${name}\ndescription: ${name} method\n---\n${text}\n`;
  const upstream=await h.gitRepo(agent+'-upstream',[{message:'base',files:{'skills/alpha/SKILL.md':skill('alpha','old alpha'),'skills/beta/SKILL.md':skill('beta','old beta')}},{message:'target',files:{'skills/alpha/SKILL.md':skill('alpha','new alpha'),'skills/beta/SKILL.md':skill('beta','new beta')}}]);
  const base=upstream.commits[0],repo=upstream.sourceAt(base).slice(4).replace(/@[a-f0-9]{40}$/,'');
  for(const name of ['alpha','beta','custom']){mkdirSync(join(source,'skills',name),{recursive:true});writeFileSync(join(source,'skills',name,'SKILL.md'),skill(name,name==='custom'?'Keep our private local method.':'old '+name));}
  mkdirSync(join(source,'skills/preset-policy'));
  writeFileSync(join(source,'skills/preset-policy/SKILL.md'),skill('preset-policy','Keep LOCAL_DELIVERY_POLICY; local custom methods remain available.'));
  writeJson(join(source,'package.json'),{name:'delivery-case',version:'1.0.0',type:'module',pi:{skills:['skills/alpha/SKILL.md','skills/beta/SKILL.md','skills/custom/SKILL.md']}});
  writeJson(join(source,'preset.json'),{schemaVersion:1,id:'delivery/demo',name:'Delivery',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[{package:'self',kind:'skills',include:['skills/alpha/SKILL.md','skills/beta/SKILL.md','skills/custom/SKILL.md']}]});
  writeJson(join(source,'manifest.json'),{piVersion:h.runtime.version});
  writeJson(join(source,'components.json'),{upstreams:{fixture:{repo,pinnedRef:base}},skills:{alpha:{type:'override',upstream:'fixture',baseRef:base,localPath:'skills/alpha/SKILL.md',upstreamRelPath:'skills/alpha/SKILL.md'},beta:{type:'override',upstream:'fixture',baseRef:base,localPath:'skills/beta/SKILL.md',upstreamRelPath:'skills/beta/SKILL.md'},custom:{type:'custom',localPath:'skills/custom/SKILL.md'}}});
  writeJson(join(dir,'delivery-case.json'),{source,settlementRecovery});
  await h.pi.runOk(agent,['install',resolve('packages/wardrobe')]);
  const session=await h.pi.rpc(agent,{extraArgs:['-e',resolve('test/support/workflow-delivery-provider.mjs')]});
  try{
    await session.command('delivery-local');
    const before=(await session.request('get_state')).data.model;
    await session.request('prompt',{message:'Update the fixture source and install the verified result. Preserve the custom skill. Installation is authorized.'});
    const log=join(dir,'delivery-requests.jsonl'),deadline=Date.now()+60000;let requests=[];
    while(Date.now()<deadline){
      if(existsSync(log))requests=readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
      if(['INSTALLED','STALLED'].includes(requests.at(-1)?.state.status))break;
      await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(requests.length&&requests.at(-1).name===null,JSON.stringify({count:requests.length,stderr:session.stderr}));
    const store=new NativeStore(dir),profile=Object.values(store.read().profiles)[0];
    assert.ok(profile,JSON.stringify(requests.map(({count,tools,state,name,input})=>({count,tools,status:state.status,name,input}))));
    assert.equal(store.read().default,null);
    const latest=requests.at(-1);assert.equal(latest.state.status,'INSTALLED');
    const loaded=requests.find(r=>r.state.status==='REVIEW_REQUIRED');
    assert.match(loaded.state.skills.shared.body,/wardrobe_workflow/);
    assert.match(loaded.state.skills.preset.body,/LOCAL_DELIVERY_POLICY/,'both layers reach the actual native provider together');
    assert.equal(loaded.state.skills.preset.origin,'preset');
    if(settlementRecovery){
      assert.equal(requests[1].name,null);assert.equal(requests[2].name,null,'two premature settlements occur within one native run');
      assert.equal(requests[3].state.focus.id,'skill:beta');assert.equal(requests[3].input.submission.decisions[0].id,'skill:beta');
      assert.equal(requests[3].state.items.find(item=>item.id==='skill:alpha').status,'blocked');
      const resumed=requests.find(r=>r.input?.action==='focus');assert.equal(resumed.input.item,'skill:alpha');
    }else{
      assert.ok(requests.some(r=>r.state.recovery),'native recovery reaches the provider');
      assert.ok(requests.some(r=>r.messages.some(m=>m.toolName==='read'&&JSON.stringify(m.content).includes('already shown'))),'repeated reads reach the real provider as compact references');
      assert.ok(requests.some(r=>r.messages.some(m=>m.role==='toolResult'&&JSON.stringify(m.content).includes('WORKFLOW_INCOMPLETE'))),'incomplete final verification must reach the real coverage guard');
    }
    assert.ok(requests.filter(r=>r.state.status==='REVIEW_REQUIRED').every(r=>r.tools.includes('read')&&r.tools.includes('edit')),'repair tools remain usable');
    assert.ok(requests.every(r=>!r.input?.handle&&!r.input?.workflow),'the provider never carries workflow coordinates');
    assert.ok(requests.length<=16,JSON.stringify(requests.map(({count,state,input})=>({count,status:state.status,batch:state.batch,recovery:!!state.recovery,action:input?.action||'bash'}))));
    const saves=requests.filter(r=>r.input?.action==='save');assert.equal(saves.length,2);assert.ok(saves.every(r=>r.input.submission.decisions.length===1));
    const finalVerification=requests.findLast(r=>r.input?.action==='verify');assert.deepEqual(finalVerification.input.submission.decisions,[],'final verification consumes the saved ledger');
    console.log('Native workflow metrics: '+JSON.stringify({requests:requests.length,reviewSubmissions:saves.length+1,decisions:2,checkpointCalls:requests.filter(r=>r.input?.action==='checkpoint').length,maxRequestChars:Math.max(...requests.map(r=>JSON.stringify(r.messages).length))}));
    assert.match(readFileSync(profile.selectedSkills.find(p=>p.endsWith('/alpha/SKILL.md')),'utf8'),/new alpha/);
    assert.match(readFileSync(profile.selectedSkills.find(p=>p.endsWith('/custom/SKILL.md')),'utf8'),/Keep our private local method/);
    assert.deepEqual((await session.request('get_state')).data.model,before,'the manager does not switch the native model');
  }finally{await session.close();}
});

test('real Pi accepts native error correction after exhausting investigation continuations',async()=>{
  const h=harness(),agent='failure-recovery',dir=h.sandbox.seedAgent(agent),source=join(h.sandbox.work,'failure-source');
  mkdirSync(join(source,'skills/custom'),{recursive:true});
  writeFileSync(join(source,'skills/custom/SKILL.md'),'---\nname: custom\ndescription: Custom method\n---\nBase method.\n');
  writeJson(join(source,'package.json'),{name:'failure-recovery-case',version:'1.0.0',type:'module',pi:{skills:['skills/custom/SKILL.md']}});
  writeJson(join(source,'preset.json'),{schemaVersion:1,id:'failure/recovery',name:'Failure recovery',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[{package:'self',kind:'skills',include:['skills/custom/SKILL.md']}]});
  writeJson(join(source,'manifest.json'),{piVersion:h.runtime.version});writeJson(join(dir,'delivery-case.json'),{source,failureRecovery:true});
  await h.pi.runOk(agent,['install',resolve('packages/wardrobe')]);
  const session=await h.pi.rpc(agent,{extraArgs:['-e',resolve('test/support/workflow-delivery-provider.mjs')]});
  try{
    await session.command('delivery-local');
    await session.request('prompt',{message:'Maintain the fixture source and install the verified result. Installation is authorized.'});
    const log=join(dir,'delivery-requests.jsonl'),deadline=Date.now()+60000;let requests=[];
    while(Date.now()<deadline){
      if(existsSync(log))requests=readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
      if(requests.at(-1)?.name===null||requests.at(-1)?.state.status==='STALLED')break;
      await new Promise(r=>setTimeout(r,50));
    }
    const debugRoot=requests.at(-1)?.state.workspace?.source&&join(requests.at(-1).state.workspace.source,'../workflow.json'),debugRecord=debugRoot&&JSON.parse(readFileSync(debugRoot,'utf8'));
    assert.equal(requests.at(-1)?.state.status,'INSTALLED',JSON.stringify({requests:requests.map(r=>({count:r.count,status:r.state.status,stopReason:r.state.stopReason,progress:r.state.progress,name:r.name,input:r.input})),recordProgress:debugRecord?.progress,stderr:session.stderr}));
    const failed=requests.find(r=>r.name==='edit'&&r.input.filePath),corrected=requests.find(r=>r.name==='edit'&&r.input.path);
    assert.ok(failed&&corrected&&corrected.count===failed.count+1,'the agent issues a corrected call on the following native turn');
    const error=corrected.messages.find(m=>m.role==='toolResult'&&m.toolName==='edit'&&m.toolCallId==='delivery-'+failed.count);
    assert.ok(error?.isError,'the failed edit reaches the correcting agent turn as an error');
    assert.match(JSON.stringify(error.content),/\bpath\b/,'the edit failure identifies the missing path');
    const profile=Object.values(new NativeStore(dir).read().profiles)[0];
    assert.match(readFileSync(profile.selectedSkills[0],'utf8'),/Corrected method/);
    assert.equal(requests.filter(r=>r.input?.action==='verify').length,1,'decision-free maintenance proceeds directly to final verification');
  }finally{await session.close();}
});

test('real Pi receives the complete runtime review after automatic loading and submits one final review',async()=>{
  const h=harness(),agent='runtime-delivery',dir=h.sandbox.seedAgent(agent),source=join(h.sandbox.work,'runtime-source');mkdirSync(source);
  writeJson(join(source,'package.json'),{name:'runtime-delivery-case',version:'1.0.0',type:'module',pi:{}});
  writeJson(join(source,'preset.json'),{schemaVersion:1,id:'runtime-delivery/demo',name:'Runtime delivery',version:'1.0.0',compatibility:{pi:'>=1.0.4'},packages:{self:{source:'.'}},resources:[]});
  writeJson(join(source,'manifest.json'),{piVersion:'1.0.4'});writeJson(join(dir,'delivery-case.json'),{source,runtimeReview:true});
  await h.pi.runOk(agent,['install',resolve('packages/wardrobe')]);
  const session=await h.pi.rpc(agent,{extraArgs:['-e',resolve('test/support/workflow-delivery-provider.mjs')]});
  try{
    await session.command('delivery-local');
    await session.request('prompt',{message:'Review the runtime update for the fixture source. Preserve behavior.'});
    const log=join(dir,'delivery-requests.jsonl'),deadline=Date.now()+60000;let requests=[];
    while(Date.now()<deadline){
      if(existsSync(log))requests=readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
      if(requests.at(-1)?.name===null)break;
      await new Promise(r=>setTimeout(r,50));
    }
    assert.equal(requests.at(-1)?.state.status,'INSTALLED',JSON.stringify({requests:requests.map(r=>({status:r.state.status,input:r.input})),stderr:session.stderr}));
    assert.equal(requests[1].state.execution,'change-list');
    assert.deepEqual(requests[1].state.requiredDecisions,['runtime-review']);
    assert.match(requests[1].state.completed.last,/Candidate loads/);
    const reviews=requests.filter(r=>r.input?.action==='verify'),saves=requests.filter(r=>r.input?.action==='save');
    assert.equal(reviews.length,1);assert.equal(saves.length,1);assert.equal(requests.length,reviews.length+saves.length+3,'start, partial save, final verification, installation, final receipt');
    assert.equal(saves[0].input.submission.decisions[0].id,'runtime-review');assert.deepEqual(reviews[0].input.submission.decisions,[]);
    assert.ok(reviews.every(r=>r.state.material.notes.every(n=>n.path&&!n.text)),'release evidence is available by original path without injecting the full text');
    assert.ok(requests.every(r=>!r.input?.handle&&!r.input?.workflow));
    const profiles=Object.values(new NativeStore(dir).read().profiles);assert.equal(profiles.length,1,'the program-owned runtime advance creates one inactive revision');
    assert.equal(profiles[0].kind,'derivative');assert.equal(JSON.parse(readFileSync(join(profiles[0].agentDir,'git/127.0.0.1/git/preset/manifest.json'))).piVersion,h.runtime.version);
    console.log('Native runtime review metrics: '+JSON.stringify({requests:requests.length,reviewSubmissions:reviews.length,maxRequestChars:Math.max(...requests.map(r=>JSON.stringify(r.messages).length))}));
  }finally{await session.close();}
});
