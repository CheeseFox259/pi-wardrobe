import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import pty from 'node-pty';
import { runCommand } from '../packages/wardrobe/src/commands.mjs';
import { reconcileSelection } from '../packages/wardrobe/src/probe.mjs';
import { RpcSession } from '../fixtures/lib/pi-runner.mjs';
import { launchEnv, useHarness } from './support/harness.mjs';

const harness = useHarness('skill-precedence');
const skill = description => `---\nname: precedence-check\ndescription: ${description}\n---\nUse this skill.\n`;

test('a skill with the same path suffix outside its approved package is missing', () => {
  const plan={resourceSelectors:[{package:'self',kind:'skills',loaded:['skills/check/SKILL.md']}]};
  const result=reconcileSelection({plan,resourceRoots:{self:'/approved/package'},commands:[{name:'skill:precedence-check',source:'skill',sourceInfo:{path:'/personal/skills/check/SKILL.md'}}]});
  assert.equal(result.missing.length,1);
});

test('managed launch uses the approved skill when a personal skill has the same name', async t => {
  const h = harness(), env = launchEnv(h);
  const repo = await h.gitRepo('skill-precedence', [{message:'approved skill', files:{
    'package.json':JSON.stringify({name:'skill-precedence',version:'1.0.0',pi:{skills:['skills/check/SKILL.md']}}),
    'skills/check/SKILL.md':skill('Approved preset version'),
    'preset.json':JSON.stringify({schemaVersion:1,id:'skill-precedence',name:'Skill precedence',version:'1.0.0',compatibility:{pi:h.runtime.version},packages:{self:{source:'.'}},resources:[{package:'self',kind:'skills',include:['skills/check/SKILL.md']}]}),
  }}]);
  const request=`install ${repo.sourceAt(repo.commits[0])}`;
  const reviewed=await runCommand(request,{env});
  assert.equal(reviewed.ok,true,JSON.stringify(reviewed.result));
  const installed=await runCommand(`${request} --confirm ${reviewed.result.plan.digest}`,{env});
  assert.equal(installed.ok,true,JSON.stringify(installed.result));
  const personal=join(h.sandbox.home,'.agents/skills/check/SKILL.md');
  mkdirSync(join(personal,'..'),{recursive:true});
  const original=skill('Personal version'); writeFileSync(personal,original);
  const extra=join(h.sandbox.home,'.agents/skills/personal-extra/SKILL.md');
  mkdirSync(join(extra,'..'),{recursive:true});
  writeFileSync(extra,'---\nname: personal-extra\ndescription: Keep this unrelated personal skill\n---\nExtra skill.\n');
  const child=h.sandbox.runner.fork(process.execPath,[resolve('packages/wardrobe/bin/wardrobe.mjs'),'run',installed.result.staging.revision,'--agent-dir',h.agentPath('primary'),'--','--mode','rpc','--offline','--no-session'],{cwd:h.sandbox.project,env});
  const session=new RpcSession(child,h.sandbox.runner,{agentName:'precedence',agentDir:installed.result.staging.agentDir,eventsLog:h.sandbox.extensionLog});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  const response=await session.request('get_commands');
  const command=response.data.commands.find(row=>row.name==='skill:precedence-check');
  assert.ok(command,session.stderr);
  assert.equal(command.description,'Approved preset version',JSON.stringify(command));
  assert.ok(command.sourceInfo.path.startsWith(installed.result.staging.agentDir),JSON.stringify(command));
  assert.ok(response.data.commands.some(row=>row.name==='skill:personal-extra'),'non-conflicting personal skills stay available');
  assert.equal((await session.close()).code,0,session.stderr);
  assert.equal(readFileSync(personal,'utf8'),original);
  const term=pty.spawn(process.execPath,[resolve('packages/wardrobe/bin/wardrobe.mjs'),'run',installed.result.staging.revision,'--agent-dir',h.agentPath('primary'),'--','--offline','--no-session'],{cwd:h.sandbox.project,env,cols:140,rows:35});
  t.after(()=>{try{term.kill();}catch{}});
  let output='';
  const exited=new Promise(done=>term.onExit(done));
  await new Promise((done,reject)=>{
    const timer=setTimeout(()=>reject(new Error('TUI did not become ready: '+output.slice(-2000))),20000);
    term.onData(chunk=>{output+=chunk;if(output.includes('No models available')){clearTimeout(timer);done();}});
  });
  assert.doesNotMatch(output,/Skill conflicts/,'the daily TUI must not repeat resolved skill collisions');
  term.kill('SIGTERM'); await exited;
  const disabled=h.sandbox.runner.fork(process.execPath,[resolve('packages/wardrobe/bin/wardrobe.mjs'),'run',installed.result.staging.revision,'--agent-dir',h.agentPath('primary'),'--','--mode','rpc','--offline','--no-session','--no-skills'],{cwd:h.sandbox.project,env});
  const disabledSession=new RpcSession(disabled,h.sandbox.runner,{agentName:'disabled-skills',agentDir:installed.result.staging.agentDir,eventsLog:h.sandbox.extensionLog});
  t.after(()=>{if(disabled.exitCode===null)disabled.kill('SIGKILL');});
  assert.ok(!(await disabledSession.commandNames()).some(name=>name.startsWith('skill:')),'an explicit native --no-skills flag stays effective');
  assert.equal((await disabledSession.close()).code,0,disabledSession.stderr);
});
