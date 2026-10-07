import {it,expect,vi,afterEach} from 'vitest';
import {createApp,defineComponent,ref,nextTick} from 'vue';
import {usePipelineSnapshot,mutationKey} from './pipeline-client';
const a='10000000-0000-4000-8000-000000000001',b='10000000-0000-4000-8000-000000000002',rid='10000000-0000-4000-8000-000000000003',hash='a'.repeat(64);
const snapshot=(id:string,cursor=0)=>({project:{id,name:id,template:'A',input_source:'SYNTHETIC',input_hash:hash,current_revision_id:rid,created_at:'now'},revision:{id:rid,project_id:id,parent_id:null,sql:'SELECT',hash,input_hash:hash,source:'TEMPLATE',created_at:'now'},revisions:[],executions:[],repairs:[],batches:[],operations:[],target:{data_version:0,head_batch_id:null,hash,row_count:0,preview:[]},cursor});
afterEach(()=>{vi.unstubAllGlobals();sessionStorage.clear();});
it('ignores a late project snapshot and error after selection changes, including loading cleanup',async()=>{
 let resolveOld!:(value:Response)=>void;let resolveError!:(value:Response)=>void;const old=new Promise<Response>(r=>resolveOld=r),lateError=new Promise<Response>(r=>resolveError=r);let callsA=0;
 vi.stubGlobal('fetch',vi.fn((url:string,options:RequestInit={})=>{if(url.includes('/events?'))return new Promise<Response>(resolve=>{const stream=new ReadableStream({start(c){options.signal?.addEventListener('abort',()=>c.close(),{once:true});}});resolve(new Response(stream));});if(url.endsWith(a))return callsA++===0?old:lateError;return Promise.resolve(new Response(JSON.stringify({data:snapshot(b)}),{headers:{'Content-Type':'application/json'}}));}));
 const project=ref(a);let state!:ReturnType<typeof usePipelineSnapshot>;const app=createApp(defineComponent({setup(){state=usePipelineSnapshot(project);return ()=>null;}}));app.mount(document.createElement('div'));
 project.value=b;await vi.waitFor(()=>expect(state.snapshot.value?.project.id).toBe(b));resolveOld(new Response(JSON.stringify({data:snapshot(a)})));await nextTick();expect(state.snapshot.value?.project.id).toBe(b);expect(state.error.value).toBe('');resolveError(new Response(JSON.stringify({error:{message:'old error'}}),{status:500}));app.unmount();
});
it('deduplicates replay, refreshes gaps, and maintains a project scoped event cursor',async()=>{
 let stream!:ReadableStreamDefaultController<Uint8Array>,cursor=0,reads=0;const id=ref(a);
 vi.stubGlobal('fetch',vi.fn((url:string,options:RequestInit={})=>{if(url.includes('/events?'))return Promise.resolve(new Response(new ReadableStream({start(c){stream=c;options.signal?.addEventListener('abort',()=>c.close(),{once:true});}})));reads++;return Promise.resolve(new Response(JSON.stringify({data:snapshot(a,cursor)})));}));
 let state!:ReturnType<typeof usePipelineSnapshot>;const app=createApp(defineComponent({setup(){state=usePipelineSnapshot(id);return ()=>null;}}));app.mount(document.createElement('div'));await vi.waitFor(()=>expect(state.connection.value).toBe('实时连接'));
 const emit=(seq:number,project=a)=>stream.enqueue(new TextEncoder().encode('data: '+JSON.stringify({project_id:project,seq,type:'execution.changed',entity_id:rid,created_at:'now'})+'\n\n'));
 cursor=1;emit(1);await vi.waitFor(()=>expect(state.snapshot.value?.cursor).toBe(1));const count=reads;emit(1);emit(1,b);await nextTick();expect(reads).toBe(count);
 cursor=4;emit(4);await vi.waitFor(()=>expect(state.snapshot.value?.cursor).toBe(4));expect(reads).toBeGreaterThan(count);app.unmount();
});
it('retains mutation keys for uncertain responses, separates bodies/projects and renews only after confirmed responses',()=>{const first=mutationKey(a+'/executions',{});expect(mutationKey(a+'/executions',{}).key).toBe(first.key);expect(mutationKey(b+'/executions',{}).key).not.toBe(first.key);expect(mutationKey(a+'/revisions',{sql:'one'}).key).not.toBe(mutationKey(a+'/revisions',{sql:'two'}).key);first.done();expect(mutationKey(a+'/executions',{}).key).not.toBe(first.key);});
