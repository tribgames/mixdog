import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fetchCycle1Rows } from './cycle1-rows.mjs';
import { CYCLE1_SESSION_FORCE_AGE_MS, CYCLE1_SESSION_QUIET_MS, resolveCycle1Plan } from './cycle1-plan.mjs';

const MINUTE = 60_000;
const NOW = 10_000 * MINUTE;

// The fetch SQL runs against a real isolated store; only the PostgreSQL
// spellings without a SQLite equivalent are translated.
function store(t, rows) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(
    `CREATE TABLE entries (id INTEGER PRIMARY KEY, ts INTEGER, role TEXT, content TEXT, session_id TEXT,
       source_ref TEXT, project_id TEXT, chunk_root INTEGER, reviewed_at INTEGER)`
  );
  const insert = sqlite.prepare(
    'INSERT INTO entries (id, ts, role, content, session_id, chunk_root, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const row of rows) {
    insert.run(row.id, row.ts, 'user', `row ${row.id}`, row.session_id, row.chunk_root ?? null, row.reviewed_at ?? null);
  }
  return {
    async query(sql, args = []) {
      const params = {};
      const translated = sql
        .replace(/btrim\(/g, 'trim(')
        .replace(/GREATEST\(/g, 'max(')
        .replace(/::(?:int|bigint)/g, '')
        .replace(/\$(\d+)/g, (_all, number) => {
          params[`p${number}`] = args[Number(number) - 1];
          return `:p${number}`;
        });
      return { rows: sqlite.prepare(translated).all(params) };
    },
  };
}

const rows = [
  // Still being written: newest row inside the quiet window.
  { id: 1, ts: NOW - 30 * MINUTE, session_id: 'active' },
  { id: 2, ts: NOW - 2 * MINUTE, session_id: 'active' },
  // Quiet: every row older than the quiet window.
  { id: 3, ts: NOW - 40 * MINUTE, session_id: 'quiet' },
  { id: 4, ts: NOW - CYCLE1_SESSION_QUIET_MS - MINUTE, session_id: 'quiet' },
  // Quiet pending rows, but a row chunked moments ago proves the session is live.
  { id: 5, ts: NOW - 40 * MINUTE, session_id: 'chunked-active' },
  { id: 6, ts: NOW - MINUTE, session_id: 'chunked-active', chunk_root: 6 },
  // Never pauses: drained once the oldest pending row has waited the force age.
  { id: 7, ts: NOW - CYCLE1_SESSION_FORCE_AGE_MS - MINUTE, session_id: 'long' },
  { id: 8, ts: NOW - MINUTE, session_id: 'long' },
  // Quiet but cooling down after an omitted attempt.
  { id: 9, ts: NOW - 40 * MINUTE, session_id: 'cooling', reviewed_at: NOW - MINUTE },
];

const fetched = async (db, config = {}) => {
  const { rowsDesc } = await fetchCycle1Rows(db, resolveCycle1Plan(config, { preset: 'test' }), NOW);
  return rowsDesc.map((row) => row.id).sort((a, b) => a - b);
};

test('only quiet sessions and sessions past the force age are due', async (t) => {
  assert.deepEqual(await fetched(store(t, rows)), [3, 4, 7, 8]);
});

test('an explicit single-session run bypasses the quiet gate', async (t) => {
  assert.deepEqual(await fetched(store(t, rows), { session_id: 'active' }), [1, 2]);
});

test('a zero quiet window restores immediate chunking', async (t) => {
  assert.deepEqual(await fetched(store(t, rows), { session_quiet_ms: 0 }), [1, 2, 3, 4, 5, 7, 8]);
});
