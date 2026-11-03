import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Read-only merge: raw observations remain immutable; reviews are bound to the
// exact report bytes. A reviewer must identify themselves and explain a verdict.
export function reviewSummary(reportText, review) {
  const report = JSON.parse(reportText);
  assert.equal(
    review.report_sha256,
    createHash('sha256').update(reportText).digest('hex'),
    'REVIEW_REPORT_MISMATCH',
  );
  assert.equal(review.mode, report.mode, 'REVIEW_MODE_MISMATCH');
  const ids = new Set(report.cases.map((c) => c.id));
  assert.equal(review.cases.length, ids.size, 'REVIEW_CASES_INCOMPLETE');
  const seen = new Set();
  const fields = ['diagnosis_correct', 'evidence_sufficient', 'prohibited_claims'];
  for (const entry of review.cases) {
    assert.ok(ids.has(entry.id) && !seen.has(entry.id), 'REVIEW_CASE_INVALID');
    seen.add(entry.id);
    assert.ok(
      fields.every((f) => entry[f] === null || typeof entry[f] === 'boolean'),
      'REVIEW_VERDICT_INVALID',
    );
    if (fields.some((f) => entry[f] !== null))
      assert.ok(entry.reviewer?.trim() && entry.reason?.trim(), 'REVIEW_ATTRIBUTION_REQUIRED');
  }
  const complete = review.cases.filter((c) => fields.every((f) => typeof c[f] === 'boolean'));
  return {
    mode: report.mode,
    reviewed: complete.length,
    pending: ids.size - complete.length,
    cases: review.cases,
    review_coverage: { complete: complete.length, total: ids.size },
    reviewed_subset_correct:
      report.mode === 'LIVE' && complete.length
        ? { correct: complete.filter((c) => c.diagnosis_correct).length, total: complete.length }
        : null,
    diagnosis_accuracy:
      report.mode === 'LIVE' && complete.length > 0 && complete.length === ids.size
        ? { correct: complete.filter((c) => c.diagnosis_correct).length, total: complete.length }
        : null,
    note: 'MOCK output review never becomes LIVE diagnosis accuracy. A partial reviewed subset is not whole-run accuracy. Source coverage, semantic sufficiency and candidate correctness are separate judgments.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2)
    throw new Error('Usage: node scripts/review-pipeline-eval.mjs <report.json> <review.json>');
  console.log(
    JSON.stringify(
      reviewSummary(readFileSync(args[0], 'utf8'), JSON.parse(readFileSync(args[1], 'utf8'))),
      null,
      2,
    ),
  );
}
