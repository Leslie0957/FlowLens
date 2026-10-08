// Test-only child: stop after a real target commit, before application audit.
// No fault switch is exposed by the server or the HTTP API.
import { join } from 'node:path';
import { openDatabase, migrate } from '../../src/db.js';
import { PipelineService } from '../../src/pipeline.js';
const [root, projectId, entityId, mode, key] = process.argv.slice(2);
if (!root || !projectId || !entityId || !key || !['COMMIT', 'RESTORE'].includes(mode!))
  throw new Error('TEST_ARGS');
const db = openDatabase(join(root, 'app.sqlite'));
migrate(db);
const service = new PipelineService(db, join(root, 'projects'));
const put = service.put.bind(service);
service.put = (kind, item, project) => {
  if (kind === 'operation' && 'status' in item && item.status === 'SUCCEEDED') process.exit(73);
  put(kind, item, project);
};
if (mode === 'COMMIT') service.commit(projectId, entityId, key);
else service.restore(projectId, entityId, key);
throw new Error('CRASH_BOUNDARY_NOT_REACHED');
