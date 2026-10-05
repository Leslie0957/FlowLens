import {copyFileSync} from 'node:fs';
copyFileSync(new URL('../apps/server/src/local-runner.mjs',import.meta.url),new URL('../apps/server/dist/local-runner.mjs',import.meta.url));
