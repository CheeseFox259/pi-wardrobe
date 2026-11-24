import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { workflowContextFor } from '../packages/wardrobe/src/workflow-context.mjs';

function scenario(t){
  const root=mkdtempSync(join(tmpdir(),'wardrobe-delivery-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'source'));mkdirSync(join(root,'base'));
  const handlers=new Map(),entries=[],pi={on:(name,handler)=>handlers.set(name,handler),appendEntry:(name,data)=>entries.push({name,data})};
  const scope=workflowContextFor(pi,{root});
  const state={protocolVersion:3,status:'REVIEW_REQUIRED',handle:'current',revision:0,workspace:{root,source:join(root,'source')},batch:{id:'runtime'},requiredDecisions:['runtime'],nextCall:{action:'verify',handle:'current',submission:{summary:'',decisions:[{id:'runtime',reason:''}],checks:[]}}};
  const system={role:'system',sections:{rules:'Keep user customizations.'},toolsAdded:['read','bash','edit','write','wardrobe_workflow'].map(name=>({name}))};
  const user={role:'user',timestamp:1,content:'Start update once, review changes, and submit each item.'};
  const start={role:'assistant',timestamp:2,content:[{type:'toolCall',id:'start',name:'wardrobe_workflow',arguments:{action:'update'}}]};
  const started={role:'toolResult',toolCallId:'start',toolName:'wardrobe_workflow',content:[{type:'text',text:JSON.stringify(state)}]};
  scope.accept(state);
  return {root,handlers,scope,state,entries,messages:[system,user,start,started]};
}

test('the next provider view retains the actual start call so update is visibly already executed',t=>{
  const s=scenario(t),view=s.handlers.get('context_with_system')({messages:s.messages});
  assert.ok(view.messages.some(m=>m.role==='assistant'&&m.content.some(c=>c.type==='toolCall'&&c.id==='start')),'the executed start call must survive the first active projection');
  assert.ok(view.messages.some(m=>m.role==='toolResult'&&m.toolCallId==='start'));
});

test('tool-result recovery keeps the focused execution contract in the authoritative snapshot',t=>{
  const s=scenario(t);s.scope.accept({...s.state,execution:'change-list',focus:{id:'alpha',requiredDecisions:['skill:alpha']},items:[{id:'alpha',title:'Alpha',required:['skill:alpha'],files:[],status:'in_progress'}],nextCall:{action:'save'}});
  const view=s.handlers.get('context_with_system')({messages:s.messages}),frame=view.messages.find(m=>m.role==='user'&&m.content?.[0]?.text?.startsWith('Current Wardrobe work item'));
  const state=JSON.parse(frame.content[0].text.split('\n').slice(1).join('\n'));
  assert.equal(state.execution,'change-list');assert.equal(state.focus.id,'alpha');assert.equal(state.items[0].status,'in_progress');assert.equal(state.nextCall.action,'save');
});

test('large reads cannot silently reset the current item before a durable checkpoint',t=>{
  const s=scenario(t);s.handlers.get('context_with_system')({messages:s.messages});const before=s.entries.filter(e=>e.name==='wardrobe.epoch').length;
  const messages=[...s.messages];
  for(let i=0;i<3;i++)messages.push({role:'assistant',timestamp:3+i,content:[{type:'toolCall',id:'read-'+i,name:'bash',arguments:{command:'cat candidate.md'}}]},
    {role:'toolResult',toolName:'bash',toolCallId:'read-'+i,content:[{type:'text',text:'EVIDENCE_'+i+' '+'.'.repeat(11000)}]});
  const view=s.handlers.get('context_with_system')({messages});
  assert.ok(view.messages.some(m=>m.role==='toolResult'&&m.toolCallId==='read-0'),'threshold must request a checkpoint instead of discarding unsubmitted investigation');
  assert.equal(s.entries.filter(e=>e.name==='wardrobe.epoch').length,before);
});

test('recovery preserves repair tools without inventing decisions or changing the tool schema',async t=>{
  const s=scenario(t);s.scope.accept({...s.state,progress:{assistantTurns:8,recoveryIssuedAt:8}});
  const view=s.handlers.get('context_with_system')({messages:s.messages});
  assert.deepEqual(view.messages.find(m=>m.role==='system').toolsAdded.map(t=>t.name),['read','bash','edit','write','wardrobe_workflow']);
  const blocked=await s.handlers.get('tool_call')({toolName:'bash',input:{command:'ls source'}},{cwd:s.root});
  assert.equal(blocked,undefined);
  assert.equal(await s.handlers.get('tool_call')({toolName:'wardrobe_workflow',input:{action:'verify',handle:'current'}},{cwd:s.root}),undefined);
});

test('update and maintain retain native file discovery alongside candidate repair and verification',async t=>{
  for(const kind of ['update','maintain']){
    const s=scenario(t);s.scope.accept({...s.state,kind});
    const view=s.handlers.get('context_with_system')({messages:s.messages});
    const system=view.messages.find(m=>m.role==='system');
    assert.deepEqual(system.toolsAdded.map(tool=>tool.name),['read','bash','edit','write','wardrobe_workflow']);
    assert.match(system.sections.wardrobe,/Find files/);
    const blocked=await s.handlers.get('tool_call')({toolName:'bash',input:{command:'find . -type f'}},{cwd:s.root});
    assert.equal(blocked,undefined,'directory discovery must have a working native tool');
    assert.equal(await s.handlers.get('tool_call')({toolName:'wardrobe_workflow',input:{action:'verify'}},{cwd:s.root}),undefined);
  }
});

test('details for the active profile stays attached to the candidate while another profile remains queryable',async t=>{
  const s=scenario(t);s.scope.accept({...s.state,profile:{id:'local/demo'}});
  assert.equal((await s.scope.bind({action:'details',profile:'local/demo'},{})).handle,'current');
  assert.equal((await s.scope.bind({action:'details',profile:'other/demo'},{})).handle,undefined);
});

test('same-item model history and state deltas remain an unchanged prefix between requests',t=>{
  const s=scenario(t),first=s.handlers.get('context_with_system')({messages:s.messages});
  const added=[{role:'assistant',timestamp:3,content:[{type:'toolCall',id:'new',name:'bash',arguments:{command:'pwd'}}]},{role:'toolResult',toolName:'bash',toolCallId:'new',content:[{type:'text',text:'Candidate working directory'}]}];
  const second=s.handlers.get('context_with_system')({messages:[...s.messages,...added]});
  assert.deepEqual(second.messages.slice(0,first.messages.length),first.messages);
  assert.deepEqual(s.handlers.get('context_with_system')({messages:[...s.messages,...added]}),second,'an unchanged native context must not append duplicate frames');
});

test('model result projection preserves instructions and accepted memory across repeated projection',async()=>{
  const {workflowView}=await import('../packages/wardrobe/src/workflow-view.mjs');
  for(const status of ['NORMALIZED','APPROVAL_REQUIRED','CHECK_FAILED','IMPORTED']){
    const original={status,next:'Continue the action-specific next step.'};
    assert.deepEqual(workflowView(original),original);
  }
  const result={status:'REVIEW_REQUIRED',completed:[{summary:'Preserved custom behavior'}],workspace:{root:'/private',source:'/candidate'},nextCall:{action:'verify',handle:'private'},context:{pi:{version:'1'},verification:{}}};
  assert.deepEqual(workflowView(workflowView(result)),workflowView(result));
});

test('changing native branches or starting a no-update task releases the old candidate binding',async t=>{
  const s=scenario(t);
  s.handlers.get('agent_settled')();
  s.scope.accept({status:'NO_UPDATE',workspace:{root:'/new',source:'/new/source'}});
  assert.equal((await s.scope.bind({action:'install'},{})).handle,undefined);
  s.scope.accept(s.state);
  s.handlers.get('session_tree')();
  assert.equal((await s.scope.bind({action:'install'},{sessionManager:{getBranch:()=>[]}})).handle,undefined);
});

test('document review exposes its patch and local constraints with on-demand shared references',async()=>{
  const {workflowView}=await import('../packages/wardrobe/src/workflow-view.mjs');
  const result={status:'REVIEW_REQUIRED',kind:'update',requiredDecisions:['skill:review'],decisions:[{path:'skills/review/SKILL.md',preservedFeatures:['Keep local review rule'],review:{upstream:'/inputs/upstream'}}],packages:[],capabilities:[],resolvedResources:[{kind:'extensions',path:'unrelated.mjs'}],material:{declaration:{path:'/candidate/preset.json',text:'FULL_DECLARATION'},localOwners:{unrelated:{localPath:'unrelated.mjs'}},incoming:[{path:'skills/review/SKILL.md',upstream:{path:'/inputs/patch',text:'CURRENT_PATCH'}}],notes:[{id:'repo',source:'https://example.invalid/repo',excerpt:{path:'/notes/full',text:'WHOLE_REPOSITORY_NOTES'},delta:{path:'/notes/delta',text:'REPOSITORY_DELTA'}}]}};
  const view=workflowView(result),text=JSON.stringify(view);
  assert.match(text,/CURRENT_PATCH|Keep local review rule/);
  assert.ok(text.includes('CURRENT_PATCH')&&text.includes('Keep local review rule'));
  for(const path of ['/candidate/preset.json','/inputs/upstream','/notes/full','/notes/delta'])assert.ok(text.includes(path),path);
  assert.doesNotMatch(text,/FULL_DECLARATION|WHOLE_REPOSITORY_NOTES|REPOSITORY_DELTA|unrelated.mjs/);
  assert.deepEqual(workflowView(view),view,'provider projection preserves reference paths');
  const code={...result,decisions:[{path:'extensions/change.mjs'}]};
  assert.match(JSON.stringify(workflowView(code)),/FULL_DECLARATION|WHOLE_REPOSITORY_NOTES/);
});
