// The scrub after a sensitive replacement: owed only while session_search.scrub
// holds its row, every step in order, the row cleared last (a kill before that
// leaves the scrub owed for the next open), refused while WAL segments are recycled.
import assert from 'node:assert/strict';
import test from 'node:test';

import { scrubReplacedRows } from './session-search-db.mjs';

function fakeDb({ owed, recycle = 'off' }) {
  const statements = [];
  return {
    statements,
    query: async (sql) => {
      statements.push(sql);
      if (sql.includes('FROM session_search.scrub')) return { rows: owed ? [{ '?column?': 1 }] : [] };
      if (sql.includes("current_setting('wal_recycle')")) return { rows: [{ recycle }] };
      return { rows: [] };
    },
    exec: async (sql) => {
      statements.push(sql);
    },
  };
}

test('an owed scrub rewrites the table, removes the old WAL segments, then clears itself', async () => {
  const db = fakeDb({ owed: true });
  await scrubReplacedRows(db);
  assert.deepEqual(db.statements.slice(2), [
    'VACUUM FULL session_search.messages',
    'SELECT pg_switch_wal()',
    'CHECKPOINT',
    'DELETE FROM session_search.scrub',
  ]);
});

test('nothing runs when no scrub is owed', async () => {
  const db = fakeDb({ owed: false });
  await scrubReplacedRows(db);
  assert.equal(db.statements.length, 1);
});

test('a cluster that recycles WAL segments refuses the scrub and keeps it owed', async () => {
  const db = fakeDb({ owed: true, recycle: 'on' });
  await assert.rejects(scrubReplacedRows(db), /wal_recycle is on/);
  assert.ok(!db.statements.some((sql) => sql.startsWith('DELETE')));
});
