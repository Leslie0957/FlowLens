import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, validateCandidate } from './pipeline-eval-core.mjs';
import { validateRobustness } from './pipeline-robustness.mjs';

const sql =
  'SELECT dat, start_us AS st, end_us AS et, car_series FROM raw_vehicle_events WHERE speed_mps < 1 AND end_us - start_us >= 3000000;';
const candidates = [
  ['correct', sql, true],
  ['equivalent-order', sql.replace(';', ' ORDER BY event_id DESC;'), true],
  ['narrow-speed', sql.replace('< 1', '< 0.9995'), false],
  ['row-limit', sql.replace(';', ' LIMIT 4;'), false],
  ['inclusive-speed', sql.replace('< 1', '<= 1'), false],
  ['strict-duration', sql.replace('>= 3000000', '> 3000000'), false],
  ['seconds-as-microseconds', sql.replace('>= 3000000', '>= 3'), false],
  ['missing-duration', sql.replace(' AND end_us - start_us >= 3000000', ''), false],
  ['or-for-and', sql.replace(' AND ', ' OR '), false],
  ['spurious-upper-duration', sql.replace(';', ' AND end_us - start_us < 9000000;'), false],
  ['wrong-output-value', sql.replace('start_us AS st', 'start_us + 1 AS st'), false],
];
const cases = candidates.map(([id, candidate, expected]) => ({
  id,
  sql: candidate,
  expected_passed: expected,
  result: validateRobustness(candidate, validateCandidate),
}));
const parent = join(root, 'logs/pipeline/robustness');
mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(join(parent, 'offline-'));
const report = {
  mode: 'SQL_ONLY_NO_AGENT',
  cases,
  status: cases.every((c) => c.expected_passed === c.result.passed) ? 'PASSED' : 'FAILED',
};
writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      directory,
      status: report.status,
      cases: cases.map((c) => ({ id: c.id, expected: c.expected_passed, actual: c.result.passed })),
    },
    null,
    2,
  ),
);
if (report.status !== 'PASSED') process.exitCode = 1;
