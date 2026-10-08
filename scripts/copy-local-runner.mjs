import { copyFileSync } from 'node:fs';
copyFileSync(
  new URL('../apps/server/src/local-runner.mjs', import.meta.url),
  new URL('../apps/server/dist/local-runner.mjs', import.meta.url),
);
for (const name of ['pipeline-runner.mjs', 'pipeline-sql.mjs'])
  copyFileSync(
    new URL('../apps/server/src/' + name, import.meta.url),
    new URL('../apps/server/dist/' + name, import.meta.url),
  );
