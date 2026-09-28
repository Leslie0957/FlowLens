import { resolve,isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
export function databasePath():string {
  const root=fileURLToPath(new URL('../../../',import.meta.url));
  const input=process.env.APP_DB_PATH||'data/flowlens.sqlite';
  return isAbsolute(input)?input:resolve(root,input);
}
