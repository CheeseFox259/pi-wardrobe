import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { captureSource } from './discover.mjs';
import { registryPath, resolveNpmPackage } from './npm-source.mjs';
import { readJson, writeJson } from './native-store.mjs';
import { currentPiCli } from './native-runtime.mjs';
import { workflowContract } from './workflow-contract.mjs';
import { agentFileContract } from './agent-files.mjs';

/** Official npm discovery/documents only; selection and adaptation stay with Pi. */
export async function lookupResource(store,source,env,{timeoutMs=15000,query}={}){
  if(typeof source!=='string'||!source.trim()||source.length>200)throw Error('lookup requires a package keyword or exact npm source');
  if(source==='wardrobe:contract')return {status:'PUBLIC_INTERFACE',contract:workflowContract};
  if(source==='wardrobe:agent-files')return {status:'PUBLIC_INTERFACE',contract:agentFileContract()};
  if(source.startsWith('pi:')){
    const symbol=source.slice(3);if(!/^[A-Za-z_][\w.]{1,80}$/.test(symbol))throw Error('Use pi:<public symbol>');
    const file=join(dirname(currentPiCli()),'core/extensions/types.d.ts'),lines=readFileSync(file,'utf8').split('\n'),matches=[];
    for(let i=0;i<lines.length;i++)if(lines[i].includes(symbol))matches.push({line:i+1,text:lines.slice(Math.max(0,i-3),i+12).join('\n')});
    return {status:'PUBLIC_INTERFACE',symbol,file,matches:matches.slice(0,8),next:'Read a specific range only if these public declarations are insufficient.'};
  }
  const registry=new URL(env.WARDROBE_REGISTRY.endsWith('/')?env.WARDROBE_REGISTRY:env.WARDROBE_REGISTRY+'/').href;
  const signal=AbortSignal.timeout(timeoutMs),fetchImpl=(url,options={})=>fetch(url,{...options,signal});
  if(!source.startsWith('npm:')){
    const url=new URL('-/v1/search',registry);url.searchParams.set('text',source);url.searchParams.set('size','5');
    const response=await fetchImpl(url);if(!response.ok)throw Error('npm search '+response.status);
    const results=(await response.json()).objects?.map(({package:p})=>({name:p.name,version:p.version,description:p.description,links:p.links}))||[];
    return {status:'RESOURCE_CANDIDATES',source:url.href,results,next:'Select by requested capability, then lookup source npm:<name>@<exact-version> for official package documents.'};
  }
  const match=/^npm:(.+)@(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)$/.exec(source);
  if(!match){
    const name=source.slice(4);
    if(!/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name))throw Error('Use npm:<package-name> or an exact npm:<name>@<version> source');
    const response=await fetchImpl(registry+registryPath(name));if(!response.ok)throw Error('npm metadata '+response.status);
    const packument=await response.json(),latestVersion=packument['dist-tags']?.latest,latest=packument.versions?.[latestVersion];
    if(!latest||!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(latestVersion||''))
      return {status:'NEEDS_VERSION',source,package:{name,latestVersion:latestVersion||null},availableVersions:Object.keys(packument.versions||{}).slice(-10),next:'Choose an exact published version, then call lookup with npm:<name>@<version>.'};
    const nextCall={action:'lookup',source:`npm:${name}@${latestVersion}`,...(query?{request:query}:{})};
    return {status:'NEEDS_VERSION',source,package:{name,latestVersion,description:latest.description||''},nextCall,next:'The registry latest tag resolves to this exact version; inspect its official documents with nextCall before adopting it.'};
  }
  const meta=await resolveNpmPackage({name:match[1],version:match[2],registry,fetchImpl});
  const key=createHash('sha256').update([registry,source,meta.integrity].join('\0')).digest('hex'),cache=join(store.root,'resource-documents',key),record=join(cache,'documents.json');
  let documents=readJson(record);
  if(documents?.status==='RESOURCE_UNAVAILABLE'&&Date.now()-documents.unavailableAt>120000)documents=null;
  if(!documents){
    try{
      const captured=await captureSource(source,{workDir:join(cache,'capture'),env,registry,fetchImpl}),pkg=readJson(join(captured.root,'package.json'));
      documents={root:captured.root,source,integrity:captured.integrity,pi:pkg.pi,repository:pkg.repository,documents:readdirSync(captured.root,{withFileTypes:true}).filter(e=>e.isFile()&&/^(?:readme|changelog|changes|history)(?:\.md|\.txt)?$/i.test(e.name)).map(e=>join(captured.root,e.name))};
    }catch(error){
      documents={status:'RESOURCE_UNAVAILABLE',source,reason:error.message,unavailableAt:Date.now(),channels:{metadata:new URL(match[1].replaceAll('/','%2f')+'/'+match[2],registry).href,repository:meta.repository},next:'Use the published repository/release channel or report the missing documents; do not repeat the same download immediately. Download retry becomes available after 2 minutes.'};
    }
    writeJson(record,documents);
  }
  if(documents.status==='RESOURCE_UNAVAILABLE')return documents;
  const words=(query||'').toLowerCase().split(/\W+/).filter(w=>w.length>3),excerpts=[];
  for(const file of documents.documents||[]){
    const lines=readFileSync(file,'utf8').split('\n');
    if(words.length){const hits=[];for(let i=0;i<lines.length;i++)if(words.some(w=>lines[i].toLowerCase().includes(w)))hits.push({line:i+1,text:lines.slice(Math.max(0,i-2),i+7).join('\n')});excerpts.push({file,matches:hits.slice(0,6)});}
    else excerpts.push({file,text:lines.join('\n').slice(0,4500)});
  }
  return {status:'RESOURCE_DOCUMENTS',...documents,excerpts,next:'Use matching public docs and pi exports. For a focused excerpt, repeat lookup with request as the topic. Pin any selected new dependency in preset packages; adopted existing package pins are compiled automatically.'};
}
