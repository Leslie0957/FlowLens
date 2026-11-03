import { readFileSync } from 'node:fs';
export const robustnessSpec = JSON.parse(
  readFileSync(new URL('../fixtures/evals/pipeline-robustness-v1.json', import.meta.url), 'utf8'),
);

export function robustnessDatasets() {
  const make = (id, events, shared = false, reverse = false) => {
    const rows = [],
      expected_ids = [];
    events.forEach(([speed, duration, included], i) => {
      const eventId = (reverse ? 9000 : 1000) + i;
      const start = (reverse ? 1850000000000000 : 1600000000000000) + i * 20000000;
      rows.push([
        eventId,
        shared ? 'robust_共享样本' : id + '_' + i,
        start,
        start + duration,
        speed,
        i % 2 ? 'SERIES_中文' : 'ROBUST_B',
      ]);
      if (included) expected_ids.push(eventId);
    });
    if (reverse) {
      rows.reverse();
      expected_ids.reverse();
    }
    return { id, rows, expected_ids };
  };
  const grid = robustnessSpec.speed_classes.flatMap(([speed, speedOk]) =>
    robustnessSpec.duration_classes.map(([duration, durationOk]) => [
      speed,
      duration,
      speedOk && durationOk,
    ]),
  );
  return [
    make('boundary-grid', grid),
    make('reordered-grid', grid, true, true),
    ...robustnessSpec.mini_sets.map((s) => make(s.id, s.events, s.id === 'shared-sample')),
  ];
}

export function validateRobustness(sql, validate) {
  const datasets = robustnessDatasets().map((dataset) => ({
    id: dataset.id,
    source_count: dataset.rows.length,
    ...validate(sql, dataset),
  }));
  return {
    version: robustnessSpec.version,
    passed: datasets.every((d) => d.passed),
    datasets,
    limitation: 'Finite synthetic contract checks; not proof of general SQL semantic correctness.',
  };
}
