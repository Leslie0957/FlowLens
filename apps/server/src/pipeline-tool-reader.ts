import { DatabaseSync } from 'node:sqlite';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import {
  pipelineExecutionSchema,
  pipelineRevisionSchema,
  pipelineProjectSchema,
  pipelineRepairSchema,
} from '@flowlens/contracts';
import { canonical } from './pipeline-diag-config.js';
import { sha, contract, readSource } from './pipeline-data.js';
import { LocalError } from './local-execution.js';
import { readLogs, TOOL_OUTPUT_BYTES } from './pipeline-logs.js';
import {
  toolSchemas,
  toolSource,
  toolResponseSchema,
  type PipelineToolName,
  type PipelineToolScope,
} from './pipeline-tools.js';

// This module opens only read-only SQLite connections. It never constructs
// PipelineService, migrates a target, recovers state or writes diagnosis records.
export function readPipelineTool(
  scope: PipelineToolScope,
  name: PipelineToolName,
  raw: Record<string, unknown>,
) {
  const parsed = toolSchemas[name].safeParse(raw);
  if (!parsed.success) throw new LocalError('INVALID_ARGUMENTS', 400);
  const args = parsed.data;
  const directory = realpathSync.native(resolve(scope.project_dir));
  if (lstatSync(scope.project_dir).isSymbolicLink() || basename(directory) !== scope.project_id)
    throw new LocalError('TOOL_SCOPE', 403);
  const path = (file: 'source.sqlite' | 'target.sqlite') => {
    const value = join(directory, file),
      actual = realpathSync.native(value);
    if (lstatSync(value).isSymbolicLink() || !actual.startsWith(directory + sep))
      throw new LocalError('TOOL_SCOPE', 403);
    return actual;
  };
  const db = new DatabaseSync(scope.app_db_path, { readOnly: true, timeout: 1000 });
  try {
    db.exec('BEGIN');
    const get = (kind: string, id: string) => {
      const row = db
        .prepare('SELECT json FROM pipeline_entity WHERE kind=? AND id=?')
        .get(kind, id);
      if (!row) throw new LocalError('TOOL_SCOPE', 403);
      return JSON.parse(String(row.json));
    };
    const repair = pipelineRepairSchema.parse(get('repair', scope.repair_id));
    if (repair.status !== 'RUNNING') throw new LocalError('REPAIR_NOT_RUNNING', 409);
    const project = pipelineProjectSchema.parse(get('project', scope.project_id));
    const e = pipelineExecutionSchema.parse(get('execution', scope.execution_id));
    const revision = pipelineRevisionSchema.parse(get('revision', scope.revision_id));
    if (
      repair.project_id !== scope.project_id ||
      repair.execution_id !== e.id ||
      repair.base_revision_id !== revision.id ||
      repair.base_hash !== scope.revision_hash ||
      repair.input_hash !== scope.input_hash ||
      e.project_id !== scope.project_id ||
      e.revision_id !== revision.id ||
      e.revision_hash !== scope.revision_hash ||
      e.input_hash !== scope.input_hash ||
      revision.project_id !== scope.project_id ||
      revision.input_hash !== scope.input_hash ||
      revision.hash !== scope.revision_hash ||
      sha(revision.sql) !== scope.revision_hash ||
      project.current_revision_id !== revision.id ||
      project.input_hash !== scope.input_hash ||
      sha(canonical(e.logs)) !== scope.logs_hash ||
      sha(canonical(e)) !== scope.execution_hash
    )
      throw new LocalError('REPAIR_STALE', 409);
    const source = readSource(path('source.sqlite'));
    if (sha(JSON.stringify(source.rows)) !== scope.input_hash)
      throw new LocalError('SOURCE_DATA_CHANGED', 409);
    const metadata = toolSource(scope);
    let output: Record<string, unknown>;
    switch (name) {
      case 'get_execution':
        output = {
          id: e.id,
          status: e.status,
          failed_step: e.failed_step,
          error_code: e.error_code,
          error_message: e.error_message,
          revision_hash: e.revision_hash,
          input_hash: e.input_hash,
        };
        break;
      case 'get_sql':
        output = { file_path: 'task.sql', sql: revision.sql, base_hash: revision.hash };
        break;
      case 'get_schema': {
        const target = new DatabaseSync(path('target.sqlite'), { readOnly: true, timeout: 1000 });
        try {
          output = {
            source: source.schema,
            target: target
              .prepare('PRAGMA table_info(mining_results)')
              .all()
              .map((r) => ({ name: String(r.name), type: String(r.type) })),
            contract,
          };
        } finally {
          target.close();
        }
        break;
      }
      case 'get_logs': {
        // Account for source metadata and the full MCP result, reserving space
        // for the SDK's protocol envelope. No log body is shortened.
        const overhead =
          Buffer.byteLength(
            JSON.stringify({ content: [], structuredContent: { source: metadata, output: {} } }),
          ) + 512;
        output = { ...readLogs(e.logs, args, TOOL_OUTPUT_BYTES - overhead) };
        break;
      }
      case 'get_output_preview':
        output = {
          columns: e.columns,
          rows: e.rows.slice(0, 10),
          validation: e.validation,
          precheck: e.precheck,
        };
        break;
      case 'get_task_contract':
        output = { ...contract };
        break;
    }
    const result = toolResponseSchema(name).parse({ output, source: metadata });
    if (
      Buffer.byteLength(JSON.stringify({ content: [], structuredContent: result })) + 512 >
      TOOL_OUTPUT_BYTES
    )
      throw new LocalError('TOOL_OUTPUT_LIMIT', 409);
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.close();
  }
}
