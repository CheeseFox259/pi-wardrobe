import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run=promisify(execFile);

/** Fetch only absent blobs for the named text paths, then produce an exact diff.
 * No whole-tree traversal or implicit fetching of image/lock artifacts. */
export async function gitTextDelta(repo,before,after,paths,env){
  if(!paths.length)return {patch:'',fetchedObjects:0};
  const options={timeout:45000,maxBuffer:8*1024*1024,encoding:'utf8',env:{...env,GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1'}};
  const literal=paths.map(p=>':(literal)'+p);
  const trees=await Promise.all([before,after].map(ref=>run('git',['-C',repo,'ls-tree','-rz',ref,'--',...literal],options)));
  const ids=[...new Set(trees.flatMap(({stdout})=>stdout.split('\0').map(row=>/^(?:100644|100755) blob ([a-f0-9]+)\t/.exec(row)?.[1]).filter(Boolean)))];
  const missing=await new Promise((resolve,reject)=>{
    const child=spawn('git',['-C',repo,'cat-file','--batch-check=%(objectname) %(objecttype)'],{env:options.env,stdio:['pipe','pipe','pipe']});
    let output='',error='';const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
    child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b);
    const fail=error=>{clearTimeout(timer);child.kill();reject(error);};
    child.on('error',fail);child.on('close',code=>{clearTimeout(timer);if(code!==0)reject(Error(error||'Git object probe failed'));else resolve(output.split('\n').filter(row=>row.endsWith(' missing')).map(row=>row.split(' ')[0]));});
    child.stdin.on('error',fail);child.stdin.end(ids.join('\n')+'\n');
  });
  if(missing.length)await run('git',['-C',repo,'-c','fetch.negotiationAlgorithm=noop','fetch','--no-tags','--no-write-fetch-head','origin',...missing],options);
  const {stdout}=await run('git',['-C',repo,'diff','--no-ext-diff','--no-textconv','--no-renames','--unified=3',before,after,'--',...literal],options);
  return {patch:stdout,fetchedObjects:missing.length};
}
