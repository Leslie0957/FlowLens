import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { SCENARIO_IDS, scenarioIdSchema } from '@flowlens/contracts';

const event = z.object({
  offset_ms: z.number().int().min(0),
  step: z.enum(['read', 'validate', 'load', 'aggregate']),
  step_status: z.enum(['RUNNING', 'SUCCEEDED', 'FAILED']),
  run_status: z.enum(['RUNNING', 'SUCCEEDED', 'FAILED']).optional(),
  logs: z.array(z.object({ level: z.enum(['INFO', 'WARN', 'ERROR']), message: z.string().min(1) })),
  error_code: z.string().optional(),
  error_message: z.string().optional(),
  summary: z.record(z.string(), z.unknown()).optional(),
});
const fixtureSchema = z.object({
  scenario_id: scenarioIdSchema,
  version: z.string(),
  display_name: z.string(),
  description: z.string(),
  task_id: z.literal('order_daily'),
  params: z.record(z.string(), z.unknown()),
  timeline: z.array(event).min(1),
  retry_timeline: z.array(event).optional(),
});
export type Fixture = z.infer<typeof fixtureSchema>;
export const SCENARIOS = SCENARIO_IDS;
export function loadFixture(
  id: (typeof SCENARIOS)[number],
  dir = fileURLToPath(new URL('../../../fixtures/scenarios/', import.meta.url)),
): Fixture {
  const fixture = fixtureSchema.parse(JSON.parse(readFileSync(resolve(dir, id + '.json'), 'utf8')));
  if (fixture.scenario_id !== id) throw new Error('FIXTURE_ID_MISMATCH');
  for (const timeline of [
    fixture.timeline,
    ...(fixture.retry_timeline ? [fixture.retry_timeline] : []),
  ]) {
    let previous = -1;
    let terminals = 0;
    for (const event of timeline) {
      if (event.offset_ms <= previous) throw new Error('FIXTURE_TIME_ORDER');
      previous = event.offset_ms;
      if (event.run_status === 'SUCCEEDED' || event.run_status === 'FAILED') terminals++;
    }
    if (terminals !== 1 || !['SUCCEEDED', 'FAILED'].includes(timeline.at(-1)?.run_status ?? ''))
      throw new Error('FIXTURE_TERMINAL');
  }
  return fixture;
}
