import type { PipelineExecution, PipelineRepair } from '@flowlens/contracts';

export function repairRelation(repair: PipelineRepair, execution?: PipelineExecution) {
  if (!execution || repair.project_id !== execution.project_id) return null;
  if (repair.execution_id === execution.id) return 'FAILURE' as const;
  if (repair.approved_revision_id !== execution.revision_id) return null;
  if (execution.kind === 'CANDIDATE_CHECK' && repair.verification_execution_id === execution.id)
    return 'CANDIDATE_CHECK' as const;
  if (execution.kind === 'VERIFICATION' && repair.verification_execution_id === execution.id)
    return 'VERIFICATION' as const;
  if (execution.kind === 'PRECHECK' && repair.commit_approval?.execution_id === execution.id)
    return 'PRECHECK' as const;
  return null;
}

type ModelTurn = PipelineRepair['model_turns'][number];
type Tool = PipelineRepair['tools'][number];
export interface InvestigationRound {
  request: number | null;
  turn?: ModelTurn;
  tools: Tool[];
  label: string;
  state: string;
  explanation: string | null;
}

function publicExplanation(turn?: ModelTurn) {
  if (!turn?.calls.length || turn.investigation) return null;
  const text = turn.text.trim();
  // Display actual public assistant prose. Unsupported structured notes and
  // textual tool protocol remain raw records, never presented as valid notes.
  if (!text || /^[{[]/.test(text) || text.startsWith('```') || text.includes('DSML')) return null;
  return text;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'undefined';
}

export function repeatedReadRequests(repair: PipelineRepair) {
  const seen = new Map<string, number>(),
    repeated = new Map<string, number>();
  for (const tool of repair.tools) {
    if (
      tool.status !== 'COMPLETED' ||
      !tool.result ||
      typeof tool.result !== 'object' ||
      !('output' in tool.result)
    )
      continue;
    const output = tool.result.output as Record<string, unknown>;
    const signatures =
      tool.name === 'get_logs' && Array.isArray(output.logs)
        ? output.logs.length
          ? output.logs.map((log) => canonical({ name: tool.name, log }))
          : ['get_logs:empty']
        : [canonical({ name: tool.name, args: tool.args, output })];
    const previous = signatures.map((key) => seen.get(key));
    if (previous.every((request) => request !== undefined))
      repeated.set(tool.id, Math.max(...(previous as number[])));
    else if (tool.request !== undefined)
      for (const key of signatures) if (!seen.has(key)) seen.set(key, tool.request);
  }
  return repeated;
}

export function investigationRounds(repair: PipelineRepair): InvestigationRound[] {
  const groups = new Map<number | null, InvestigationRound>();
  const group = (request: number | null) => {
    if (!groups.has(request))
      groups.set(request, { request, tools: [], label: '', state: '', explanation: null });
    return groups.get(request)!;
  };
  for (const turn of repair.model_turns) group(turn.request).turn = turn;
  for (const tool of repair.tools) group(tool.request ?? null).tools.push(tool);
  if (repair.status === 'RUNNING' && repair.model_requests) group(repair.model_requests);
  for (const round of groups.values()) {
    round.explanation = publicExplanation(round.turn);
    round.label =
      round.request === null ? '历史工具记录 · 轮次未记录' : '第 ' + round.request + ' 轮';
    if (round.tools.length || round.turn?.calls.length) {
      round.state = round.tools.some((t) => t.status === 'RUNNING')
        ? '正在读取'
        : round.tools.length &&
            round.tools.every((t) => t.error_code === 'REPAIR_FIRST_OBSERVATION_REQUIRED')
          ? '首轮批量读取已暂缓'
          : round.tools.some((t) => t.status === 'FAILED')
            ? '包含失败调用'
            : round.tools.length
              ? '已返回结果'
              : '等待执行';
    } else if (round.turn) {
      round.state = repair.response_checks.some((c) => c.request === round.request)
        ? '结论需纠正'
        : repair.diagnosis && round.request === repair.model_requests
          ? '结论已校验'
          : '校验结论';
    } else round.state = '等待模型选择';
  }
  return [...groups.values()].sort((a, b) => (a.request ?? -1) - (b.request ?? -1));
}
