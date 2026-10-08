// Product adaptation of FlowLens M0 DeepSeek gateway; see docs/adr/0001-m0-technical-validation.md.
import { decodeChatStream, type Completion } from './model-stream.js';
import { ProbeError } from './model-error.js';
import { toolDescriptions } from './diagnosis-tools.js';
import type { ToolDescription } from './tool-registry.js';

export interface ModelGateway {
  complete(
    messages: Record<string, unknown>[],
    signal: AbortSignal,
    onDelta?: (text: string) => void,
    onFirstDelta?: () => void,
  ): Promise<Completion>;
}
export function deepSeekGateway(config: {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxOutputTokens: number;
  tools?: ToolDescription[];
  jsonMode?: boolean;
}): ModelGateway {
  const root = config.baseUrl.replace(/\/$/, '');
  if (root !== 'https://api.deepseek.com') throw new ProbeError('INVALID_CONFIG');
  return {
    async complete(messages, signal, onDelta, onFirstDelta) {
      let response: Response;
      try {
        response = await fetch(root + '/chat/completions', {
          method: 'POST',
          signal,
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: config.model,
            messages,
            tools: (config.tools ?? toolDescriptions).map((t) => ({
              type: 'function',
              function: t,
            })),
            tool_choice: 'auto',
            ...(config.jsonMode === false ? {} : { response_format: { type: 'json_object' } }),
            thinking: { type: 'disabled' },
            max_tokens: config.maxOutputTokens,
            stream: true,
            stream_options: { include_usage: true },
          }),
        });
      } catch {
        throw new ProbeError(signal.aborted ? 'CANCELLED' : 'MODEL_NETWORK_ERROR');
      }
      if (!response.ok)
        throw new ProbeError(
          response.status === 401 || response.status === 403
            ? 'MODEL_AUTH_ERROR'
            : response.status === 429
              ? 'MODEL_RATE_LIMIT'
              : response.status >= 500
                ? 'MODEL_UNAVAILABLE'
                : 'MODEL_REQUEST_ERROR',
        );
      if (!response.body) throw new ProbeError('PROTOCOL_ERROR');
      return decodeChatStream(response.body, onFirstDelta, onDelta);
    },
  };
}
export function mockGateway(
  runId: string,
  status: string,
  errorCode: string | null,
  retryAllowed: boolean,
): ModelGateway {
  let stage = 0;
  const faults: Record<
    string,
    { summary: string; explanation: string; query: string; next: string }
  > = {
    SCHEMA_MISMATCH: {
      summary: '校验阶段缺少必填字段 amount',
      explanation: '校验日志显示 required=[order_id,amount]，observed=[order_id]，缺少 amount',
      query: 'SCHEMA_MISMATCH',
      next: '人工核对输入 Schema 与字段映射；本环境无法补齐输入，直接重试不能生成缺失字段',
    },
    SQL_COLUMN_ERROR: {
      summary: '聚合阶段 SQL 引用了不存在的 order_total 列',
      explanation: '聚合日志报 no such column: order_total',
      query: 'SQL_COLUMN_ERROR',
      next: '人工在外部核对表结构与 SQL 列映射；本环境不修改或执行 SQL',
    },
    DUPLICATE_DATA: {
      summary: '入库阶段订单主键唯一约束冲突',
      explanation: '入库日志报 UNIQUE constraint failed: orders.order_id',
      query: 'DUPLICATE_DATA',
      next: '人工检查重复输入、已有订单与写入幂等策略；本环境不删除数据，重试不会自动去重',
    },
  };
  const fault = errorCode ? faults[errorCode] : undefined;
  return {
    async complete(messages) {
      if (stage++ === 0)
        return {
          text: '',
          calls: [
            {
              id: 'mock-logs',
              name: 'get_task_logs',
              arguments: { run_id: runId, ...(fault ? { level: 'ERROR' } : {}) },
            },
            {
              id: 'mock-runbook',
              name: 'search_runbook',
              arguments: {
                query:
                  status === 'SUCCEEDED'
                    ? '任务总览'
                    : errorCode === 'UPSTREAM_TIMEOUT'
                      ? 'ReadTimeout'
                      : (fault?.query ?? '信息不足'),
              },
            },
          ],
          finishReason: 'tool_calls',
        };
      const toolResults = messages
        .filter((m) => m.role === 'tool')
        .map((m) => {
          try {
            return JSON.parse(String(m.content)) as { evidence_ids?: string[] };
          } catch {
            return {};
          }
        });
      const timeout = errorCode === 'UPSTREAM_TIMEOUT',
        normal = status === 'SUCCEEDED';
      const stateIds = messages
        .filter((m) => m.role === 'user')
        .flatMap((m) => {
          try {
            const context = JSON.parse(String(m.content)) as {
              current_run_evidence_ids?: string[];
            };
            return context.current_run_evidence_ids ?? [];
          } catch {
            return [];
          }
        });
      const ids = timeout || fault ? toolResults.flatMap((x) => x.evidence_ids ?? []) : stateIds;
      if (fault)
        return {
          text: JSON.stringify({
            summary: fault.summary + '（演示数据）',
            findings: [
              {
                cause: errorCode,
                explanation: fault.explanation,
                evidence_ids: ids.slice(0, 2),
                evidence_status: 'SUPPORTED',
              },
            ],
            missing_information: [],
            next_steps: [fault.next, '该失败不满足模拟重试条件'],
            proposed_action: null,
          }),
          calls: [],
          finishReason: 'stop',
        };
      const result = {
        summary: normal
          ? '运行成功，未发现失败（演示数据）'
          : timeout
            ? '读取阶段上游超时（演示数据）'
            : '当前信息不足，无法确定根因（演示数据）',
        findings: [
          {
            cause: normal ? 'NONE' : timeout ? 'UPSTREAM_TIMEOUT' : 'UNKNOWN',
            explanation: normal
              ? '运行状态为成功'
              : timeout
                ? '读取阶段出现超时日志'
                : '日志未给出可确认的具体原因',
            evidence_ids: ids.slice(0, timeout ? 2 : 1),
            evidence_status: normal || timeout ? 'SUPPORTED' : 'NEEDS_CONFIRMATION',
          },
        ],
        missing_information: normal || timeout ? [] : ['需要更详细的错误日志和上游状态'],
        next_steps: normal
          ? ['无需重试']
          : timeout
            ? retryAllowed
              ? ['核查上游可用性，再决定是否申请模拟重试']
              : ['当前运行不具备再次模拟重试资格，查看已有运行结果']
            : ['补充错误详情'],
        proposed_action:
          timeout && retryAllowed
            ? {
                type: 'RETRY_RUN',
                run_id: runId,
                reason: '已知暂时性上游超时',
                evidence_ids: ids.slice(0, 2),
              }
            : null,
      };
      return { text: JSON.stringify(result), calls: [], finishReason: 'stop' };
    },
  };
}
