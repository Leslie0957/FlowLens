import {randomUUID} from 'node:crypto';
const safeId=/^[A-Za-z0-9_-]{8,80}$/;
export function requestId(input?:unknown):string{return typeof input==='string'&&safeId.test(input)?input:randomUUID();}
const fields=['request_id','run_id','session_id','turn_id','tool_call_id','event_id','seq','provider_mode','model','prompt_version','model_request','usage','validation_fields','route','method','status','duration_ms','error_code','scenario_id'] as const;
export function createLogger(sink:(line:string)=>void=(line)=>process.stderr.write(line+'\n')){
  return (event:string,input:Record<string,unknown>={},level:'info'|'warn'|'error'='info')=>{
    const item:Record<string,unknown>={timestamp:new Date().toISOString(),level,module:'server',event:event.slice(0,64),outcome:level==='info'?'ok':'failure'};
    for(const field of fields){const value=input[field];if(typeof value==='number'&&Number.isFinite(value))item[field]=value;else if(typeof value==='string')item[field]=value.slice(0,120).replace(/[\r\n\t]/g,' ');}
    try{sink(JSON.stringify(item));}catch{/* diagnostics must not replace the request result */}
  };
}
