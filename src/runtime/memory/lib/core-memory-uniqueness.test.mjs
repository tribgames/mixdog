import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ensureCoreKeyIndex } from './core-memory-uniqueness.mjs';

test('schema startup preserves conflicting curated records rather than choosing a winner', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(`CREATE TABLE core_entries(id INTEGER,project_id TEXT,element TEXT,summary TEXT,agent_id TEXT);
      INSERT INTO core_entries VALUES(1,NULL,'key','First approved preference',NULL),
        (2,NULL,'key','Second approved preference',NULL),(3,NULL,'key','An agent may share the key','reviewer')`);
    const before = sqlite.prepare('SELECT * FROM core_entries ORDER BY id').all();
    const executed = [];
    const db = {
      query: async (sql) => ({ rows: sqlite.prepare(sql).all() }),
      exec: async (sql) => {
        executed.push(sql);
      },
    };
    assert.equal(await ensureCoreKeyIndex(db), false);
    assert.deepEqual(executed, []);
    assert.deepEqual(sqlite.prepare('SELECT * FROM core_entries ORDER BY id').all(), before);
    sqlite.exec(`UPDATE core_entries SET element='resolved' WHERE id=2`);
    assert.equal(await ensureCoreKeyIndex(db), true);
    // The pool key replaces the project key.
    assert.match(executed[0], /core_entries_unique_pool_elem ON core_entries \(project_id, agent_id, element\)/);
    assert.match(executed[1], /DROP INDEX IF EXISTS core_entries_unique_proj_elem/);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM core_entries').get().n, 3);
  } finally {
    sqlite.close();
  }
});

test('a racing unique-key conflict is non-destructive, but other schema failures propagate', async () => {
  const db = {
    query: async () => ({ rows: [] }),
    exec: async () => {
      throw Object.assign(new Error('conflict'), { code: '23505' });
    },
  };
  assert.equal(await ensureCoreKeyIndex(db), false);
  db.exec = async () => {
    throw new Error('permission denied');
  };
  await assert.rejects(ensureCoreKeyIndex(db), /permission denied/);
});
