import {agentEventSchema} from '@flowlens/contracts';

export async function consumeEventStream(body:ReadableStream<Uint8Array>,onEvent:(event:ReturnType<typeof agentEventSchema.parse>)=>void,signal?:AbortSignal){
 const reader=body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let pending='',data:string[]=[];
 const line=(value:string)=>{if(value.endsWith('\r'))value=value.slice(0,-1);if(!value){if(data.length){const item=agentEventSchema.parse(JSON.parse(data.join('\n')));onEvent(item);data=[];}return;}if(value.startsWith(':'))return;const colon=value.indexOf(':');const name=colon<0?value:value.slice(0,colon);const content=colon<0?'':value.slice(colon+1).replace(/^ /,'');if(name==='data')data.push(content);};
 const drain=()=>{let index:number;while((index=pending.indexOf('\n'))>=0){line(pending.slice(0,index));pending=pending.slice(index+1);}};
 try{while(true){if(signal?.aborted)break;const item=await reader.read();if(item.done)break;pending+=decoder.decode(item.value,{stream:true});if(pending.length>1024*1024)throw new Error('SSE_EVENT_TOO_LARGE');drain();}pending+=decoder.decode();drain();if(pending.trim())line(pending);}
 finally{reader.releaseLock();}
}
export async function readAgentEvents(sessionId:string,after:number,onEvent:(event:ReturnType<typeof agentEventSchema.parse>)=>void,signal:AbortSignal,onOpen?:()=>void){
 const response=await fetch('/api/v1/sessions/'+encodeURIComponent(sessionId)+'/events?after_seq='+after,{headers:{Accept:'text/event-stream'},signal});
 if(!response.ok||!response.body)throw new Error('本机消息通道请求失败：HTTP '+response.status+' · '+(response.headers.get('X-Request-Id')??'无关联 ID'));
 if(!response.headers.get('Content-Type')?.includes('text/event-stream'))throw new Error('本机消息通道返回了非事件流响应');
 onOpen?.();
 await consumeEventStream(response.body,onEvent,signal);
}
