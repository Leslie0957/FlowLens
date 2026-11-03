import { expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluationMessages, promptVariantText } from '../../../scripts/pipeline-eval-prompts.mjs';
import { controlledRun, executionPlan } from '../../../scripts/pipeline-controlled-run.mjs';
import { pipelineBaselinePrompt, pipelineDefaultPrompt } from '../src/pipeline-prompts.js';
import { createHash } from 'node:crypto';

it('prompt variants are explicit, keep the baseline intact and do not inject case labels or hidden answers', () => {
  const messages = [
    { role: 'system', content: '原始生产指令' },
    { role: 'user', content: '真实失败' },
    { role: 'tool', tool_call_id: 'test-call', content: '{"evidence_ids":["observed-id"]}' },
  ];
  const saved = structuredClone(messages);
  expect(evaluationMessages(messages)).toEqual(saved);
  const changed = evaluationMessages(messages, 'grounded-actions-v1');
  expect(messages).toEqual(saved);
  expect(changed.slice(1)).toEqual(saved.slice(1));
  expect(changed[0].content).toBe(
    saved[0].content + '\n\n' + promptVariantText('grounded-actions-v1'),
  );
  const supplemental = promptVariantText('grounded-actions-v1');
  for (const hidden of [
    'D07',
    'BUSINESS_KEY_CONFLICT',
    'speed_mps',
    'task_id',
    'SELECT ',
    'expected_count',
  ])
    expect(supplemental).not.toContain(hidden);
  expect(() => evaluationMessages(messages, 'invented')).toThrow('INVALID_PROMPT_VARIANT');
  expect(() => evaluationMessages([], 'grounded-actions-v1')).toThrow(
    'EVAL_SYSTEM_PROMPT_REQUIRED',
  );
});

it('plans freeze the prompt variant separately from limits and keep baseline the default', () => {
  expect(executionPlan(['D07']).prompt_variant).toBe('baseline');
  const baseline = executionPlan(['D07'], { profile: 'effect' });
  const variant = executionPlan(['D07'], {
    profile: 'effect',
    promptVariant: 'grounded-actions-v1',
  });
  expect(variant.limits).toEqual(baseline.limits);
  expect(variant.scoring_version).toBe(baseline.scoring_version);
  expect(variant.prompt_supplement_sha256).not.toBe(baseline.prompt_supplement_sha256);
  expect(() => executionPlan(['D07'], { promptVariant: 'hidden-labels' })).toThrow(
    'INVALID_PROMPT_VARIANT',
  );
});

it('promotion preserves exact tested prompts and neither silently replaces the baseline nor doubles the supplement', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  expect(sha(pipelineBaselinePrompt)).toBe(
    'be6d5b00abeb9c8dc1212caf3132df595293eb02dd289388f89c047cc228268e',
  );
  expect(sha(pipelineDefaultPrompt)).toBe(
    '5b5425cb0f1bf9c454076c6c8336b6f493862a8091cc19f04368067764f8b07b',
  );
  const fromWeb = [
    { role: 'system', content: pipelineDefaultPrompt },
    { role: 'user', content: 'actual failure' },
  ];
  expect(evaluationMessages(fromWeb)[0].content).toBe(pipelineBaselinePrompt);
  expect(evaluationMessages(fromWeb, 'grounded-actions-v1')[0].content).toBe(pipelineDefaultPrompt);
  expect(
    evaluationMessages(evaluationMessages(fromWeb, 'grounded-actions-v1'), 'grounded-actions-v1'),
  ).toEqual(fromWeb);
});

it('promoted web strategy and explicit evaluated variant send the same Prompt exactly once', async () => {
  const network = vi.fn(() => {
    throw new Error('REAL_NETWORK_FORBIDDEN');
  });
  vi.stubGlobal('fetch', network);
  try {
    const report = await controlledRun({
      ids: ['D01', 'D02', 'D04', 'D07'],
      profile: 'effect',
      promptVariant: 'grounded-actions-v1',
      simulate: true,
      directory: mkdtempSync(join(tmpdir(), 'flowlens-prompt-test-')),
    });
    expect(report.status).toBe('CHECKS_PASSED');
    expect(report.actual_live_api_attempts).toBe(0);
    expect(network).not.toHaveBeenCalled();
    for (const c of report.cases) {
      expect(c.prompt_variant).toBeUndefined(); // variant belongs to each request and the plan, not the answer
      const request = c.requests[0];
      const wire = report.records.find((r: { case_id: string }) => r.case_id === c.id);
      expect(request.prompt_variant).toBe('grounded-actions-v1');
      expect(request.system_prompt_sha256).toBe(wire.prompt_sha256);
      expect(request.agent_system_prompt_sha256).toBe(request.system_prompt_sha256);
      expect(request.messages[0].content).toBe(wire.request.messages[0].content);
      expect(c.metrics.no_target_writes).toBe(true);
      if (c.id === 'D07') expect(c.diagnosis.action).toBe('MANUAL_REQUIRED');
      else expect(c.candidate_validation.robustness.passed).toBe(true);
    }
  } finally {
    vi.unstubAllGlobals();
  }
}, 30000);
