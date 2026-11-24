import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { NativeStore } from './native-store.mjs';
import { profileInvocation } from './native-bootstrap.mjs';

/** Real native interactive mode, via the OS PTY, inspected using Pi's own /debug output. */
export async function probeWorkflowUi(profile,{location='composer'}={}){
  if(!['darwin','linux'].includes(process.platform)||!existsSync('/usr/bin/script'))throw Error('Native TUI verification needs the OS script PTY utility');
  const store=new NativeStore(process.env.PI_CODING_AGENT_DIR),config=store.read();
  config.initialized=true;config.profiles[profile.id]=profile;store.save(config);
  const invocation=await profileInvocation(store,profile,{cwd:process.cwd(),args:['--offline','--no-mcp','--no-session','--no-context-files','--approve']});
  const debug=join(profile.agentDir,'pi-debug.log'),args=[invocation.file,...invocation.args.slice(1)];
  const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
  const shell=['/bin/sh','-c','stty cols 160 rows 40; exec "$@"','wardrobe-ui',...args];
  const command=process.platform==='darwin'?['-q','/dev/null',...shell]:['-q','-c',shell.map(quote).join(' '),'/dev/null'];
  let output='',exited=false;
  // Node uses socket pairs for piped stdio on macOS; script needs a POSIX pipe (ENOTTY, not EOPNOTSUPP).
  const child=spawn('/bin/sh',['-c','cat | exec "$@"','wardrobe-pty','/usr/bin/script',...command],{cwd:process.cwd(),env:invocation.env,detached:true,stdio:['pipe','pipe','pipe']});
  child.stdout.on('data',b=>{output=(output+b).slice(-80000);});child.stderr.on('data',b=>{output=(output+b).slice(-80000);});
  child.on('error',e=>{output+=e.message;exited=true;});child.on('exit',()=>{exited=true;});
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const wait=async(predicate)=>{const end=Date.now()+18000;while(!predicate()){if(exited||Date.now()>end)throw Error('Native TUI probe did not become ready: '+stripVTControlCharacters(output).slice(-1600));await pause(40);}};
  const snapshot=async()=>{
    rmSync(debug,{force:true});child.stdin.write('/debug\r');await wait(()=>existsSync(debug));
    const lines=readFileSync(debug,'utf8').split('\n').flatMap(line=>{const match=/^\[\d+\] \(w=\d+\) (.*)$/.exec(line);return match?[stripVTControlCharacters(JSON.parse(match[1]))]:[];});
    const locations=lines.flatMap((line,row)=>line.includes(profile.name)?[{row,text:line}]:[]);
    if(locations.length!==1||location==='statusline'&&locations[0].row<lines.length-4)throw Error('Profile identity must appear once'+(location==='statusline'?' in the statusline':'')+': '+JSON.stringify(locations));
    return {locations,lines};
  };
  try{
    await wait(()=>stripVTControlCharacters(output).includes(profile.name));await pause(500);
    const initial=await snapshot(),startupOutput=output;output='';child.stdin.write('/reload\r');
    await wait(()=>/Reloaded keybindings|Reload failed:/.test(stripVTControlCharacters(output)));await pause(100);const reloaded=await snapshot();
    const diagnostics=stripVTControlCharacters(startupOutput+output).split('\n').filter(line=>/^\s*(?:Warning:|Error:|Failed to load theme|Extension error|Reload failed:)/.test(line));
    if(diagnostics.length)throw Error('Native TUI reported a startup or reload diagnostic: '+diagnostics.slice(-6).join(' | '));
    return {modelRequests:0,initial:{locations:initial.locations,rows:initial.lines.length},reloaded:{locations:reloaded.locations,rows:reloaded.lines.length}};
  }finally{child.stdin.end();try{process.kill(-child.pid,'SIGTERM');}catch{}await pause(100);try{process.kill(-child.pid,'SIGKILL');}catch{}}
}

export function workflowUiCheck(root,profile,{location='composer'}={}){
  const script=join(root,'native-ui.mjs');
  // This probe runs in a disposable Pi directory without device-local values.
  // Keep the staged resources and test their rendering without binding user files.
  const probeProfile={...profile,deviceBindings:[]};
  writeFileSync(script,`import {probeWorkflowUi} from ${JSON.stringify(new URL('./workflow-ui.mjs',import.meta.url).href)};\ntry{console.log(JSON.stringify(await probeWorkflowUi(${JSON.stringify(probeProfile)},${JSON.stringify({location})})));}catch(e){console.error(e.message);process.exitCode=1;}\n`);
  return {command:'node',args:[script],reason:'Native TUI profile identity and reload (zero model requests)'};
}
