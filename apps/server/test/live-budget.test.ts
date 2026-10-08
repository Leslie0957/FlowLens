import { afterEach, expect, it, vi } from 'vitest';
import { createLiveRequestBudget } from '../src/live-budget.js';
import { openDatabase, migrate, seed } from '../src/db.js';
import { createSession, submitMessage, snapshot } from '../src/diagnosis-store.js';
import { runDiagnosis } from '../src/diagnosis-agent.js';

afterEach(() => vi.unstubAllEnvs());

it('requires explicit approval even for unlimited use', () => {
  const budget = createLiveRequestBudget();
  for (const approval of [undefined, '0'])
    expect(() => budget.reserve(approval, 'unlimited')).toThrowError('LIVE_NOT_APPROVED');
  expect(budget.reserve('1', 'unlimited')).toBe(1);
});

it('allows ongoing approved conversation beyond twelve requests', () => {
  const budget = createLiveRequestBudget();
  for (let request = 1; request <= 25; request++)
    expect(budget.reserve('1', 'unlimited')).toBe(request);
});

it('preserves finite budgets and accepts a configured ceiling greater than twelve', () => {
  const budget = createLiveRequestBudget();
  for (let request = 1; request <= 20; request++) expect(budget.reserve('1', '20')).toBe(request);
  expect(() => budget.reserve('1', '20')).toThrowError('LIVE_REQUEST_BUDGET_EXCEEDED');
});

it('rejects missing or invalid budgets rather than silently enabling unlimited use', () => {
  const budget = createLiveRequestBudget();
  for (const limit of [undefined, '', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992'])
    expect(() => budget.reserve('1', limit)).toThrowError('LIVE_NOT_APPROVED');
  expect(budget.reserve('1', '1')).toBe(1);
  expect(() => budget.reserve('1', '1')).toThrowError('LIVE_REQUEST_BUDGET_EXCEEDED');
});

it('completes more than twelve LIVE turns with a supplied offline gateway', async () => {
  vi.stubEnv('FLOWLENS_LIVE_APPROVED', '1');
  vi.stubEnv('FLOWLENS_LIVE_MAX_REQUESTS', 'unlimited');
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  try {
    const session = createSession(db, 'seed_s05', 'live-ongoing-session');
    let calls = 0;
    for (let index = 0; index < 13; index++) {
      const question = '当前还缺哪些证据？',
        sent = submitMessage(
          db,
          session.id,
          question,
          'live-ongoing-' + index,
          'LIVE',
          'offline-test',
        );
      await runDiagnosis(db, {
        turnId: sent.turn_id,
        sessionId: session.id,
        runId: 'seed_s05',
        question,
        mode: 'LIVE',
        model: 'offline-test',
        logSink: () => {},
        gateway: {
          async complete() {
            calls++;
            return {
              text: JSON.stringify({
                summary: '根因仍未知',
                findings: [],
                missing_information: ['原始异常'],
                next_steps: [],
                proposed_action: null,
              }),
              calls: [],
              finishReason: 'stop',
            };
          },
        },
      });
    }
    expect(calls).toBe(13);
    expect(snapshot(db, session.id).turns.every((turn) => turn.status === 'COMPLETED')).toBe(true);
  } finally {
    db.close();
  }
});

it('still bounds a single turn when the model keeps requesting tools in unlimited mode', async () => {
  vi.stubEnv('FLOWLENS_LIVE_APPROVED', '1');
  vi.stubEnv('FLOWLENS_LIVE_MAX_REQUESTS', 'unlimited');
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  try {
    const session = createSession(db, 'seed_s05', 'live-bounded-session');
    const sent = submitMessage(
      db,
      session.id,
      '反复查询',
      'live-bounded-turn',
      'LIVE',
      'offline-test',
    );
    let calls = 0;
    await runDiagnosis(db, {
      turnId: sent.turn_id,
      sessionId: session.id,
      runId: 'seed_s05',
      question: '反复查询',
      mode: 'LIVE',
      model: 'offline-test',
      logSink: () => {},
      gateway: {
        async complete() {
          calls++;
          return {
            text: '',
            calls: [
              { id: 'repeat-' + calls, name: 'get_task_run', arguments: { run_id: 'seed_s05' } },
            ],
            finishReason: 'tool_calls',
          };
        },
      },
    });
    const state = snapshot(db, session.id);
    expect(state.turns[0]).toMatchObject({ status: 'FAILED', error_code: 'BUDGET_EXCEEDED' });
    expect(state.results).toHaveLength(0);
    expect(state.tool_calls).toHaveLength(8);
    expect(calls).toBeLessThanOrEqual(12);
  } finally {
    db.close();
  }
});
