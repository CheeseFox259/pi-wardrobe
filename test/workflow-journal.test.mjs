import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { useHarness } from './support/harness.mjs';
import { commitWorkflow, loadWorkflowRecord } from '../packages/wardrobe/src/workflow-journal.mjs';

const harness=useHarness('workflow-journal');

test('workflow journal recovers a durable event written before its snapshot and deduplicates operation ids',()=>{
  const h=harness(),root=join(h.sandbox.work,'workflow');mkdirSync(root,{recursive:true});
  const initial={root,status:'REVIEW_REQUIRED',revision:0};
  commitWorkflow(initial,{type:'prepared',opId:'prepare-1'});
  const changed={...initial,status:'STALLED',revision:1,reason:'No delivery progress'};
  const journal=join(root,'memory/journal.jsonl');
  const event={seq:2,opId:'stop-1',type:'item.stalled',payload:{itemId:'runtime'},record:{...changed,journalSeq:2}};
  appendFileSync(journal,JSON.stringify(event)+'\n');
  const recovered=loadWorkflowRecord(root);
  assert.equal(recovered.status,'STALLED');
  assert.equal(recovered.journalSeq,2);
  const duplicate=commitWorkflow({...changed,reason:'incorrect duplicate'}, {type:'item.stalled',opId:'stop-1'});
  assert.equal(duplicate.reason,'No delivery progress');
  assert.equal(readFileSync(journal,'utf8').trim().split('\n').length,2);
  assert.equal(existsSync(join(root,'workflow.json')),true);
});

test('workflow journal keeps a complete newline-free tail and ignores only a malformed crash tail',()=>{
  const h=harness(),root=join(h.sandbox.work,'journal-tail');mkdirSync(root,{recursive:true});
  const first={root,status:'REVIEW_REQUIRED',revision:0};commitWorkflow(first,{type:'prepared',opId:'tail-prepare'});
  const path=join(root,'memory/journal.jsonl'),record={...first,status:'STALLED',journalSeq:2};
  appendFileSync(path,JSON.stringify({seq:2,opId:'tail-stall',type:'stalled',payload:{},record}));
  assert.equal(loadWorkflowRecord(root).status,'STALLED');
  appendFileSync(path,'\n{"seq":3,"opId":');
  assert.equal(loadWorkflowRecord(root).status,'STALLED');
});
