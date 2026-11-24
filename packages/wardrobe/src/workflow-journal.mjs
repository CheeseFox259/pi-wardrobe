import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readJson, writeJson } from './native-store.mjs';

function paths(root){
  const directory=join(root,'memory');mkdirSync(directory,{recursive:true,mode:0o700});
  return {journal:join(directory,'journal.jsonl'),snapshot:join(root,'workflow.json')};
}

function eventsFrom(path){
  if(!existsSync(path))return {events:[],diagnostic:null};
  const text=readFileSync(path,'utf8'),lines=text.split('\n'),hasTerminator=text.endsWith('\n');
  if(hasTerminator)lines.pop();
  const events=[];let validBytes=0,diagnostic=null;
  for(let index=0;index<lines.length;index++){
    const line=lines[index];if(!line)continue;
    try{events.push(JSON.parse(line));validBytes+=Buffer.byteLength(line)+(index<lines.length-1||hasTerminator?1:0);}catch(error){
      if(index===lines.length-1){diagnostic={code:'WORKFLOW_JOURNAL_TAIL_TRUNCATED',event:index+1};break;}
      throw Object.assign(new Error(`Workflow journal is corrupt at event ${index+1}`),{code:'WORKFLOW_JOURNAL_CORRUPT',cause:error});
    }
  }
  for(let i=0;i<events.length;i++)if(!Number.isInteger(events[i].seq)||!events[i].opId||!events[i].record||i&&events[i].seq<=events[i-1].seq)
    throw Object.assign(new Error(`Workflow journal sequence is invalid at event ${i+1}`),{code:'WORKFLOW_JOURNAL_CORRUPT'});
  if(diagnostic){truncateSync(path,validBytes);return {events,diagnostic};}
  return {events,diagnostic:null};
}

export function loadWorkflowRecord(root){
  const {journal,snapshot}=paths(root),record=readJson(snapshot);
  if(!record)throw new Error('Workflow record missing');
  const parsed=eventsFrom(journal);let recovered=record;
  for(const event of parsed.events){
    if(event.seq>(recovered.journalSeq||0))recovered=event.record;
  }
  if(parsed.diagnostic){
    recovered={...recovered,recoveryDiagnostics:[...(recovered.recoveryDiagnostics||[]),parsed.diagnostic]};
    return commitWorkflow(recovered,{type:'journal.recovered',payload:parsed.diagnostic});
  }
  if(recovered!==record)writeJson(snapshot,recovered);
  return recovered;
}

export function commitWorkflow(record,{type,opId=randomUUID(),payload={}}={}){
  if(!type)throw new TypeError('Workflow journal event type is required');
  const {journal,snapshot}=paths(record.root),events=eventsFrom(journal).events,duplicate=events.find(event=>event.opId===opId);
  if(duplicate)return duplicate.record;
  const committed={...record,journalSeq:(events.at(-1)?.seq||record.journalSeq||0)+1};
  const prior=existsSync(journal)?readFileSync(journal,'utf8'):'';
  const bytes=Buffer.from((prior&&!prior.endsWith('\n')?'\n':'')+JSON.stringify({seq:committed.journalSeq,opId,type,payload,record:committed})+'\n');
  const fd=openSync(journal,'a',0o600);
  try{let offset=0;while(offset<bytes.length)offset+=writeSync(fd,bytes,offset,bytes.length-offset);fsyncSync(fd);}finally{closeSync(fd);}
  writeJson(snapshot,committed);
  return committed;
}
