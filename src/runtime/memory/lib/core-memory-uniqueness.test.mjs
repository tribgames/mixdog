import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ensureCoreKeyIndex } from './core-memory-uniqueness.mjs';

test('schema startup preserves conflicting curated records rather than choosing a winner', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(`CREATE TABLE core_entries(id INTEGER,project_id TEXT,element TEXT,summary TEXT);
      INSERT INTO core_entries VALUES(1,NULL,'key','First approved preference'),(2,NULL,'key','Second approved preference')`);
    const before = sqlite.prepare('SELECT * FROM core_entries ORDER BY id').all();
    let created = 0;
    const db = {
      query: async (sql) => ({ rows: sqlite.prepare(sql).all() }),
      exec: async () => {
        created++;
      },
    };
    assert.equal(await ensureCoreKeyIndex(db), false);
    assert.equal(created, 0);
    assert.deepEqual(sqlite.prepare('SELECT * FROM core_entries ORDER BY id').all(), before);
    sqlite.exec(`UPDATE core_entries SET element='resolved' WHERE id=2`);
    assert.equal(await ensureCoreKeyIndex(db), true);
    assert.equal(created, 1);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM core_entries').get().n, 2);
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
