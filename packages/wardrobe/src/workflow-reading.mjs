import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/** A read projection owns only ranges still present in this provider context.
 * Native session results are untouched. Recreate it after an epoch/compaction. */
export function readingView(){
  const calls=new Map(),shown=new Map();
  return {
    project(message,cwd){
      if(message.role==='assistant'){
        for(const part of message.content||[])if(part.type==='toolCall')calls.set(part.id,part);
        return message;
      }
      if(message.role!=='toolResult'||message.toolName!=='read'||message.isError)return message;
      const input=calls.get(message.toolCallId)?.arguments;
      if(!input?.path||message.content?.length!==1||message.content[0].type!=='text')return message;
      let path,bytes;
      try{path=realpathSync(resolve(cwd,input.path));bytes=readFileSync(path);}catch{return message;}
      if(bytes.includes(0))return message;
      const file=bytes.toString('utf8').split('\n'),start=(input.offset||1)-1;
      if(!Number.isInteger(start)||start<0)return message;
      // A file may have changed after the native read. Never replace or suppress
      // evidence unless the result matches the current version at this offset.
      const body=message.content[0].text.replace(/\n\n\[(?:Showing lines \d+-\d+ of \d+(?: \([^\n]* limit\))?\. |\d+ more lines in file\. )Use offset=\d+ to continue\.\]$/u,'');
      const received=body.split('\n');
      if(received.at(-1)==='')received.pop();
      const count=received.length;
      if(!count||received.some((line,index)=>line!==file[start+index]))return message;
      const key=createHash('sha256').update(bytes).digest('hex');
      if(!shown.has(key))shown.set(key,new Map());
      const seen=shown.get(key),parts=[],prior=new Set();let used=0,at=start,range=[];
      const flush=()=>{if(range.length){parts.push(`[${path}: lines ${range[0]+1}–${range.at(-1)+1}]\n`+range.map(i=>file[i]).join('\n'));range=[];}};
      for(;at<start+count;at++){
        if(seen.has(at)){flush();prior.add(seen.get(at));continue;}
        // Keep a long single line intact; native read already limits its size.
        if(used&&used+file[at].length+1>8000)break;
        seen.set(at,message.toolCallId);range.push(at);used+=file[at].length+1;
      }
      flush();
      if(prior.size)parts.push('['+path+': overlapping lines already shown in earlier read results: '+[...prior].join(', ')+'. Use that evidence to decide or edit; rereading adds no evidence.]');
      const lineCount=file.length-(file.at(-1)===''?1:0);
      if(at<lineCount)parts.push('[Read a needed range from the original file: '+JSON.stringify({path,offset:at+1,limit:80})+'.]');
      return {...message,content:[{type:'text',text:parts.join('\n\n')}]};
    },
  };
}
