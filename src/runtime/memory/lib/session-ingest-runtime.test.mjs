import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { parseTsToMs } from './transcript-ingest.mjs';

// ingest_session against an in-memory entries table: idempotent replays, the
// untimestamped-repeat ordinals that keep genuine repeats distinct, the durable
// high-water after eviction, and the post-ingest embedding flush scoping.

const flushes = [];
mock.module('./memory-cycle.mjs', {
  namedExports: {
    flushRawEmbeddings: async (_db, options) => {
      flushes.push(options);
      return { attempted: 0, embedded: 0 };
    },
  },
});
const { createSessionIngestRuntime } = await import('./session-ingest-runtime.mjs');

function store() {
  const entries = new Map();
  return {
    entries,
    rows: () => [...entries.values()],
    query: async (sql, params) => {
      if (sql.includes('MAX(source_turn)')) {
        const turns = [...entries.values()].map((e) => e.source_turn);
        return { rows: [{ max_turn: turns.length ? Math.max(...turns) : 0 }] };
      }
      if (!sql.includes('INSERT INTO entries')) throw new Error(`unexpected query ${sql}`);
      if (entries.has(params[3])) return { rowCount: 0, rows: [] };
      const entry = {
        id: entries.size + 1,
        ts: params[0],
        role: params[1],
        content: params[2],
        source_ref: params[3],
        source_turn: params[5],
        time_source: params[7],
      };
      entries.set(entry.source_ref, entry);
      return { rowCount: 1, rows: [{ id: entry.id }] };
    },
  };
}

const msg = (role, content, ts) => (ts ? { role, content, ts } : { role, content });

function createRuntime(db, durability = {}) {
  return createSessionIngestRuntime({ getDb: () => db, log: () => {}, parseTsToMs, ...durability });
}

test('a re-ingest of the same array inserts nothing; timestamped rows keep their recorded time', async () => {
  const db = store();
  const runtime = createRuntime(db);
  const messages = [msg('user', 'first question', 1700000000000), msg('assistant', 'first answer', 1700000001000)];
  const first = await runtime.ingestSessionMessages({ sessionId: 's1', messages });
  assert.equal(first.text, 'ingest_session: considered=2 inserted=2 session=s1');
  assert.deepEqual(
    db.rows().map((r) => [r.role, r.source_turn, r.time_source, r.ts]),
    [
      ['user', 1, 'recorded', 1700000000000],
      ['assistant', 2, 'recorded', 1700000001000],
    ]
  );
  const again = await runtime.ingestSessionMessages({ sessionId: 's1', messages });
  assert.equal(again.text, 'ingest_session: considered=2 inserted=0 session=s1');
  assert.equal(db.entries.size, 2);
});

test('identical untimestamped turns are distinct rows, and a JSON-cloned replay stays idempotent', async () => {
  const db = store();
  const runtime = createRuntime(db);
  const messages = [msg('user', 'retry please'), msg('assistant', 'done'), msg('user', 'retry please')];
  await runtime.ingestSessionMessages({ sessionId: 's2', messages });
  assert.equal(db.entries.size, 3, 'the repeated untimestamped turn is its own row');
  assert.deepEqual(
    db.rows().map((r) => r.source_turn),
    [1, 2, 3]
  );
  const cloned = JSON.parse(JSON.stringify(messages));
  const replay = await runtime.ingestSessionMessages({ sessionId: 's2', messages: cloned });
  assert.equal(replay.text, 'ingest_session: considered=3 inserted=0 session=s2');
  assert.equal(db.entries.size, 3);
});

test('after compaction dropped an identical copy, a genuine append still lands above the persisted rows', async () => {
  const db = store();
  const runtime = createRuntime(db);
  const first = msg('user', 'again');
  const second = msg('assistant', 'ok');
  await runtime.ingestSessionMessages({ sessionId: 's3', messages: [first, second] });
  // Compaction removed `first`; the user then sends the identical text again.
  const appended = msg('user', 'again');
  await runtime.ingestSessionMessages({ sessionId: 's3', messages: [second, appended] });
  assert.equal(db.entries.size, 3, 'the new identical turn is not collapsed onto the compacted copy');
  assert.equal(db.rows().at(-1).source_turn, 3);
});

test('a subset re-ingest (limit) reproduces the full-ingest identities', async () => {
  const db = store();
  const runtime = createRuntime(db);
  const messages = Array.from({ length: 6 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `turn ${i}`));
  await runtime.ingestSessionMessages({ sessionId: 's4', messages });
  const cold = createRuntime(db);
  const subset = await cold.ingestSessionMessages({ sessionId: 's4', messages, limit: 2 });
  assert.equal(subset.text, 'ingest_session: considered=2 inserted=0 session=s4');
  assert.equal(db.entries.size, 6);
});

test('the durable untimestamped high-water is saved when a repeat appears and lifts a warm append after restart', async () => {
  const db = store();
  const saved = [];
  const runtime = createRuntime(db, {
    saveOrdinalHighWater: async (sessionId, snapshot) => saved.push([sessionId, snapshot]),
  });
  const messages = [msg('user', 'ping'), msg('assistant', 'pong'), msg('user', 'ping')];
  await runtime.ingestSessionMessages({ sessionId: 's5', messages });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved.length, 1);
  assert.equal(saved[0][0], 's5');
  assert.deepEqual(Object.values(saved[0][1]), [2], 'next free ordinal for the repeated identity');

  // Restart with a compacted array: the cold replay counts one survivor, but
  // the durable map remembers two persisted copies, so a warm append lands above.
  const restarted = createRuntime(db, { loadOrdinalHighWater: async () => saved[0][1] });
  const survivor = msg('user', 'ping');
  await restarted.ingestSessionMessages({ sessionId: 's5', messages: [survivor] });
  assert.equal(db.entries.size, 3, 'the cold replay reproduces a persisted row');
  await restarted.ingestSessionMessages({ sessionId: 's5', messages: [survivor, msg('user', 'ping')] });
  assert.equal(db.entries.size, 4, 'the warm append is a new row above the persisted copies');
});

test('excluded and empty messages are skipped; the flush is scoped to this call and then sweeps the backlog', async () => {
  flushes.length = 0;
  const db = store();
  const runtime = createRuntime(db);
  const result = await runtime.ingestSessionMessages({
    sessionId: 's6',
    messages: [msg('system', 'hidden'), msg('user', '   '), msg('user', 'visible', 1700000000000), null],
  });
  assert.equal(result.text, 'ingest_session: considered=1 inserted=1 session=s6');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(flushes, [{ limit: 200, ids: [1] }, { limit: 200 }]);

  flushes.length = 0;
  await runtime.ingestSessionMessages({ sessionId: 's6', messages: [msg('user', 'later')], embedWait: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(flushes, [{ limit: 200, ids: [2] }, { limit: 200 }]);
});
