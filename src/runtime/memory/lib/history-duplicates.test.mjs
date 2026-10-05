import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { buildRecallScopeFilter } from './memory-recall-scope-filter.mjs';
import { retrieveEntries } from './memory-retrievers.mjs';
import { makeChunkQuality, assessChunkQuality } from './memory-chunk-quality.mjs';
import { collapseHistoryDuplicates } from './history-duplicates.mjs';
import { searchRelevantHybrid, preferLatestConceptRows } from './memory-recall-store.mjs';

// Persisted aliases are fixture data: recall reads these relationships, and
// nothing generates new ones.
function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE entries (
      id INTEGER PRIMARY KEY, ts INTEGER, project_id TEXT, summary TEXT, content TEXT, element TEXT,
      is_root INTEGER, chunk_root INTEGER, status TEXT,
      concept_id INTEGER, supersedes_id INTEGER,
      role TEXT, source_ref TEXT, session_id TEXT, source_turn INTEGER, time_source TEXT,
      category TEXT, score REAL, last_seen_at INTEGER,
      duplicate_of INTEGER REFERENCES entries(id) ON DELETE SET NULL, chunk_quality TEXT
    );
    INSERT INTO entries(id,ts,project_id,summary,content,element,is_root,chunk_root,status,duplicate_of) VALUES
      (1,100,'project','Original summary','Original request','subject',1,1,'archived',NULL),
      (2,200,'project','Current summary','Current response','subject',1,2,'pending',NULL),
      (3,110,'project',NULL,'Original follow-up',NULL,0,1,'pending',NULL),
      (4,300,'other','Other project','Private request','subject',1,4,'active',NULL);
    UPDATE entries SET duplicate_of=2 WHERE id=1;
  `);
  const db = {
    async query(sql, args = []) {
      if (sql.startsWith('SET LOCAL')) return { rows: [] };
      // The isolated PostgreSQL suite covers actual vector/FTS candidate SQL.
      if (sql.includes('combined AS (')) {
        const slots = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
        assert.equal(Math.max(...slots), args.length);
        return {
          rows: sqlite
            .prepare('SELECT * FROM entries WHERE is_root=1 ORDER BY id')
            .all()
            .map((row, index) => ({ ...row, sparse_rank: index + 1, sparse_lex: 1 })),
        };
      }
      const params = {};
      let translated = sql.replace(/(\w+) = ANY\(\$(\d+)::bigint\[\]\)/g, (_all, column, number) => {
        const names = args[Number(number) - 1].map((value, i) => {
          const name = `a${number}_${i}`;
          params[name] = value;
          return `:${name}`;
        });
        return `${column} IN (${names.join(', ')})`;
      });
      translated = translated.replace(/::(?:text|boolean|jsonb|bigint)/g, '').replace(/\$(\d+)/g, (_all, number) => {
        params[`p${number}`] = args[Number(number) - 1];
        return `:p${number}`;
      });
      return { rows: sqlite.prepare(translated).all(params) };
    },
    async transaction(run) {
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
  return { sqlite, db, rows: () => sqlite.prepare('SELECT * FROM entries ORDER BY id').all() };
}

test('records of every status are searchable and stored aliases stay read-only', async (t) => {
  const f = fixture(t);
  const before = f.rows();
  const filter = buildRecallScopeFilter(1, { projectScope: 'project' });
  const matches = await f.db.query(`SELECT id FROM entries WHERE 1=1 ${filter.clause} ORDER BY id`, filter.params);
  assert.deepEqual(
    matches.rows.map((row) => row.id),
    [1, 2, 3]
  );
  assert.deepEqual(
    (await retrieveEntries(f.db, { projectScope: 'project', sort: 'date' })).map((row) => row.id),
    [2]
  );
  assert.deepEqual(f.rows(), before);
});

for (const secondSession of ['session-a', 'session-b']) {
  test(`stored aliases keep Cycle 1 summaries reusable (${secondSession})`, async (t) => {
    const f = fixture(t);
    f.sqlite
      .prepare('UPDATE entries SET session_id=?,role=?,content=? WHERE id IN (1,3)')
      .run('session-a', 'user', 'The original request and its exact conditions. '.repeat(20));
    f.sqlite
      .prepare('UPDATE entries SET session_id=?,role=?,content=? WHERE id=2')
      .run(secondSession, 'assistant', 'The same request remains pending, with its conditions. '.repeat(20));
    for (const id of [1, 2]) {
      const root = f.rows().find((row) => row.id === id);
      const members = f.rows().filter((row) => row.chunk_root === id);
      root.chunk_quality = makeChunkQuality(root.summary, members);
      const result = assessChunkQuality(root, members);
      assert.equal(result.usable, true, result.reasons.join(', '));
    }
    assert.deepEqual(
      f.rows().map((row) => row.chunk_root),
      [1, 2, 1, 4]
    );
  });
}

test('duplicate representatives collapse only inside the requested history window and project', async (t) => {
  const f = fixture(t);
  const common = { projectScope: 'project', sort: 'date' };
  assert.deepEqual(
    (await retrieveEntries(f.db, common)).map((row) => row.id),
    [2]
  );
  assert.deepEqual(
    (await retrieveEntries(f.db, { ...common, ts_to: 150 })).map((row) => row.id),
    [1]
  );
  assert.equal(f.sqlite.prepare('SELECT content FROM entries WHERE id=1').get().content, 'Original request');
  const [old, current] = f.rows();
  assert.deepEqual(
    collapseHistoryDuplicates([old, current]).map((row) => row.id),
    [2]
  );
  assert.deepEqual(
    collapseHistoryDuplicates([old]).map((row) => row.id),
    [1]
  );
  assert.deepEqual(
    collapseHistoryDuplicates([old, { ...current, project_id: 'other' }]).map((row) => row.id),
    [1, 2]
  );
  assert.deepEqual(
    (await searchRelevantHybrid(f.db, 'request', common)).map((row) => row.id),
    [2]
  );
  assert.deepEqual(
    (await searchRelevantHybrid(f.db, 'request', { ...common, ts_to: 150 })).map((row) => row.id),
    [1]
  );
});

test('deleting an old alias representative preserves the original chunks', async (t) => {
  const f = fixture(t);
  f.sqlite.exec('DELETE FROM entries WHERE id=2');
  assert.equal(f.rows()[0].duplicate_of, null);
  assert.deepEqual(
    f.rows().map((row) => row.chunk_root),
    [1, 1, 4]
  );
  assert.deepEqual(
    (await retrieveEntries(f.db, { projectScope: 'project', sort: 'date' })).map((row) => row.id),
    [1]
  );
});

test('duplicates do not consume hybrid output slots or browse-page offsets', async (t) => {
  const f = fixture(t);
  f.sqlite.exec('UPDATE entries SET score=5-id');
  const scope = { projectScope: 'all' };
  const original = f.rows();
  assert.deepEqual(
    (await searchRelevantHybrid(f.db, 'request', { ...scope, limit: 2 })).map((row) => row.id),
    [2, 4]
  );
  assert.deepEqual(
    (await searchRelevantHybrid(f.db, 'request', { ...scope, limit: 1 })).map((row) => row.id),
    [2]
  );
  assert.deepEqual(
    (await retrieveEntries(f.db, { ...scope, limit: 2 })).map((row) => row.id),
    [2, 4]
  );
  const pages = [];
  for (let offset = 0; offset < 3; offset++) {
    pages.push((await retrieveEntries(f.db, { ...scope, limit: 1, offset })).map((row) => row.id));
  }
  assert.deepEqual(pages, [[2], [4], []]);
  assert.deepEqual(f.rows(), original);
});

test('a long duplicate prefix cannot starve distinct results or repeat later pages', async (t) => {
  const f = fixture(t);
  f.sqlite.exec('UPDATE entries SET score=5-id');
  const insert =
    f.sqlite.prepare(`INSERT INTO entries(id,ts,project_id,summary,content,is_root,chunk_root,duplicate_of,score)
    VALUES (?,50,'project','Same account','Original duplicate source',1,?,2,100)`);
  for (let id = 5; id <= 30; id++) insert.run(id, id);
  const scope = { projectScope: 'all', limit: 2 };
  assert.deepEqual(
    (await retrieveEntries(f.db, scope)).map((row) => row.id),
    [2, 4]
  );
  assert.deepEqual(await retrieveEntries(f.db, { ...scope, offset: 2 }), []);
  assert.deepEqual(
    (await searchRelevantHybrid(f.db, 'request', scope)).map((row) => row.id),
    [2, 4]
  );
});

test('paging keeps an alias whose representative is outside the requested session', async (t) => {
  const f = fixture(t);
  f.sqlite.exec(`UPDATE entries SET session_id='older' WHERE id IN (1,3);
    UPDATE entries SET session_id='newer' WHERE id=2`);
  const scope = { projectScope: 'project', limit: 1, session_id: 'older' };
  assert.deepEqual(
    (await retrieveEntries(f.db, scope)).map((row) => row.id),
    [1]
  );
  assert.deepEqual(await retrieveEntries(f.db, { ...scope, offset: 1 }), []);
});

test('hybrid member expansion reads only selected distinct roots', async (t) => {
  const f = fixture(t);
  f.sqlite.exec(`INSERT INTO entries(id,ts,project_id,content,is_root,chunk_root)
    VALUES (5,210,'project','Full selected-member source',0,2)`);
  const expanded = [];
  const query = f.db.query;
  f.db.query = async (sql, args = []) => {
    if (sql.includes('WHERE chunk_root = ANY')) expanded.push(args[0]);
    return query(sql, args);
  };
  const rows = await searchRelevantHybrid(f.db, 'request', { projectScope: 'all', limit: 1, includeMembers: true });
  assert.deepEqual(
    rows.map((row) => row.id),
    [2]
  );
  assert.deepEqual(expanded, [[2]]);
  assert.deepEqual(
    rows[0].members.map((row) => row.content),
    ['Full selected-member source']
  );
});

test('previously stored lineage still selects the newer conclusion without a reviewer', () => {
  const old = { id: 1, ts: 100, concept_ids: [1], summary: 'Old conclusion' };
  const latest = { id: 2, ts: 200, matched_concept_id: 1, supersedes_id: 1, summary: 'Correction' };
  assert.deepEqual(preferLatestConceptRows([old], [latest]), [latest]);
  assert.deepEqual(preferLatestConceptRows([old], []), [old]);
  assert.deepEqual(old, { id: 1, ts: 100, concept_ids: [1], summary: 'Old conclusion' });
});
