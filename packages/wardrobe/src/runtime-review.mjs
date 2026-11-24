/** Keep the authoritative version interval as one review; the model chooses ranges to read. */
export function prepareRuntimeReviews(runtime){
  return [{id:'runtime-review',title:'Pi release changes',status:runtime.notes?.path?'READY':'UNAVAILABLE',
    path:runtime.notes?.path,reason:runtime.notes?.reason,source:runtime.changelog}];
}
