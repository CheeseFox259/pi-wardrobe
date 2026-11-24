import { appendFileSync, existsSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { currentPiCli } from './native-runtime.mjs';
import { pathToFileURL } from 'node:url';
import { sourceFiles } from './native-snapshot.mjs';

export function isolatedEnvironment(root) {
  for(const name of ['home','agent','sessions','tmp'])mkdirSync(join(root,name),{recursive:true,mode:0o700});
  const inherited=['PATH','LANG','LC_ALL','TZ','TERM','COLORTERM','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','npm_config_cache','npm_config_registry','WARDROBE_REGISTRY'];
  return {...Object.fromEntries(inherited.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]])),
    HOME:join(root,'home'),PI_CODING_AGENT_DIR:join(root,'agent'),PI_CODING_AGENT_SESSION_DIR:join(root,'sessions'),TMPDIR:join(root,'tmp'),PI_TELEMETRY:'0',
    WARDROBE_PI_CLI:currentPiCli(),WARDROBE_REGISTRY:process.env.WARDROBE_REGISTRY||'https://registry.npmjs.org/',
    npm_config_registry:process.env.npm_config_registry||process.env.WARDROBE_REGISTRY||'https://registry.npmjs.org/'};
}

/** Use the installed Pi public resource loader in a child, with no model session. */
export function nativeLoadCheck(root, agentDir) {
  const script=join(root,'native-load.mjs'),core=join(dirname(currentPiCli()),'core');
  writeFileSync(script,[
    `import {DefaultResourceLoader} from ${JSON.stringify(pathToFileURL(join(core,'resource-loader.js')).href)};`,
    `import {SettingsManager} from ${JSON.stringify(pathToFileURL(join(core,'settings-manager.js')).href)};`,
    `import {readFileSync} from 'node:fs';`,
    `import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';`,
    `const agentDir=${JSON.stringify(agentDir)};`,
    `process.env.PI_CODING_AGENT_DIR=agentDir;process.env.WARDROBE_NATIVE_AGENT_DIR=agentDir;process.env.WARDROBE_AGENT_DIR=agentDir;`,
    `const settings=JSON.parse(readFileSync(agentDir+'/settings.json','utf8'));`,
    `const loader=new DefaultResourceLoader({cwd:process.cwd(),agentDir,settingsManager:SettingsManager.inMemory(settings),noContextFiles:true});`,
    `await loader.reload();`,
    `const errors=loader.getExtensions().errors;`,
    `const notifications=[],commands=[],child=spawn(process.execPath,[${JSON.stringify(currentPiCli())},'--mode','rpc','--offline','--no-session','--no-mcp','--no-context-files'],{cwd:process.cwd(),env:{...process.env,PI_CODING_AGENT_DIR:agentDir},stdio:['pipe','pipe','pipe']});`,
    `let stderr='',settled=false;child.stderr.on('data',b=>stderr+=b);`,
    `const finish=(failure)=>{if(settled)return;settled=true;clearTimeout(timer);if(failure)errors.push({message:failure});child.stdin.end();child.kill('SIGTERM');`,
    `const warnings=notifications.filter(n=>['warning','error'].includes(n.level));console.log(JSON.stringify({errors,warnings,commands,extensions:loader.getExtensions().extensions.length,skills:loader.getSkills().skills.length}));process.exit(errors.length||warnings.length?1:0);};`,
    `const timer=setTimeout(()=>finish('Native session_start timed out; '+stderr.slice(-1500)),30000);`,
    `child.on('error',e=>finish(e.message));child.on('exit',code=>{if(!settled)finish('Native startup exited '+code+': '+stderr.slice(-1500));});`,
    `createInterface({input:child.stdout}).on('line',line=>{let r;try{r=JSON.parse(line);}catch{return;}if(r.type==='extension_ui_request'&&r.method==='notify')notifications.push({level:r.notifyType,message:r.message});`,
    `if(r.type==='extension_ui_request'&&['confirm','input','select','editor'].includes(r.method))child.stdin.write(JSON.stringify({type:'extension_ui_response',id:r.id,...(r.method==='confirm'?{confirmed:false}:{cancelled:true})})+'\\n');`,
    `if(r.type==='response'&&r.id==='start'){if(!r.success)return finish(JSON.stringify(r.error));child.stdin.write(JSON.stringify({id:'commands',type:'get_commands'})+'\\n');}`,
    // The deliberately credential-free RPC process can announce that no model is available.
    `if(r.type==='response'&&r.id==='commands'){if(!r.success)return finish(JSON.stringify(r.error));commands.push(...(r.data.commands||r.data).map(c=>c.name));const diagnostic=stderr.split('\\n').filter(line=>line.trim()!=='Warning: No models available. Use /login to log into a provider via OAuth or API key. See:').join('\\n');if(/(?:Warning:|Failed to load|Extension error)/.test(diagnostic))errors.push({message:diagnostic.slice(-2000)});finish();}});`,
    `child.stdin.write(JSON.stringify({id:'start',type:'get_state'})+'\\n');`,
  ].join('\n'));
  return {command:'node',args:[script],reason:'Native resource loading and real session_start diagnostics (zero model requests)'};
}

export function workflowSkillCheck(root,source,base){
  const script=join(root,'workflow-skills.mjs');
  writeFileSync(script,[
    `import {existsSync,readFileSync} from 'node:fs';import {join} from 'node:path';const errors=[];`,
    `const components=existsSync('components.json')?JSON.parse(readFileSync('components.json','utf8')):{};for(const [name,entry] of Object.entries(components.skills||{})){if(!['update','maintain'].includes(entry.workflowRole))continue;const path=entry.localPath||'skills/'+name+'/SKILL.md',p=join(process.cwd(),path),prior=join(${JSON.stringify(base)},path);if(!existsSync(p))continue;const text=readFileSync(p,'utf8');`,
    `if(existsSync(prior)&&text===readFileSync(prior,'utf8'))continue;`,
    `const required=['wardrobe_workflow','READY_TO_INSTALL',...(entry.workflowRole==='update'?['NO_UPDATE']:[])];for(const word of required)if(!text.includes(word))errors.push({code:'WORKFLOW_SKILL_CONTRACT',file:path,missing:word});}`,
    `console.log(JSON.stringify({errors}));process.exit(errors.length?1:0);`,
  ].join('\n'));
  return {command:'node',args:[script],reason:'Changed preset workflow skills follow the public tool contract'};
}

export function validateCheck(check) {
  if (!check || typeof check.command !== 'string' || !Array.isArray(check.args) || check.args.some(a=>typeof a !== 'string') || !check.reason?.trim()) throw new Error('Each affected check requires command, string args and reason');
  if (check.command.includes('/') || check.command.includes('\\') || !['node','npm','git','npx'].includes(check.command)) throw new Error('Use node/npm/git/npx checks without a shell');
  if (check.args.some(a=>/(?:^|\/)(?:setup\.mjs|sync-perfect-pi\.mjs)$/.test(a))) throw new Error('Legacy setup/sync is not a verification check');
  if ((check.command === 'npm' && check.args[0] === 'test' || check.command === 'node' && check.args.includes('--test') && !check.args.some(a=>/\.test\.[cm]?[jt]s$/.test(a))) && !check.broadReason) throw new Error('Select affected tests; broad suites require broadReason');
}

/** New or edited tests are part of the changed behavior, even if omitted by the model. */
export function changedBehaviorChecks(source,base){
  const before=new Map(sourceFiles(base).map(([path,mode,digest])=>[path,mode+':'+digest]));
  const tests=sourceFiles(source).filter(([path,mode,digest])=>/\.test\.[cm]?js$/.test(path)&&before.get(path)!==mode+':'+digest).map(([path])=>path);
  return tests.length?[{command:'node',args:['--test',...tests],reason:'Run newly added or edited behavior tests'}]:[];
}

export async function executeCheck(check, cwd, output, runtime, signal, extraEnv = {}, dependencyRoot = null) {
  signal?.throwIfAborted();
  if(existsSync(runtime))rmSync(runtime,{recursive:true,force:true});
  for(const path of ['home','agent','sessions','tmp'])mkdirSync(join(runtime,path),{recursive:true,mode:0o700});
  if(dependencyRoot)for(const name of ['git','npm']){
    const source=join(dependencyRoot,name);if(existsSync(source))symlinkSync(source,join(runtime,'agent',name),'dir');
  }
  const inherited=['PATH','LANG','LANGUAGE','LC_ALL','LC_CTYPE','TZ','TERM','COLORTERM','NODE_PATH','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','npm_config_cache','npm_config_registry','WARDROBE_REGISTRY'];
  const env={...Object.fromEntries(inherited.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]])),HOME:join(runtime,'home'),PI_CODING_AGENT_DIR:join(runtime,'agent'),PI_CODING_AGENT_SESSION_DIR:join(runtime,'sessions'),TMPDIR:join(runtime,'tmp'),PWD:cwd,INIT_CWD:cwd,PI_TELEMETRY:'0',
    WARDROBE_NATIVE_AGENT_DIR:join(runtime,'agent'),WARDROBE_AGENT_DIR:join(runtime,'agent'),WARDROBE_NATIVE_PROFILE:'',WARDROBE_NATIVE_REVISION_ROOT:'',
    WARDROBE_PI_CLI:currentPiCli(),PI_GLOBAL_NODE_MODULES:dirname(dirname(dirname(dirname(currentPiCli())))),...extraEnv};
  writeFileSync(output,'',{mode:0o600});
  return new Promise(done=>{
    const group=process.platform!=='win32',child=spawn(check.command,check.args,{cwd,env,detached:group,stdio:['ignore','pipe','pipe']});
    let tail='',timedOut=false,cancelled=false,failure,hardKill;
    const kill=signal=>{try{if(group&&child.pid)process.kill(-child.pid,signal);else child.kill(signal);}catch(error){if(error.code!=='ESRCH')failure=error.message;}};
    const stop=()=>{if(hardKill)return;kill('SIGTERM');hardKill=setTimeout(()=>kill('SIGKILL'),2000);hardKill.unref();};
    const cancel=()=>{cancelled=true;stop();};
    const timer=setTimeout(()=>{timedOut=true;stop();},120000);
    const capture=bytes=>{tail=(tail+bytes.toString()).slice(-1800);try{appendFileSync(output,bytes);}catch(error){failure=error.message;stop();}};
    child.stdout.on('data',capture);child.stderr.on('data',capture);child.on('error',error=>{failure=error.message;});
    signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
    child.on('close',code=>{
      if(cancelled||timedOut)kill('SIGKILL');
      clearTimeout(timer);clearTimeout(hardKill);signal?.removeEventListener('abort',cancel);
      done({command:check.command,args:check.args,reason:check.reason,code:failure&&code===0?1:code,timedOut,cancelled,...(failure?{error:failure}:{}),log:output,environment:runtime,tail});
    });
  });
}
