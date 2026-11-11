#!/usr/bin/env node
// Node's session ingest runtime (src/runtime/memory/lib/session-ingest-runtime.test.mjs): cases 53, 71, 87, 100 (re-ingest, repeats, append after compaction, subset), 111 (durable
// untimestamped high-water saved on a repeat and lifted after a restart) and 134 (excluded and empty messages skipped;
// the embedding flush scoped to the call, then a backlog sweep) from the real `createSessionIngestRuntime`
// (session-ingest-runtime.mjs). The database is the test file's
// in-memory `entries` stand-in behind `db.query`; `flushRawEmbeddings` (memory-cycle.mjs) is replaced at its module boundary
// by a recorder; both record every call in order. The background save and flush are awaited through explicit
// promises that resolve when the product made the call (deadline 30 s), never by a sleep. Date.now() is fixed.
//
//   node --experimental-test-module-mocks benchmarks/rust-core/recorders/record-memory-session-ingest-runtime.mjs --tree <dir>
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mock } from 'node:test';
import { begin, capture, finish, freezeClock, importFrom, exact, within } from './lib/mc-record.mjs';

const ctx = begin();
const CLOCK_MS = 1_800_000_000_000;
freezeClock(CLOCK_MS);
const lib = (rel) => pathToFileURL(join(ctx.tree, 'src/runtime/memory/lib', rel)).href;
const { parseTsToMs } = await importFrom(ctx.tree, 'src/runtime/memory/lib/transcript-ingest.mjs');

const flushes = [];
let onFlush = null;
mock.module(lib('./memory-cycle.mjs'), {
  namedExports: {
    flushRawEmbeddings: async (_db, options) => {
      flushes.push(exact(options));
      onFlush?.();
      return { attempted: 0, embedded: 0 };
    },
  },
});
const { createSessionIngestRuntime } = await importFrom(ctx.tree, 'src/runtime/memory/lib/session-ingest-runtime.mjs');

function store() {
  const entries = new Map();
  const statements = [];
  return {
    entries,
    statements,
    rows: () => [...entries.values()].map((e) => ({ ...e })),
    query: async (sql, params) => {
      statements.push({ sql, params: exact(params) });
      if (sql.includes('MAX(source_turn)')) {
        const turns = [...entries.values()].map((e) => e.source_turn);
        return { rows: [{ max_turn: turns.length ? Math.max(...turns) : 0 }] };
      }
      if (!sql.includes('INSERT INTO entries')) throw new Error(`unexpected query ${sql}`);
      if (entries.has(params[3])) return { rowCount: 0, rows: [] };
      const entry = { id: entries.size + 1, ts: params[0], role: params[1], content: params[2], source_ref: params[3], source_turn: params[5], time_source: params[7] };
      entries.set(entry.source_ref, entry);
      return { rowCount: 1, rows: [{ id: entry.id }] };
    },
  };
}
const msg = (role, content, ts) => (ts ? { role, content, ts } : { role, content });
const createRuntime = (db, durability = {}) => createSessionIngestRuntime({ getDb: () => db, log: () => {}, parseTsToMs, ...durability });

// Waits until the product has made `count` flush calls in total (the background flush and sweep).
const flushed = (count) => (flushes.length >= count ? Promise.resolve() : within(`${count} background flush calls (have ${flushes.length})`, new Promise((resolve) => { onFlush = () => { if (flushes.length >= count) resolve(); }; }), 30_000));
const call = async (runtime, args, extra = {}) => ({ args: exact(args), ...(await capture(() => runtime.ingestSessionMessages(args))), ...extra });

const cases = [];
// Each step's background flushes are awaited by the event that proves them (an ingest that inserted is followed by a scoped flush and a sweep, one that inserted nothing by a sweep).
const settleFlushes = async (steps) => {
  const expected = steps.reduce((n, s) => n + (Number(/inserted=(\d+)/.exec(s.result?.text ?? '')?.[1] ?? 0) > 0 ? 2 : 1), 0);
  if (expected) await flushed(expected);
  return flushes.splice(0);
};
{
  const db = store();
  const runtime = createRuntime(db);
  const messages = [msg('user', 'first question', 1700000000000), msg('assistant', 'first answer', 1700000001000)];
  const steps = [await call(runtime, { sessionId: 's1', messages })];
  steps[0].rows = db.rows();
  steps.push(await call(runtime, { sessionId: 's1', messages }));
  steps[1].rowCount = db.entries.size;
  cases.push({ name: 'a re-ingest of the same array inserts nothing; timestamped rows keep their recorded time (test line 53)', steps, flushes: await settleFlushes(steps), statements: db.statements });
}
{
  const db = store();
  const runtime = createRuntime(db);
  const messages = [msg('user', 'retry please'), msg('assistant', 'done'), msg('user', 'retry please')];
  const steps = [await call(runtime, { sessionId: 's2', messages })];
  steps[0].rows = db.rows();
  steps.push(await call(runtime, { sessionId: 's2', messages: JSON.parse(JSON.stringify(messages)) }, { phase: 'JSON-cloned replay' }));
  steps[1].rowCount = db.entries.size;
  cases.push({ name: 'identical untimestamped turns are distinct rows, and a JSON-cloned replay stays idempotent (test line 71)', steps, flushes: await settleFlushes(steps), statements: db.statements });
}
{
  const db = store();
  const runtime = createRuntime(db);
  const first = msg('user', 'again');
  const second = msg('assistant', 'ok');
  const steps = [await call(runtime, { sessionId: 's3', messages: [first, second] })];
  const appended = msg('user', 'again');
  steps.push(await call(runtime, { sessionId: 's3', messages: [second, appended] }, { phase: 'compaction removed the first copy; the user sends the identical text again' }));
  steps[1].rows = db.rows();
  cases.push({ name: 'after compaction dropped an identical copy, a genuine append still lands above the persisted rows (test line 87)', steps, flushes: await settleFlushes(steps), statements: db.statements });
}
{
  const db = store();
  const runtime = createRuntime(db);
  const messages = Array.from({ length: 6 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `turn ${i}`));
  const steps = [await call(runtime, { sessionId: 's4', messages })];
  const cold = createRuntime(db);
  steps.push(await call(cold, { sessionId: 's4', messages, limit: 2 }, { phase: 'cold runtime, subset re-ingest' }));
  steps[1].rowCount = db.entries.size;
  cases.push({ name: 'a subset re-ingest (limit) reproduces the full-ingest identities (test line 100)', steps, flushes: await settleFlushes(steps), statements: db.statements });
}
{
  const db = store();
  const saved = [];
  let onSaved = null;
  const savedWait = new Promise((resolve) => { onSaved = resolve; });
  const runtime = createRuntime(db, { saveOrdinalHighWater: async (sessionId, snapshot) => { saved.push(exact([sessionId, snapshot])); onSaved(); } });
  const messages = [msg('user', 'ping'), msg('assistant', 'pong'), msg('user', 'ping')];
  const steps = [];
  steps.push(await call(runtime, { sessionId: 's5', messages }));
  await within('the durable high-water save after a repeat appeared', savedWait, 30_000);
  steps[0].savedAfter = [...saved];
  steps[0].rows = db.rows();
  const restarted = createRuntime(db, { loadOrdinalHighWater: async () => JSON.parse(JSON.stringify(saved[0][1])) });
  const survivor = msg('user', 'ping');
  steps.push(await call(restarted, { sessionId: 's5', messages: [survivor] }, { phase: 'restarted runtime, compacted array: the cold replay counts one survivor' }));
  steps[1].rowCount = db.entries.size;
  steps.push(await call(restarted, { sessionId: 's5', messages: [survivor, msg('user', 'ping')] }, { phase: 'warm append after the restart' }));
  steps[2].rowCount = db.entries.size;
  steps[2].rows = db.rows();
  cases.push({ name: 'the durable untimestamped high-water is saved when a repeat appears and lifts a warm append after restart (test line 111)', steps, statements: db.statements, saved });
}
{
  flushes.length = 0;
  const db = store();
  const runtime = createRuntime(db);
  const steps = [];
  steps.push(await call(runtime, { sessionId: 's6', messages: [msg('system', 'hidden'), msg('user', '   '), msg('user', 'visible', 1700000000000), null] }));
  await flushed(2);
  steps[0].flushes = flushes.splice(0);
  onFlush = null;
  steps.push(await call(runtime, { sessionId: 's6', messages: [msg('user', 'later')], embedWait: false }));
  await flushed(2);
  steps[1].flushes = flushes.splice(0);
  steps[1].rows = db.rows();
  cases.push({ name: 'excluded and empty messages are skipped; the flush is scoped to this call and then sweeps the backlog (test line 134)', steps, statements: db.statements });
}

finish(ctx, {
  url: import.meta.url,
  set: 'memory-session-ingest-runtime',
  flags: '--experimental-test-module-mocks ',
  golden: { domain: 'memory-session-ingest-runtime', source: 'src/runtime/memory/lib/session-ingest-runtime.test.mjs', clock: { dateNowMs: CLOCK_MS, reason: 'Date.now() the runtime may read; never advanced' }, cases },
  extra: {
    entry: { runs: 'createSessionIngestRuntime(...).ingestSessionMessages (session-ingest-runtime.mjs) with the real projection, identity hashing and ordinals', notRun: 'PostgreSQL (db.query is the test file\'s in-memory entries stand-in, which only answers MAX(source_turn) and INSERT INTO entries) and the embedding flush (flushRawEmbeddings replaced at its module boundary by a recorder)' },
    replay: "mixdog-services memory/ingest/mod.rs: SessionIngest::ingest_session (:133, pub) with the high-water file (ingest/ordinals.rs ensure_durable_loaded :66, persist_durable :84) and the scoped flush RawEmbedFlush::flush (ingest/embed_flush.rs:114, pub; ids scoped). A replay drives ingest_session over the recorded transcript steps and compares the ordered statements, the stored high-water and the flush calls",
    exclusions: 'none: all six cases of the file are recorded',
    normalised: { clock: 'Date.now() fixed at clock.dateNowMs' },
  },
});
process.exit(0);
