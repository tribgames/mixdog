import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listManagedMemories, formatManagedMemories } from './core-memory-management.mjs';
import { parseMemoryCoreRows } from '../../../tui/app/input-parsers.mjs';
import { createMemoryActionHandlers } from './memory-action-handlers.mjs';

test('standing memory lists only curated records; legacy history stays unchanged', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-project-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectPaths = ['renamed-folder', 'other-folder', 'empty-folder'].map((name) => join(root, name));
  for (const [index, projectId] of ['mixdog', 'other', 'empty'].entries()) {
    mkdirSync(join(projectPaths[index], '.mixdog'), { recursive: true });
    writeFileSync(join(projectPaths[index], '.mixdog', 'project.id'), projectId);
  }
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(`
      CREATE TABLE core_entries (id INTEGER, project_id TEXT, element TEXT, summary TEXT, status TEXT);
      CREATE TABLE entries (id INTEGER, project_id TEXT, core_summary TEXT, status TEXT, core_candidate_status TEXT);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO core_entries VALUES
        (1, 'mixdog', 'Archived', 'Old rule', 'archived'),
        (2, NULL, 'Common', 'Common preference', NULL),
        (3, 'mixdog', 'Active', 'Project preference', 'active'),
        (4, 'other', 'Other', 'Other preference', 'active');
      INSERT INTO entries VALUES (10, 'mixdog', 'Historical summary', 'active', 'promoted');
    `);
    const originals = sqlite.prepare('SELECT * FROM entries').all();
    let indexReads = 0;
    const db = {
      query: async (sql, args = []) => {
        if (sql.includes('pg_advisory_xact_lock')) {
          indexReads++;
          return { rows: [] };
        }
        const statement = sqlite.prepare(sql.replace(/::(?:text|boolean|jsonb)/g, '').replace(/\$(\d+)/g, ':p$1'));
        return {
          rows: statement.all(
            Object.fromEntries(
              args.map((value, i) => [`p${i + 1}`, typeof value === 'boolean' ? Number(value) : value])
            )
          ),
        };
      },
      transaction: async (run) => {
        sqlite.exec('BEGIN');
        try {
          const result = await run(db);
          sqlite.exec('COMMIT');
          return result;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      },
    };
    const first = await listManagedMemories(db, 'mixdog', { limit: 1 });
    assert.deepEqual(
      first.entries.map((row) => row.summary),
      ['Common preference']
    );
    assert.equal(first.nextOffset, 1);
    const second = await listManagedMemories(db, 'mixdog', { limit: 1, offset: first.nextOffset });
    assert.deepEqual(
      second.entries.map((row) => row.summary),
      ['Project preference']
    );
    assert.equal(second.nextOffset, null);
    const full = await listManagedMemories(db, 'mixdog', { include_inactive: true });
    assert.deepEqual(
      full.entries.map((row) => row.record_id),
      [2, 1, 3]
    );
    assert.equal(Boolean(full.entries[1].injection_enabled), false);
    const scoped = await listManagedMemories(db, 'mixdog', { scope_only: true });
    const ui = parseMemoryCoreRows(formatManagedMemories(scoped))[0];
    assert.equal(ui._id, 1);
    assert.equal(ui._projectId, 'mixdog');
    assert.equal(ui._summary, 'Project preference');
    assert.equal(ui._indexRevision, scoped.entries[0].index_revision);
    const { handleMemoryAction } = createMemoryActionHandlers({
      getDb: () => db, dataDir: root, readMainConfig: () => ({}),
    });
    indexReads = 0;
    const batch = await handleMemoryAction({
      action: 'core', op: 'list', project_id: '*', project_paths: projectPaths, format: 'json', limit: 100,
    });
    assert.equal(indexReads, 1, 'all project rows share one index synchronization');
    const page = JSON.parse(batch.text);
    assert.deepEqual(page.projectScopes, [
      { path: projectPaths[0], projectId: 'mixdog' },
      { path: projectPaths[1], projectId: 'other' },
      { path: projectPaths[2], projectId: 'empty' },
    ]);
    assert.deepEqual(page.entries.map(({ project_id, id, summary }) => [project_id, id, summary]), [
      [null, 1, 'Common preference'],
      ['mixdog', 1, 'Project preference'],
      ['other', 1, 'Other preference'],
    ]);
    assert.equal(page.nextOffset, null);
    for (const project_paths of ['not-an-array', [null], ['']]) {
      await assert.rejects(listManagedMemories(db, '*', { project_paths }), /project_paths requires/);
    }
    await assert.rejects(listManagedMemories(db, 'mixdog', { project_paths: projectPaths }), /all-project list/);
    assert.deepEqual(sqlite.prepare('SELECT * FROM entries').all(), originals);
    await assert.rejects(listManagedMemories(db, '*', { include_inactive: 'false' }), /must be a boolean/);
  } finally {
    sqlite.close();
  }
});

test('retired maintenance and candidate operations cannot mutate memory', async () => {
  const { handleMemoryAction } = createMemoryActionHandlers({
    getDb: () => ({
      query() {
        throw new Error('unexpected database access');
      },
    }),
    readMainConfig: () => ({}),
    dataDir: '/test',
  });
  for (const op of ['candidates', 'promote', 'dismiss', 'exclude']) {
    const result = await handleMemoryAction({ action: 'core', op, id: 1 });
    assert.equal(result.isError, true);
    assert.match(result.text, /add \| edit \| delete \| list/);
  }
  for (const action of ['cycle3', 'retro_eval_active']) {
    const result = await handleMemoryAction({ action });
    assert.equal(result.isError, true);
    assert.match(result.text, /unknown memory action/);
  }
});
