import type {ModelGateway} from './model-gateway.js';
import {validSql} from './pipeline-data.js';

// Deterministic fixture policy, not a measure of LIVE reasoning quality.
// Choices inspect actual returned data rather than template names or positions.
export function pipelineMock(): ModelGateway {
  return {async complete(messages) {
    const initial = JSON.parse(String(messages.find(m => m.role === 'user')!.content));
    const results = new Map(messages.filter(m => m.role === 'tool').map(m => {
      const call = messages.filter(a => a.role === 'assistant').flatMap(a =>
        (a.tool_calls ?? []) as {id:string;function:{name:string}}[]
      ).find(c => c.id === m.tool_call_id)!;
      return [call.function.name, JSON.parse(String(m.content))];
    }));
    const call = (names: string[]) => ({text: '', finishReason: 'tool_calls' as const,
      calls: names.map(name => ({id: 'mock-' + name, name, arguments: {}}))});
    if (!results.has('get_sql')) return call(['get_sql']);
    const sql = results.get('get_sql').output;
    const output = results.get('get_output_preview')?.output;
    if (!output && /vehicle_type/.test(sql.sql)) return call(['get_output_preview']);
    if (output && !results.has('get_task_contract')) return call(['get_task_contract']);
    if (!output && !results.has('get_schema')) return call(['get_schema']);
    return {text: JSON.stringify({
      diagnosis: 'MOCK 离线演示：根据上一轮实际资料选择后续取证，提出候选；正确性仍需独立验证。',
      failed_step: initial.failure.failed_step,
      action: 'SQL_PATCH',
      evidence_ids: [initial.failure.evidence_id, ...[...results.values()].flatMap(r => r.evidence_ids)],
      candidate: {file_path: 'task.sql', base_hash: sql.base_hash, new_content: validSql}
    }), finishReason: 'stop', calls: []};
  }};
}
