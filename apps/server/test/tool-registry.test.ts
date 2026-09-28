import {expect,it} from 'vitest';
import {z} from 'zod';
import {ToolRegistry} from '../src/tool-registry.js';
it('registration provides description and validated execution without extra authority fields',async()=>{
 const registry=new ToolRegistry();let calls=0;
 registry.register({description:{name:'read_summary',description:'Read synthetic summary',parameters:{type:'object'}},schema:z.strictObject({run_id:z.string()}),execute:async(input,ctx)=>{calls++;expect(input.run_id).toBe(ctx.runId);return {output:{status:'SUCCEEDED'},evidence_ids:[]};}});
 expect(registry.describe().map(x=>x.name)).toEqual(['read_summary']);
 const ctx={runId:'fixture',sessionId:'session',turnId:'turn'};
 await expect(registry.call('shell',{},ctx)).rejects.toMatchObject({code:'TOOL_NOT_ALLOWED'});
 await expect(registry.call('read_summary',{run_id:'fixture',approved:true},ctx)).rejects.toMatchObject({code:'INVALID_ARGUMENTS'});
 expect(calls).toBe(0);expect((await registry.call('read_summary',{run_id:'fixture'},ctx)).output).toEqual({status:'SUCCEEDED'});expect(calls).toBe(1);
});
