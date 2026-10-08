import { expect, it } from 'vitest';
import { openDatabase, migrate, seed } from '../src/db.js';
import { createSession, submitMessage, snapshot } from '../src/diagnosis-store.js';
import { runDiagnosis } from '../src/diagnosis-agent.js';

it.each(['empty', 'uncited', 'wrong-cause'])(
  'normal run must retain a cited NONE finding: %s',
  async (invalid) => {
    const db = openDatabase(':memory:');
    migrate(db);
    seed(db);
    try {
      const session = createSession(db, 'seed_s00', 'm5-quality-session'),
        sent = submitMessage(db, session.id, '正常吗，给出依据', 'm5-quality-turn', 'MOCK', 'mock');
      let calls = 0;
      await runDiagnosis(db, {
        turnId: sent.turn_id,
        sessionId: session.id,
        runId: 'seed_s00',
        question: '正常吗，给出依据',
        mode: 'MOCK',
        model: 'mock',
        logSink: () => {},
        gateway: {
          async complete(messages) {
            calls++;
            const context = JSON.parse(
              String(messages.find((m) => m.role === 'user')?.content),
            ) as { current_run_evidence_ids: string[] };
            const finding = {
              cause: invalid === 'wrong-cause' && calls === 1 ? 'UNKNOWN' : 'NONE',
              explanation: '运行成功',
              evidence_ids:
                invalid === 'uncited' && calls === 1 ? [] : context.current_run_evidence_ids,
              evidence_status: 'SUPPORTED',
            };
            return {
              text: JSON.stringify({
                summary: '运行成功',
                findings: invalid === 'empty' && calls === 1 ? [] : [finding],
                missing_information: [],
                next_steps: [],
                proposed_action: null,
              }),
              calls: [],
              finishReason: 'stop',
            };
          },
        },
      });
      expect(calls).toBe(2);
      const state = snapshot(db, session.id);
      expect(state.turns[0]?.status).toBe('COMPLETED');
      const findings = JSON.parse(state.results[0]!.findings_json as string);
      expect(findings[0]).toMatchObject({ cause: 'NONE' });
      expect(findings[0].evidence_ids).toHaveLength(1);
    } finally {
      db.close();
    }
  },
);

it('provides registered log references to a follow-up while excluding other sessions', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  try {
    const session = createSession(db, 'seed_s04', 'm5-log-context');
    const first = submitMessage(db, session.id, '失败原因', 'm5-log-first', 'MOCK', 'mock');
    await runDiagnosis(db, {
      turnId: first.turn_id,
      sessionId: session.id,
      runId: 'seed_s04',
      question: '失败原因',
      mode: 'MOCK',
      model: 'mock',
      logSink: () => {},
    });
    const other = createSession(db, 'seed_s01', 'm5-other-context'),
      secret = submitMessage(db, other.id, 'OTHER_SESSION_PRIVATE', 'm5-log-other', 'MOCK', 'mock');
    await runDiagnosis(db, {
      turnId: secret.turn_id,
      sessionId: other.id,
      runId: 'seed_s01',
      question: 'OTHER_SESSION_PRIVATE',
      mode: 'MOCK',
      model: 'mock',
      logSink: () => {},
    });
    const second = submitMessage(db, session.id, '还能重试吗', 'm5-log-second', 'MOCK', 'mock');
    let calls = 0;
    await runDiagnosis(db, {
      turnId: second.turn_id,
      sessionId: session.id,
      runId: 'seed_s04',
      question: '还能重试吗',
      mode: 'MOCK',
      model: 'mock',
      logSink: () => {},
      gateway: {
        async complete(messages) {
          calls++;
          const latest = JSON.parse(
            String(
              messages
                .filter(
                  (m) =>
                    m.role === 'user' && String(m.content).includes('current_run_evidence_ids'),
                )
                .at(-1)?.content,
            ),
          );
          const refs = (latest.registered_log_evidence ?? []) as { id: string; excerpt: string }[];
          expect(JSON.stringify(refs)).not.toContain('Schema validation failed');
          const id = refs.find((e) => e.excerpt.includes('ReadTimeout'))?.id;
          return {
            text: JSON.stringify({
              summary: '读取超时，引用沿用已登记日志',
              findings: [
                {
                  cause: 'UPSTREAM_TIMEOUT',
                  explanation: '日志报ReadTimeout',
                  evidence_ids: id ? [id] : latest.current_run_evidence_ids,
                  evidence_status: 'SUPPORTED',
                },
              ],
              missing_information: [],
              next_steps: [],
              proposed_action: null,
            }),
            calls: [],
            finishReason: 'stop',
          };
        },
      },
    });
    const state = snapshot(db, session.id);
    expect(state.turns.at(-1)?.status).toBe('COMPLETED');
    expect(calls).toBe(1);
  } finally {
    db.close();
  }
});

it('rejects a repeated normal answer without findings instead of saving or fabricating evidence', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  try {
    const session = createSession(db, 'seed_s00', 'm5-quality-reject'),
      sent = submitMessage(db, session.id, '正常吗', 'm5-quality-reject-turn', 'MOCK', 'mock');
    let calls = 0;
    await runDiagnosis(db, {
      turnId: sent.turn_id,
      sessionId: session.id,
      runId: 'seed_s00',
      question: '正常吗',
      mode: 'MOCK',
      model: 'mock',
      logSink: () => {},
      gateway: {
        async complete() {
          calls++;
          return {
            text: JSON.stringify({
              summary: '运行成功',
              findings: [],
              missing_information: [],
              next_steps: [],
              proposed_action: null,
            }),
            calls: [],
            finishReason: 'stop',
          };
        },
      },
    });
    const state = snapshot(db, session.id);
    expect(calls).toBe(2);
    expect(state.turns[0]?.status).toBe('FAILED');
    expect(state.results).toHaveLength(0);
  } finally {
    db.close();
  }
});

it('keeps an unknown deeper origin in missing information rather than conflicting known and UNKNOWN findings', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  try {
    const session = createSession(db, 'seed_s02', 'm5-mixed-session'),
      sent = submitMessage(db, session.id, '为什么失败', 'm5-mixed-turn', 'MOCK', 'mock');
    let calls = 0;
    await runDiagnosis(db, {
      turnId: sent.turn_id,
      sessionId: session.id,
      runId: 'seed_s02',
      question: '为什么失败',
      mode: 'MOCK',
      model: 'mock',
      logSink: () => {},
      gateway: {
        async complete(messages) {
          calls++;
          if (calls === 1)
            return {
              text: '',
              calls: [
                {
                  id: 'logs',
                  name: 'get_task_logs',
                  arguments: { run_id: 'seed_s02', level: 'ERROR' },
                },
              ],
              finishReason: 'tool_calls',
            };
          const logs = JSON.parse(
            String(messages.filter((m) => m.role === 'tool').at(-1)?.content),
          ) as { evidence_ids: string[] };
          const findings = [
            {
              cause: 'SQL_COLUMN_ERROR',
              explanation: '日志指出 order_total 列不存在',
              evidence_ids: logs.evidence_ids,
              evidence_status: 'SUPPORTED',
            },
          ];
          if (calls === 2)
            findings.push({
              cause: 'UNKNOWN',
              explanation: '尚未确定列缺失的更深原因',
              evidence_ids: logs.evidence_ids,
              evidence_status: 'NEEDS_CONFIRMATION',
            });
          return {
            text: JSON.stringify({
              summary: '聚合列引用错误',
              findings,
              missing_information: ['列缺失的更深原因与正确替换列未记录'],
              next_steps: [],
              proposed_action: null,
            }),
            calls: [],
            finishReason: 'stop',
          };
        },
      },
    });
    expect(calls).toBe(3);
    const state = snapshot(db, session.id);
    expect(state.turns[0]?.status).toBe('COMPLETED');
    const result = state.results[0]!;
    expect(
      JSON.parse(result.findings_json as string).map((f: { cause: string }) => f.cause),
    ).toEqual(['SQL_COLUMN_ERROR']);
    expect(JSON.parse(result.missing_information_json as string)).toContain(
      '列缺失的更深原因与正确替换列未记录',
    );
  } finally {
    db.close();
  }
});
