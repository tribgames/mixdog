#!/usr/bin/env node
// A recall while the embedding model is still loading, answered by Node's public memory tool: `init()` of
// src/runtime/memory/index.mjs over a throwaway profile (its own PostgreSQL), one entry written by its `appendEntry`, then
// `handleToolCall('recall', ...)`, the path through `embedRecallQuery` (recall-embedding-readiness.mjs:28) and its
// `MIXDOG_RECALL_COLD_EMBED_WAIT_MS` fallback (3 s). The one seam is the embedding worker thread (`node:worker_threads`
// `Worker`, the boundary the Rust core calls `EmbeddingProvider`'s load): every message the provider posts is recorded,
// and its `warmup` is answered only when the recorder releases it. Steps:
//   1. recall while the load is held: the answer, the wait it armed, and that the load is still pending after it;
//   2. the load ends (the worker answers the held warmup with an error) and the next recall answers.
// Recorded per step: the tool result, the wait the recall armed, whether the load was still pending when it answered,
// and the loads it started. The entries table is recorded as the replay's seed. The 3 s wait is real time here; nothing
// else waits on time.
//
//   node --experimental-test-module-mocks benchmarks/rust-core/recorders/record-memory-cold-recall.mjs --tree <dir>
import workerThreads from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { begin, capture, finish, freezeClock, importFrom } from './lib/mc-record.mjs';

const ctx = begin();
const CLOCK_MS = Date.parse('2025-06-01T00:00:00Z');
freezeClock(CLOCK_MS);
const SCRATCH = process.env.MIXDOG_RECORDER_SCRATCH ?? 'D:/mixdog-build/tmp/w23/rec';
const dataDir = mkdtempSync(join(SCRATCH, 'cold-')).replaceAll('\\', '/');
Object.assign(process.env, { MIXDOG_DATA_DIR: dataDir, MIXDOG_HOME: dataDir, MIXDOG_MEMORY_DISABLE_LLM_WORKER: '1' });

// The model's load: held until `endLoad`, after which every load fails at once.
const posted = [];
const held = [];
let loadEnded = false;
let worker = null;
const fail = (id) => worker.emit('message', { type: 'error', id, message: 'model load failed' });
class EmbeddingWorker extends EventEmitter {
  constructor() {
    super();
    worker = this;
  }
  postMessage(message) {
    posted.push(message);
    if (message.action !== 'warmup') return;
    if (loadEnded) queueMicrotask(() => fail(message.id));
    else held.push(message.id);
  }
  terminate() {
    return Promise.resolve(0);
  }
}
const endLoad = () => {
  loadEnded = true;
  for (const id of held.splice(0)) fail(id);
};
workerThreads.Worker = EmbeddingWorker;
syncBuiltinESMExports();

// The waits the recall arms, by delay.
const armed = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
  armed.push(ms ?? 0);
  return realSetTimeout(fn, ms, ...rest);
};

const memory = await importFrom(ctx.tree, 'src/runtime/memory/index.mjs');
const pgAdapter = await importFrom(ctx.tree, 'src/runtime/memory/lib/pg/adapter.mjs');
const { openDatabase } = await importFrom(ctx.tree, 'src/runtime/memory/lib/memory.mjs');
await memory.init();
// The seed's source reference is given (declared in the manifest's inputValues).
const SOURCE_REF = 'manual:1748736000000-57380';
const appended = await memory.appendEntry({ role: 'user', content: 'the kettle descaling schedule is every second sunday', sessionId: 'sess-cold', sourceRef: SOURCE_REF });

const step = async (label, args) => {
  const at = { posted: posted.length };
  armed.length = 0;
  const out = await capture(() => memory.handleToolCall('recall', args));
  // The first timer the recall arms is `waitForWarmup`'s (the others are the database pool's).
  return { label, args, ...out, coldWaitMs: armed[0], loadPendingAfterAnswer: held.length > 0, loadsStarted: posted.slice(at.posted).filter((m) => m.action === 'warmup').length };
};

const steps = [];
steps.push(await step('recall while the model is still loading', { query: 'kettle descaling' }));
endLoad();
await new Promise((resolve) => setImmediate(resolve));
steps.push(await step('recall after the load ended', { query: 'kettle descaling' }));

const db = await openDatabase(dataDir);
const { rows: entries } = await db.query('SELECT to_jsonb(e) AS row FROM entries e ORDER BY id');

finish(ctx, {
  url: import.meta.url,
  set: 'memory-cold-recall',
  flags: '--experimental-test-module-mocks ',
  golden: { clockMs: CLOCK_MS, appended, entries: entries.map((r) => r.row), steps },
  extra: {
    entry: 'src/runtime/memory/index.mjs init(), appendEntry(), handleToolCall("recall", args)',
    replay: 'native/core/crates/mixdog-services/src/memory/tests/cold_recall.rs',
    exclusions: 'the embedding worker thread is a recorded seam (its warmup held, then answered with an error); no model is loaded',
    normalised: 'none',
    inputValues: [
      {
        input: 'appendEntry({ sourceRef }) of the seed entry',
        value: SOURCE_REF,
        reason:
          "supplied by the recorder through the argument Node accepts (src/runtime/memory/index.mjs:605 data.sourceRef); Node's default `manual:${Date.now()}-${process.pid}` carries the recorder's process id, which differs per run, so two recordings would not be byte-identical. The value has the default's form at the frozen clock",
      },
    ],
  },
});
await memory.stop().catch(() => {});
await pgAdapter.shutdownOwnedPg({ timeoutMs: 20_000 }).catch(() => {});
process.exit(0);
