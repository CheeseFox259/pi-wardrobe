import { combineWork } from './workflow-packet.mjs';

/** One editable review, with independently addressable evidence and decisions. */
export function changeList(batches,plan){
  const pending=batches.filter(b=>!b.runtimeBaseline&&b.status!=='verified');
  const ranges=pending.flatMap(b=>b.runtimeReviews||[]),items=pending.filter(b=>!b.runtimeReviews?.length);
  if(ranges.length)items.unshift({id:'runtime-review',title:'Pi release changes',required:['runtime-review'],files:[],runtimeReviews:[{id:'runtime-review',status:ranges.every(r=>r.status==='READY')?'READY':'UNAVAILABLE',path:plan.runtime.notes?.path,source:plan.runtime.changelog}],runtime:plan.runtime});
  if(!items.length)return [];
  return [{...combineWork(items),id:'review',title:'Review and integrate preset changes',status:'pending',runtimeReviews:items.flatMap(b=>b.runtimeReviews||[]),items:items.map(({id,title,required,files,repo})=>({id,title,required,files,repo}))}];
}

/** Saving a draft never claims acceptance or runs installation checks. */
export function mergeReview(saved={},incoming={}){
  const merge=(key,id)=>{
    const values=new Map();
    for(const value of [...(saved[key]||[]),...(incoming[key]||[])])values.set(id(value),value);
    return [...values.values()];
  };
  return {summary:incoming.summary||saved.summary||'',decisions:merge('decisions',d=>d.id),
    resources:merge('resources',r=>JSON.stringify([['enable','disable','retire'].includes(r.action)?'visibility':r.action,r.package,r.kind,r.path,r.oldPath])),migrations:merge('migrations',m=>JSON.stringify(m.from)),
    checks:merge('checks',c=>JSON.stringify([c.command,c.args])),obligations:merge('obligations',o=>JSON.stringify([o.type,o.location,o.contains])),
    work:[...new Map([...(saved.work||[]),...(incoming.work||[])].map(w=>[w.id,{...(saved.work||[]).find(prior=>prior.id===w.id),...w}])).values()]};
}
