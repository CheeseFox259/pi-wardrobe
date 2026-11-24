// Local provider: repeat exploration until recovery, reject premature verify,
// then focus and save individual decisions before final verification.
// This tests the native tool path, not model intelligence or provider costs.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export default function deliveryProvider(pi){
  const folder=process.env.PI_CODING_AGENT_DIR;
  const model={provider:'wardrobe-delivery-local',api:'anthropic-messages',id:'delivery',name:'Local delivery fixture',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:4000};
  let count=0,triedInvalid=false;
  const streamSimple=(selected,context)=>{
    count++;
    let state={};
    for(const message of context.messages||[])for(const part of Array.isArray(message.content)?message.content:[]){
      if(part.type!=='text')continue;
      const text=part.text;
      try{
        const parsed=JSON.parse(text.includes('state):\n')||text.startsWith('Wardrobe state delta:\n')?text.slice(text.indexOf('\n')+1):text);
        if(parsed.status)state={...state,...parsed};
      }catch{}
    }
    const system=context.messages.find(m=>m.role==='system');
    const tools=(system?.toolsAdded||[]).map(t=>t.name);
    const config=JSON.parse(readFileSync(join(folder,'delivery-case.json'),'utf8'));
    let input,name='wardrobe_workflow';
    if(count===1)input=config.failureRecovery?{action:'maintain',source:config.source,request:'Correct the custom method and install the verified result.'}:{action:'update',source:config.source};
    else if(config.settlementRecovery&&count<=3)name=null;
    else if(config.failureRecovery&&count<19){name='read';input={path:join(state.workspace.source,'preset.json')};}
    else if(config.failureRecovery&&count===19){name='edit';input={filePath:join(state.workspace.source,'skills/custom/SKILL.md'),edits:[{oldText:'Base method.',newText:'Corrected method.'}]};}
    else if(config.failureRecovery&&count===20){name='edit';input={path:join(state.workspace.source,'skills/custom/SKILL.md'),edits:[{oldText:'Base method.',newText:'Corrected method.'}]};}
    else if(['INSTALLED','REVIEWED','NO_UPDATE','STALLED'].includes(state.status)||count>28)name=null;
    else if(state.nextCall?.action==='install')input={...state.nextCall,approved:true};
    else if(!state.recovery&&!config.runtimeReview&&!config.settlementRecovery&&!state.saved){name='read';input={path:join(state.workspace.source,'preset.json')};}
    else if(!triedInvalid&&!config.runtimeReview&&!config.settlementRecovery){triedInvalid=true;input={action:'verify',submission:{summary:'Invalid first submission',decisions:[],checks:[]}};}
    else if(state.nextCall?.action==='focus')input={...state.nextCall,item:state.items.find(item=>!['decided','blocked'].includes(item.status))?.id||state.items[0]?.id};
    else if(state.nextCall?.action==='save'){
      const saved=new Set((state.saved?.decisions||[]).map(decision=>decision.id)),id=state.nextCall.submission.decisions.find(decision=>!saved.has(decision.id))?.id||state.requiredDecisions.find(id=>!saved.has(id));
      input={...state.nextCall,submission:{summary:'Save one reviewed decision',decisions:[{id,action:'adopt',reason:'This isolated fixture method has no conflicting local adaptations.'}],checks:[],...(config.settlementRecovery?{resolvedBlockers:state.items.filter(item=>item.id===state.focus?.id&&item.status==='blocked').map(item=>item.id)}:{})}};
    }
    else if(state.nextCall?.action==='verify')input={...state.nextCall,submission:{summary:'Verify the saved review',decisions:[],checks:[]}};
    else name=null;
    appendFileSync(join(folder,'delivery-requests.jsonl'),JSON.stringify({count,tools,state,name,input,messages:context.messages})+'\n');
    const message={role:'assistant',api:model.api,provider:selected.provider,model:selected.id,timestamp:Date.now(),content:name?[{type:'toolCall',id:'delivery-'+count,name,arguments:input}]:[{type:'text',text:'Local fixture stopped.'}],stopReason:name?'toolUse':'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    return {[Symbol.asyncIterator]:async function*(){yield {type:'start',partial:{...message,content:[]}};yield {type:'done',reason:message.stopReason,message};},result:async()=>message};
  };
  pi.registerCommand('delivery-local',{handler:async()=>{
    pi.registerProvider(model.provider,{api:model.api,baseUrl:'http://127.0.0.1/never-used',apiKey:'fixture-no-network',models:[model],streamSimple});
    await pi.setModel(model);
  }});
}
