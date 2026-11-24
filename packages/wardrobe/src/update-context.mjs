import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { captureSource } from './discover.mjs';
import { satisfies } from './semver.mjs';
import { readJson, writeJson } from './native-store.mjs';
import { gitTextDelta } from './git-delta.mjs';
import { prepareRuntimeReviews } from './runtime-review.mjs';

const run=promisify(execFile);
const document=(root,pattern)=>existsSync(root)?readdirSync(root,{withFileTypes:true}).find(e=>e.isFile()&&pattern.test(e.name))?.name:null;

function interval(content,before,after){
  const sections=content.split(/(?=^##\s)/m);
  const selected=sections.filter(section=>{
    const version=/^##\s+\[?v?(\d+\.\d+\.\d+)(?:\]|\s|$)/.exec(section)?.[1];
    return version&&satisfies('>'+before+' <='+after,version)===true;
  });
  return selected.length?selected.join(''):null;
}

/** Prepare authoritative notes outside the editable source. No model calls or
 * install scripts. Exact-version package documents are cached across updates. */
export async function prepareUpdateContext(plan,{root,piRoot,docsCache,env,profile,notesTimeoutMs=15000}){
  if(plan.status==='NO_UPDATE')return;
  const folder=join(root,'inputs','release-notes');mkdirSync(folder,{recursive:true,mode:0o700});
  plan.releaseNotes=[];
  if(plan.runtime){
    const runtime=plan.runtime;
    runtime.changelog=['CHANGELOG.md','docs/CHANGELOG.md'].map(p=>join(piRoot,p)).find(existsSync)||null;
    runtime.api=join(piRoot,'dist/core/extensions/types.d.ts');
    const notes={id:'runtime',kind:'published-changelog',before:runtime.before,after:runtime.installed,source:runtime.changelog};
    const content=runtime.changelog&&interval(readFileSync(runtime.changelog,'utf8'),runtime.before,runtime.installed);
    if(content){notes.path=join(folder,'pi.md');notes.status='READY';writeFileSync(notes.path,`# Pi ${runtime.before} → ${runtime.installed}\n\nSource: ${runtime.changelog}\n\n`+content);}
    else{notes.status='UNAVAILABLE';notes.reason=runtime.changelog?'No matching version sections; inspect the supplied source.':'Installed Pi does not include a changelog.';}
    runtime.notes=notes;plan.releaseNotes.push(notes);
    runtime.reviews=prepareRuntimeReviews(runtime,join(folder,'runtime'));
  }
  const ranges=new Map(plan.repositories.filter(r=>r.target!==r.previous).map(r=>[[r.repo,r.previous,r.target].join('\0'),r]));
  await Promise.all([...ranges.values()].map(async r=>{
    const key=createHash('sha256').update([r.repo,r.previous,r.target].join('\0')).digest('hex').slice(0,16),notes={id:'upstream:'+r.repo,kind:'commit-log-and-path-delta',before:r.previous,after:r.target,source:r.repo};
    try{
      if(!r.previous||!r.cache)throw Error('Exact previous ref/cache unavailable');
      const range=r.previous+'..'+r.target,options={timeout:15000,maxBuffer:4*1024*1024,encoding:'utf8',env:{...env,GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'}};
      const [log,diff]=await Promise.all([run('git',['-C',r.cache,'log','--format=%h %as %s',range],options),run('git',['-C',r.cache,'diff','--no-renames','--name-status',r.previous,r.target],options)]);
      notes.path=join(folder,key+'.md');notes.status='READY';
      writeFileSync(notes.path,`# ${r.repo}\n\nExact range: ${range}\n\nThese are upstream commit subjects and changed paths, not a published release summary. Use the prepared base/upstream files for content decisions.\n\n## Commits\n\n${log.stdout}\n## Changed paths\n\n${diff.stdout}`);
      const capabilities=plan.capabilities?.filter(c=>c.repo===r.repo&&c.target===r.target&&['official-update','source-update','new-skills'].includes(c.kind))||[];
      if(capabilities.length){
        const names=await run('git',['-C',r.cache,'diff','--no-renames','--name-only','-z',r.previous,r.target],options);
        const paths=names.stdout.split('\0').filter(p=>/\.(?:md|[cm]?[jt]sx?|json|ya?ml|sh|py|toml)$/.test(p)&&!/(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(p));
        const selected=paths.filter(p=>capabilities.some(c=>c.kind!=='new-skills'||c.paths.some(entry=>p.startsWith(entry.slice(0,entry.lastIndexOf('/')+1)))));
        if(selected.length){
          try{
            const delta=await gitTextDelta(r.cache,r.previous,r.target,selected,env);
            notes.delta=join(folder,key+'.patch');writeFileSync(notes.delta,delta.patch);notes.deltaStatus='READY';
            plan.metrics.contextFetchedObjects=(plan.metrics.contextFetchedObjects||0)+delta.fetchedObjects;
            for(const capability of capabilities)capability.inputs={patch:notes.delta,paths:selected};
          }catch(error){notes.deltaStatus='UNAVAILABLE';notes.deltaReason=error.message;}
        }
      }
    }catch(error){notes.status='UNAVAILABLE';notes.reason=error.message;}
    plan.releaseNotes.push(notes);
  }));
  await Promise.all(plan.packages.filter(p=>p.changed).map(async p=>{
    const source='npm:'+p.name+'@'+p.latest;
    const repo=(typeof p.repository==='string'?p.repository:p.repository?.url)?.replace(/^git\+/,'').replace(/\.git$/,'');
    const registry=new URL(env.WARDROBE_REGISTRY.endsWith('/')?env.WARDROBE_REGISTRY:env.WARDROBE_REGISTRY+'/').href;
    const key=createHash('sha256').update([registry,source,p.integrity||''].join('\0')).digest('hex'),cache=join(docsCache,key),record=join(cache,'documents.json');
    const notes={id:'package:'+p.name,kind:'published-package-documents',before:p.installed,after:p.latest,source,channels:{metadata:new URL(p.name.replaceAll('/','%2f')+'/'+p.latest,registry).href,...(/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repo||'')?{repository:repo,releases:repo+'/releases'}:{})}};
    try{
      let documents=readJson(record);
      if(!documents){
        const signal=AbortSignal.timeout(notesTimeoutMs);
        const captured=await captureSource(source,{workDir:join(cache,'capture'),env,registry,fetchImpl:(url,options={})=>fetch(url,{...options,signal:options.signal?AbortSignal.any([signal,options.signal]):signal})});
        documents={root:captured.root,changelog:document(captured.root,/^(?:changelog|changes|history)(?:\.md|\.txt)?$/i),readme:document(captured.root,/^readme(?:\.md|\.txt)?$/i)};
        writeJson(record,documents);
      }
      notes.path=join(folder,'package-'+key.slice(0,16)+'.md');
      const changelog=documents.changelog&&join(documents.root,documents.changelog),readme=documents.readme&&join(documents.root,documents.readme);
      const content=changelog&&readFileSync(changelog,'utf8'),selected=content&&interval(content,p.installed,p.latest);
      notes.status=changelog?'READY':'NO_PUBLISHED_CHANGELOG';
      writeFileSync(notes.path,`# ${p.name} ${p.installed} → ${p.latest}\n\nSource: ${source}\n\n`+(changelog?`Changelog: ${changelog}\n\n${selected||'Version headings could not be matched. Read the supplied changelog; do not assume every entry is new.'}\n`:'No changelog is shipped in the target package. Use README differences or the upstream release channel; do not invent release notes.\n')+(readme?`\nTarget README: ${readme}\n`:'')+(repo?`\nUpstream repository: ${repo}\n`:'')+(profile&&document(join(profile.agentDir,'npm/node_modules',p.name),/^readme(?:\.md|\.txt)?$/i)?`\nInstalled baseline README: ${join(profile.agentDir,'npm/node_modules',p.name,document(join(profile.agentDir,'npm/node_modules',p.name),/^readme(?:\.md|\.txt)?$/i))}\n`:''));
    }catch(error){notes.status='UNAVAILABLE';notes.reason=error.message;}
    plan.releaseNotes.push(notes);
  }));
  plan.releaseNotes.sort((a,b)=>a.id.localeCompare(b.id));
}
