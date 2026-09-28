import {expect,it,vi} from 'vitest';
import {consumeEventStream,readAgentEvents} from './agent-stream.js';
it('reports an open idle channel before any diagnostic event',async()=>{
 const opened=vi.fn();vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(': connected\n\n',{headers:{'Content-Type':'text/event-stream'}})));
 try{await readAgentEvents('session',0,vi.fn(),new AbortController().signal,opened);expect(opened).toHaveBeenCalledOnce();}finally{vi.unstubAllGlobals();}
});
it('retains HTTP failure and request ID for stream diagnostics',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('',{status:502,headers:{'X-Request-Id':'trace_stream_502'}})));
 try{await expect(readAgentEvents('session',0,vi.fn(),new AbortController().signal)).rejects.toThrow('HTTP 502 · trace_stream_502');}finally{vi.unstubAllGlobals();}
});
it('parses split UTF-8 and SSE lines without duplicating an event',async()=>{
 const value={schema_version:1,event_id:'ev1',seq:1,session_id:'ses1',turn_id:'turn1',timestamp:'2026-09-26T00:00:00Z',type:'message.delta',payload:{message_id:'msg1',delta:'中文'}};
 const bytes=new TextEncoder().encode('id: 1\nevent: message.delta\ndata: '+JSON.stringify(value)+'\n\n');
 const stream=new ReadableStream<Uint8Array>({start(controller){for(const byte of bytes)controller.enqueue(Uint8Array.of(byte));controller.close();}});
 const received:unknown[]=[];await consumeEventStream(stream,item=>received.push(item));expect(received).toEqual([value]);
});
