#!/usr/bin/env node
// Serve an explicit working-tree snapshot without committing or publishing it.
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const workspace=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const additions=['presets/perfect-pi','scripts','examples','packages/wardrobe/src/agent-files.mjs','test/agent-files.test.mjs','test/nested-package.test.mjs','test/perfect-pi.test.mjs','test/perfect-pi-entry.test.mjs','test/pinned-install.test.mjs','test/skill-precedence.test.mjs','test/write-interop.test.mjs','docs/usage.zh-CN.md','docs/perfect-pi-migration-evidence.md','docs/adr/0005-complete-presets-with-reviewed-agent-files.md'];
export async function serveLocalSource({port=0,outputDir,workspaceDir=workspace}={}) {
 const sourceWorkspace=resolve(workspaceDir);
 const base=outputDir?resolve(outputDir):tmpdir();mkdirSync(base,{recursive:true});
 const snapshot=mkdtempSync(join(base,'wardrobe-source-')),work=join(snapshot,'work'),web=join(snapshot,'web');
 let server;
 try {
 mkdirSync(work);mkdirSync(join(web,'git'),{recursive:true});
 const tracked=execFileSync('git',['ls-files','-z'],{cwd:sourceWorkspace}).toString().split('\0').filter(Boolean);
 const paths=new Set([...tracked,...additions]);
 for(const path of paths)if(existsSync(join(sourceWorkspace,path)))cpSync(join(sourceWorkspace,path),join(work,path),{recursive:true});
 const git=(args,cwd=work)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git(['init','-b','main']);git(['config','user.name','Wardrobe Local Snapshot']);git(['config','user.email','local-snapshot@example.invalid']);git(['config','commit.gpgsign','false']);git(['add','--force','.']);git(['commit','-m','Local working-tree snapshot for isolated Wardrobe installation']);
 const commit=git(['rev-parse','HEAD']);const bare=join(web,'git/pi-wardrobe.git');git(['clone','--bare',work,bare]);git(['update-server-info'],bare);
 server=createServer((request,response)=>{
  try {
   const path=resolve(web,'.'+decodeURIComponent(new URL(request.url,'http://localhost').pathname));
   if(!path.startsWith(web+sep)||!statSync(path).isFile()){response.writeHead(404).end();return;}
   createReadStream(path).pipe(response);
  }catch{response.writeHead(404).end();}
 });
 await new Promise((done,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',done);});
 const source=`git:http://127.0.0.1:${server.address().port}/git/pi-wardrobe.git@${commit}`;
 return {source,commit,snapshot,server};
 } catch(error) {
  if(server?.listening)await new Promise(done=>server.close(done));
  rmSync(snapshot,{recursive:true,force:true});
  throw error;
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const args=process.argv.slice(2),value=flag=>args[args.indexOf(flag)+1];
 if(args.includes('--help'))console.log('Usage: node scripts/serve-local-source.mjs [--port 8765] [--output-dir <directory>]\nServes a fixed working-tree snapshot on loopback. Keep running during discovery/install. Ctrl-C stops the server; snapshot is retained for review.');
 else {const result=await serveLocalSource({port:args.includes('--port')?Number(value('--port')):8765,outputDir:args.includes('--output-dir')?value('--output-dir'):undefined});console.log(JSON.stringify({source:result.source,commit:result.commit,snapshot:result.snapshot},null,2));for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>result.server.close(()=>process.exit(0)));}
}
