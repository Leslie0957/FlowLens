// Explicit historical baseline and promoted production strategy, with no double
// append when the Agent already uses grounded-actions-v1.
import {
  pipelineBaselinePrompt,
  pipelineDefaultPrompt,
  groundedActionsSupplement,
} from '../apps/server/src/pipeline-prompts.ts';
export const PROMPT_VARIANTS = Object.freeze({
  baseline: '',
  'grounded-actions-v1': groundedActionsSupplement,
});

export function promptVariantText(variant = 'baseline') {
  if (!Object.hasOwn(PROMPT_VARIANTS, variant)) throw new Error('INVALID_PROMPT_VARIANT');
  return PROMPT_VARIANTS[variant];
}

export function evaluationMessages(messages, variant = 'baseline') {
  const suffix = promptVariantText(variant);
  const copy = structuredClone(messages);
  const system = copy.find((m) => m.role === 'system');
  if (system?.content === pipelineDefaultPrompt) system.content = pipelineBaselinePrompt;
  if (!suffix) return copy;
  if (!system || typeof system.content !== 'string') throw new Error('EVAL_SYSTEM_PROMPT_REQUIRED');
  system.content += '\n\n' + suffix;
  return copy;
}
