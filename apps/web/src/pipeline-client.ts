import {ref,watch,onUnmounted,type Ref} from 'vue';
import {z} from 'zod';
import {pipelineSnapshotSchema,pipelineEventSchema,type PipelineSnapshot} from '@flowlens/contracts';
import {consumeJsonEvents} from './agent-stream';
export async function pipelineRead<T extends z.ZodType>(path:string,schema:T,options:RequestInit={}){const response=await fetch('/api/v1/pipeline'+path,{...options,headers:{'Content-Type':'application/json',...options.headers}});const body=await response.json();if(!response.ok)throw new Error((body.error?.message??'请求失败')+' · '+(body.error?.request_id??response.status));return schema.parse(body.data);}
export const projectPath=(id:string)=>'/projects/'+encodeURIComponent(id);
// Retain a mutation key across uncertain responses and reloads, scoped to its body.
export function mutationKey(scope:string,body:unknown){const name='flowlens.pipeline.'+scope+':'+JSON.stringify(body);let key=sessionStorage.getItem(name);if(!key){key=crypto.randomUUID();sessionStorage.setItem(name,key);}return {key,done:()=>sessionStorage.removeItem(name)};}
export function usePipelineSnapshot(projectId:Ref<string>){
 const snapshot=ref<PipelineSnapshot|null>(null),error=ref(''),connection=ref('连接中');let generation=0,controller:AbortController|null=null,flight:Promise<void>|null=null,again=false,cursor=0;
 async function refresh(){if(flight){again=true;return flight;}const gen=generation,id=projectId.value,signal=controller?.signal;
  flight=(async()=>{try{const s=await pipelineRead(projectPath(id),pipelineSnapshotSchema,{signal});if(gen!==generation||signal?.aborted)return;snapshot.value=s;cursor=Math.max(cursor,s.cursor);error.value='';}catch(e){if(gen===generation&&!signal?.aborted)error.value=e instanceof Error?e.message:'同步失败';}})();
  const current=flight;await current;if(gen!==generation)return;if(flight===current)flight=null;if(again){again=false;await refresh();}
 }
 watch(projectId,async id=>{generation++;const gen=generation;controller?.abort();controller=new AbortController();const signal=controller.signal;snapshot.value=null;error.value='';flight=null;again=false;cursor=0;await refresh();
  while(gen===generation&&!signal.aborted){try{connection.value='连接中';const response=await fetch('/api/v1/pipeline'+projectPath(id)+'/events?after_seq='+cursor,{signal,headers:{Accept:'text/event-stream'}});if(!response.ok||!response.body)throw new Error('事件流不可用');connection.value='实时连接';await consumeJsonEvents(response.body,raw=>{const e=pipelineEventSchema.parse(raw);if(gen!==generation||signal.aborted||e.project_id!==id||e.seq<=cursor)return;if(e.seq!==cursor+1){void refresh();return;}cursor=e.seq;void refresh();},signal);}catch{if(!signal.aborted&&gen===generation)connection.value='断线，正在恢复';}
   if(!signal.aborted&&gen===generation){await new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};const timer=setTimeout(finish,1000);signal.addEventListener('abort',finish,{once:true});});await refresh();}
  }
 },{immediate:true});
 onUnmounted(()=>{generation++;controller?.abort();});return {snapshot,error,connection,refresh};
}
