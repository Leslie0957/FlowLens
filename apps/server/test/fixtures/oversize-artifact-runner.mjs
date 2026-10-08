import { writeFileSync } from 'node:fs';
writeFileSync(
  'result.json',
  JSON.stringify({ rows: [{ order_count: 3, total_amount: 100 }], padding: 'X'.repeat(65536) }),
);
