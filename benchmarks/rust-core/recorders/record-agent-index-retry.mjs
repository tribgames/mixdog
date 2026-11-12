#!/usr/bin/env node
// How the agent index write queue (index-write-queue.mjs) retries a write its store refuses, on real Node: the real
// `createIndexWriteQueue` over a store (`rewrite`, the call that builds the document persisted) that throws for its first N
// attempts and then recovers, with setTimeout and Date mocked (node:test `mock.timers`; setImmediate and file I/O stay real).
// The clock moves only by an explicit tick to the next timer the queue armed (`setTimeout` is wrapped to log what was armed).
// Recorded per scenario: the elapsed ms of every persist attempt, the delays the queue slept or armed, when the flush
// settled and how, and whether the row reached the file / is still unpersisted.
//
//   node benchmarks/rust-core/recorders/record-agent-index-retry.mjs --tree <exact export of b6f10295a>
// Output: native/core/fixtures/agent-index-retry/golden.json
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { recorderProvenance } from './lib/provenance.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-agent-index-retry.mjs';
const T0 = 1_793_923_200_000;
const FOREVER = Number.POSITIVE_INFINITY;

const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);
const root = mkdtempSync(join(tmpdir(), 'mixdog-index-retry-'));
delete process.env.NODE_TEST_CONTEXT;
const armed = new Map(); // timer handle -> { at, delay }
const delays = [];
// A fresh mocked clock at T0 for each scenario; setTimeout is wrapped to log what the queue arms.
function startClock() {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  const mockedSetTimeout = globalThis.setTimeout;
  const mockedClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => {
    const handle = mockedSetTimeout(fn, ms, ...args);
    armed.set(handle, { at: Date.now() - T0 + ms, delay: ms });
    delays.push(ms);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    armed.delete(handle);
    return mockedClearTimeout(handle);
  };
}
function stopClock() {
  mock.timers.reset();
  armed.clear();
  delays.length = 0;
}
const silent = process.stderr.write.bind(process.stderr);
const queueReports = [];
process.stderr.write = (text, ...rest) => {
  if (String(text).startsWith('[index-write]')) {
    queueReports.push(String(text));
    return true;
  }
  return silent(text, ...rest);
};

const { createIndexWriteQueue, flushAllIndexWrites } = await importFrom(tree, 'src/session-runtime/services/agent-tool/index-write-queue.mjs');

const elapsed = () => Date.now() - T0;
const turn = () => new Promise((resolve) => setImmediate(resolve));
// Real file I/O and promise hops of the persist in flight finish within these turns.
async function quiesce(done = () => false) {
  for (let i = 0; i < 20000 && !done(); i += 1) {
    await turn();
    await stat(root);
  }
}

function scenario(name, failures, run) {
  return { name, failures, run };
}

async function play({ name, failures, run }) {
  const file = join(root, `${name}.json`);
  let left = failures;
  let building = false;
  const attempts = [];
  const queue = createIndexWriteQueue({
    file,
    readDoc: () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { rows: {} }),
    rewrite: (cur, mutator) => {
      const rows = new Map(Object.entries((cur ?? { rows: {} }).rows));
      mutator(rows);
      if (!building) {
        attempts.push(elapsed());
        if (left > 0) {
          left -= 1;
          throw new Error('store refused');
        }
      }
      return { rows: Object.fromEntries(rows) };
    },
  });
  const ctx = {
    queue,
    settle: async (promise) => {
      const state = { at: null, ok: null, error: null };
      promise.then(
        () => Object.assign(state, { at: elapsed(), ok: true }),
        (error) => Object.assign(state, { at: elapsed(), ok: false, error: error.message }),
      );
      for (let guard = 0; state.ok === null; guard += 1) {
        if (guard > 40) throw new Error(`${name}: the flush did not settle`);
        await quiesce(() => state.ok !== null);
        if (state.ok !== null) break;
        const next = Math.min(...[...armed.values()].map((timer) => timer.at));
        if (!Number.isFinite(next)) throw new Error(`${name}: the flush neither settled nor armed a timer`);
        mock.timers.tick(next - elapsed());
        for (const [handle, timer] of armed) if (timer.at <= elapsed()) armed.delete(handle);
      }
      return state;
    },
    set recover(value) {
      left = value;
    },
    afterFailure: () => Math.max(...delays),
    advance: async (ms) => {
      mock.timers.tick(ms);
      for (const [handle, timer] of armed) if (timer.at <= elapsed()) armed.delete(handle);
      await quiesce();
    },
    file: () => (existsSync(file) ? Object.keys(JSON.parse(readFileSync(file, 'utf8')).rows) : []),
  };
  startClock();
  building = true;
  const wrote = queue.write((rows) => rows.set('sess_row', { status: 'running' }));
  building = false;
  if (!wrote) throw new Error(`${name}: the queue refused the write`);
  const outcome = await run(ctx);
  await quiesce();
  const result = { name, failures: failures === FOREVER ? 'always' : failures, attempts: [...attempts], delays: [...delays], ...outcome, failureReports: queueReports.length, indexed: ctx.file(), unpersisted: queue.hasUnpersisted() };
  // Not recorded: the queue recovers and settles, so no later scenario's drain sees it.
  left = 0;
  await ctx.settle(queue.flush());
  stopClock();
  queueReports.length = 0;
  return result;
}

const scenarios = [
  scenario('recovers_on_the_second_attempt', 1, async (c) => ({ flush: await c.settle(c.queue.flush()) })),
  scenario('recovers_on_the_last_attempt', 3, async (c) => ({ flush: await c.settle(c.queue.flush()) })),
  scenario('fails_after_four_attempts', FOREVER, async (c) => ({ flush: await c.settle(c.queue.flush()) })),
  scenario('a_later_flush_retries_the_kept_batch', 4, async (c) => {
    const first = await c.settle(c.queue.flush());
    return { flush: first, later: await c.settle(c.queue.flush()) };
  }),
  scenario('the_retry_timer_retries_the_kept_batch', 4, async (c) => {
    const first = await c.settle(c.queue.flush());
    const retryAfter = c.afterFailure();
    await c.advance(retryAfter);
    return { flush: first, retryAfter, retriedAt: c.queue.hasUnpersisted() ? null : elapsed() };
  }),
  scenario('the_stop_drain_with_a_batch_still_failing', FOREVER, async (c) => {
    const drain = await c.settle(flushAllIndexWrites());
    c.recover = 0;
    return { flush: drain, laterDrain: await c.settle(flushAllIndexWrites()) };
  }),
];

const played = [];
for (const item of scenarios) played.push(await play(item));
process.stderr.write = silent;
rmSync(root, { recursive: true, force: true });

const finalOut = join(FIXTURES_ROOT, 'agent-index-retry');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'when the agent index write queue retries a write its store refuses (ms from the write, on a clock that moves only to the next armed timer)',
  t0: T0,
  scenarios: played,
});
writeSetManifest(out, {
  set: 'agent-index-retry',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    syntheticInputs: [
      `node:test mock.timers on setTimeout and Date from ${T0}; setImmediate and file I/O real`,
      'one createIndexWriteQueue over a JSON file whose rewrite throws for its first N persist attempts, then recovers',
    ],
    keptWhole: 'per scenario: every persist attempt time, every delay armed, each flush outcome and time, the rows in the file, and whether the queue still holds unpersisted writes',
  },
});
commitStage(out, finalOut);
console.log(JSON.stringify(played));
process.exit(0);
