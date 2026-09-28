import {z} from 'zod';
import {ProbeError} from './model-error.js';
export type ToolDescription={name:string;description:string;parameters:Record<string,unknown>};
export type ToolContext={runId:string;sessionId:string;turnId:string};
export type ToolValue={output:Record<string,unknown>;evidence_ids:string[]};
type Registration={description:ToolDescription;schema:z.ZodType;execute:(input:Record<string,unknown>,context:ToolContext)=>Promise<ToolValue>};
// Registrations are trusted server code; no HTTP/model-controlled registration.
export class ToolRegistry {
 private readonly entries=new Map<string,Registration>();
 register(entry:Registration){if(this.entries.has(entry.description.name))throw new ProbeError('DUPLICATE_TOOL');this.entries.set(entry.description.name,entry);return this;}
 describe(){return [...this.entries.values()].map(entry=>entry.description);}
 async call(name:string,raw:Record<string,unknown>,context:ToolContext){
  const entry=this.entries.get(name);if(!entry)throw new ProbeError('TOOL_NOT_ALLOWED');
  const input=entry.schema.safeParse(raw);if(!input.success)throw new ProbeError('INVALID_ARGUMENTS');
  const result=await entry.execute(input.data as Record<string,unknown>,context);
  if(Buffer.byteLength(JSON.stringify(result.output))>20*1024)throw new ProbeError('TOOL_OUTPUT_LIMIT');
  return result;
 }
}
