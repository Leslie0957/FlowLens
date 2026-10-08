import type { ModelGateway } from './model-gateway.js';
import { validSql } from './pipeline-data.js';

// Deterministic fixture policy, not a measure of LIVE reasoning quality.
// Choices inspect actual returned data rather than template names or positions.
export function pipelineMock(): ModelGateway {
  return {
    async complete(messages) {
      const initial = JSON.parse(String(messages.find((m) => m.role === 'user')!.content));
      const results = new Map(
        messages
          .filter((m) => m.role === 'tool')
          .map((m) => {
            const call = messages
              .filter((a) => a.role === 'assistant')
              .flatMap((a) => (a.tool_calls ?? []) as { id: string; function: { name: string } }[])
              .find((c) => c.id === m.tool_call_id)!;
            return [call.function.name, JSON.parse(String(m.content))];
          }),
      );
      const call = (names: string[], question: string, reason: string) => ({
        text: JSON.stringify({
          investigation: {
            question,
            reason,
            evidence_ids: results.size
              ? [...results.values()].flatMap((r) => r.evidence_ids)
              : [initial.failure.evidence_id],
          },
        }),
        finishReason: 'tool_calls' as const,
        calls: names.map((name) => ({ id: 'mock-' + name, name, arguments: {} })),
      });
      if (!results.has('get_sql'))
        return call(
          ['get_sql'],
          '实际 SQL 中哪些表达式与失败有关？',
          '初始失败给出了报错，还需要绑定版本的完整源码定位问题。',
        );
      const sql = results.get('get_sql').output;
      const output = results.get('get_output_preview')?.output;
      if (!output && /vehicle_type/.test(sql.sql))
        return call(
          ['get_output_preview'],
          '这个输出别名是否导致实际字段缺失？',
          '上一轮源码出现输出别名，需要查看本次真实输出及校验结果。',
        );
      if (output && !results.has('get_task_contract'))
        return call(
          ['get_task_contract'],
          '实际输出与要求的字段有什么差异？',
          '上一轮确认输出校验失败，需要读取任务约定确定修复范围。',
        );
      if (!output && !results.has('get_schema'))
        return call(
          ['get_schema'],
          '源码中的字段是否存在于实际源表？',
          '上一轮获得报错 SQL，需要实际表结构核对字段。',
        );
      return {
        text: JSON.stringify({
          diagnosis:
            'MOCK 离线演示：根据上一轮实际资料选择后续取证，提出候选；正确性仍需独立验证。',
          failed_step: initial.failure.failed_step,
          action: 'SQL_PATCH',
          evidence_ids: [
            initial.failure.evidence_id,
            ...[...results.values()].flatMap((r) => r.evidence_ids),
          ],
          candidate: { file_path: 'task.sql', base_hash: sql.base_hash, new_content: validSql },
        }),
        finishReason: 'stop',
        calls: [],
      };
    },
  };
}
