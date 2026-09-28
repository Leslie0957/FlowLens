// Adapted from FlowLens M0 probe stream.ts, which was developed after reviewing
// miniClaude commit 0b452360866433fde0dc77cd37ada9d303546592 (MIT).
import { ProbeError } from './model-error.js';

export interface ModelCall { id: string; name: string; arguments: Record<string, unknown> }
export interface Completion { text: string; calls: ModelCall[]; finishReason: 'stop' | 'tool_calls'; usage?: { promptTokens: number; completionTokens: number } }

// Chat Completions SSE. Node fetch supplies byte chunks; TextDecoder and the line buffer
// deliberately avoid assuming that a network chunk is a complete UTF-8 character or event.
export async function decodeChatStream(chunks: AsyncIterable<Uint8Array>, onFirstDelta?: () => void, onTextDelta?:(delta:string)=>void): Promise<Completion> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = ''; let data: string[] = []; let done = false;
  let text = ''; let finish: string | undefined; let reportedFirstDelta = false;
  let usage: Completion['usage'];
  const calls = new Map<number, { id?: string; name?: string; args: string }>();
  function processEvent() {
    if (data.length === 0) return;
    const raw = data.join('\n'); data = [];
    if (raw === '[DONE]') { done = true; return; }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new ProbeError('PROTOCOL_ERROR', 'Invalid stream JSON'); }
    if (!value || typeof value !== 'object') throw new ProbeError('PROTOCOL_ERROR');
    const packet = value as Record<string, unknown>;
    if (packet.usage && typeof packet.usage === 'object') {
      const u = packet.usage as Record<string, unknown>;
      if (typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number') usage = {promptTokens:u.prompt_tokens,completionTokens:u.completion_tokens};
    }
    const choices = packet.choices;
    if (!Array.isArray(choices) || choices.length === 0) return;
    const choice = choices[0] as Record<string, unknown>;
    if (choice.finish_reason != null) finish = String(choice.finish_reason);
    const delta = choice.delta;
    if (!delta || typeof delta !== 'object') return;
    const d = delta as Record<string, unknown>;
    if ((typeof d.content === 'string' && d.content.length > 0) || (Array.isArray(d.tool_calls) && d.tool_calls.length > 0)) {
      if (!reportedFirstDelta) { reportedFirstDelta = true; onFirstDelta?.(); }
    }
    if (typeof d.content === 'string') {text += d.content;onTextDelta?.(d.content);}
    if (!Array.isArray(d.tool_calls)) return;
    for (const item of d.tool_calls) {
      if (!item || typeof item !== 'object') throw new ProbeError('PROTOCOL_ERROR');
      const tc = item as Record<string, unknown>;
      if (!Number.isInteger(tc.index) || (tc.index as number) < 0) throw new ProbeError('PROTOCOL_ERROR');
      const index = tc.index as number;
      const existing = calls.get(index) ?? { args: '' };
      if (tc.id != null) {
        if (typeof tc.id !== 'string' || (existing.id && existing.id !== tc.id)) throw new ProbeError('PROTOCOL_ERROR');
        existing.id = tc.id;
      }
      if (tc.function != null) {
        if (typeof tc.function !== 'object') throw new ProbeError('PROTOCOL_ERROR');
        const fn = tc.function as Record<string, unknown>;
        if (fn.name != null) {
          if (typeof fn.name !== 'string' || (existing.name && existing.name !== fn.name)) throw new ProbeError('PROTOCOL_ERROR');
          existing.name = fn.name;
        }
        if (fn.arguments != null) {
          if (typeof fn.arguments !== 'string') throw new ProbeError('PROTOCOL_ERROR');
          existing.args += fn.arguments;
          if (existing.args.length > 20_480) throw new ProbeError('PROTOCOL_ERROR', 'Tool arguments too large');
        }
      }
      calls.set(index, existing);
    }
  }
  function consumeLines() {
    while (true) {
      const n = pending.indexOf('\n'); if (n < 0) break;
      let line = pending.slice(0,n); pending = pending.slice(n+1);
      if (line.endsWith('\r')) line = line.slice(0,-1);
      if (line === '') { processEvent(); continue; }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0,colon);
      const val = colon < 0 ? '' : line.slice(colon+1).replace(/^ /,'');
      if (field === 'data') data.push(val);
    }
  }
  try {
    for await (const bytes of chunks) {
      if (done && bytes.length) throw new ProbeError('PROTOCOL_ERROR','Bytes after DONE');
      pending += decoder.decode(bytes,{stream:true}); consumeLines();
      if (pending.length > 1_000_000) throw new ProbeError('PROTOCOL_ERROR','SSE line too large');
    }
    pending += decoder.decode(); consumeLines();
  } catch (e) { if (e instanceof ProbeError) throw e; throw new ProbeError('PROTOCOL_ERROR', 'Invalid stream encoding or transport'); }
  if (!done || data.length || pending.trim() || !finish) throw new ProbeError('PROTOCOL_ERROR','Incomplete stream');
  if (finish !== 'stop' && finish !== 'tool_calls') throw new ProbeError('MODEL_INCOMPLETE',`Unexpected finish reason: ${finish}`);
  if (finish === 'tool_calls' && calls.size === 0) throw new ProbeError('PROTOCOL_ERROR');
  if (finish === 'stop' && calls.size) throw new ProbeError('PROTOCOL_ERROR');
  const assembled: ModelCall[] = [];
  for (const [,item] of [...calls].sort(([a],[b])=>a-b)) {
    if (!item.id || !item.name) throw new ProbeError('PROTOCOL_ERROR','Incomplete tool call');
    let args: unknown;
    try { args = JSON.parse(item.args); } catch { throw new ProbeError('PROTOCOL_ERROR','Invalid tool arguments'); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ProbeError('PROTOCOL_ERROR','Tool arguments must be object');
    assembled.push({id:item.id,name:item.name,arguments:args as Record<string,unknown>});
  }
  return { text, calls:assembled, finishReason:finish, ...(usage ? {usage} : {}) };
}
