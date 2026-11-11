#!/usr/bin/env node
// Node's recall embedding readiness (src/runtime/memory/lib/recall-embedding-readiness.test.mjs): cases 8 (ready recall
// embeds at once as a query), 31 (cold recall waits for warmup and keeps dense retrieval), 70 (warmup failure keeps the
// lexical fallback and is reported) and 90 (abort without waiting for the timeout) from the real `embedRecallQuery`
// (recall-embedding-readiness.mjs), plus further shapes (empty query, warmup unavailable, already-aborted signal, a
// warmup that is slow to settle but beats the wait). Case 47 (the bounded wait that falls back while warmup
// continues) is recorded by branch gaps-memory-channels and not recorded again. The embedder, readiness probes and warmup
// are scripted endpoints that log every call; the wait timer is recorded as armed (delay) and cleared, never fired (every
// case here settles before the timer could: the recorder waits on explicit promises, not on time).
//
//   node benchmarks/rust-core/recorders/record-memory-recall-readiness.mjs --tree <dir>
import { begin, capture, finish, importFrom, exact } from './lib/mc-record.mjs';

const ctx = begin();
const { embedRecallQuery } = await importFrom(ctx.tree, 'src/runtime/memory/lib/recall-embedding-readiness.mjs');
const vector = [0.25, 0.75];
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const realSetTimeout = globalThis.setTimeout;
// A deadline on a wait, on the REAL timer (the product's timers are virtual while a scenario runs).
const within = (label, promise, ms) => new Promise((resolve, reject) => { const timer = realSetTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${label}`)), ms); promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); }); });
const realClearTimeout = globalThis.clearTimeout;

async function scenario(label, query, config) {
  const log = [];
  // Virtual timers: the product's wait timer is recorded (delay, cleared) and never armed for real; a scenario fires it by hand.
  const timers = [];
  let timerArmed = null;
  const armedSignal = new Promise((resolve) => { timerArmed = resolve; });
  globalThis.setTimeout = (fn, delay) => { const handle = { fn }; timers.push({ armed: delay, handle, fired: false }); timerArmed(); return handle; };
  globalThis.clearTimeout = (handle) => { const t = timers.find((x) => x.handle === handle); if (t) t.cleared = true; else realClearTimeout(handle); };
  const fireTimer = async (index) => { await within('the wait timer to be armed', armedSignal, 30_000); timers[index].fired = true; timers[index].handle.fn(); };
  let outcome;
  try {
    outcome = await config.drive({
      call: (extraOptions) => embedRecallQuery(query, {
        isReady: () => { log.push('isReady'); return config.ready; },
        canWarmup: () => { log.push('canWarmup'); return config.canWarmup; },
        warmup: (...a) => { log.push('warmup'); return config.warmup(...a); },
        embed: async (text, options) => { log.push(['embed', text, exact(options)]); return vector; },
        onWarmupError: (error) => { log.push(['onWarmupError', exact(error)]); config.onWarmupErrorSeen?.(); },
        ...extraOptions,
      }),
      log,
      fireTimer,
    });
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
  return { label, query, ...outcome, calls: log, timers: timers.map(({ armed, cleared, fired }) => ({ armed, cleared: cleared === true, fired })) };
}
const settled = (promise, reference = null) => promise.then(
  (value) => ({ result: exact(value), ...(value.error ? { errorIsTheInjectedObject: reference ? value.error === reference : null } : {}) }),
  (error) => ({ rejected: exact(error), rejectedWithTheInjectedReason: reference ? error === reference : null }),
);

const cases = [];
cases.push(await scenario('ready recall embeds immediately as a query', 'memory query', { ready: true, canWarmup: false, warmup: async () => { throw new Error('must not warm'); }, drive: async ({ call }) => settled(call({})) }));
cases.push(await scenario('cold recall waits for warmup and keeps dense retrieval in the same request', '교차 language query', { ready: false, canWarmup: true, warmup: async () => {}, drive: async ({ call }) => settled(call({ waitMs: 50 })) }));
{
  const failure = new Error('load failed');
  cases.push(await scenario('cold recall reports warmup failure and preserves lexical fallback', 'fallback query', { ready: false, canWarmup: true, warmup: async () => { throw failure; }, drive: async ({ call }) => settled(call({ waitMs: 50 }), failure) }));
}
{
  const controller = new AbortController();
  const reason = new Error('cancelled');
  cases.push(await scenario('cold recall aborts without waiting for the timeout', 'cancel query', { ready: false, canWarmup: true, warmup: () => new Promise(() => {}), drive: async ({ call }) => { const pending = call({ signal: controller.signal, waitMs: 5_000 }); controller.abort(reason); return settled(pending, reason); } }));
}
// Case 47: the bounded wait. The timer the product armed is fired by hand (virtual), warmup is still pending: the answer is the lexical
// fallback {vector: null, state: 'timeout'}, no embed call; the warmup then settles in the background.
{
  const warmupGate = deferred();
  cases.push(await scenario('cold recall falls back after the bounded wait while warmup continues', 'bounded wait', { ready: false, canWarmup: true, warmup: () => warmupGate.promise, drive: async ({ call, fireTimer }) => { const pending = settled(call({ waitMs: 5 })); await fireTimer(0); const out = await pending; warmupGate.resolve(); return out; } }));
}
{
  const warmupGate = deferred();
  const seen = deferred();
  const failure = new Error('load failed late');
  cases.push(await scenario('cold recall times out, then the warmup fails in the background', 'late failure', { ready: false, canWarmup: true, warmup: () => warmupGate.promise, onWarmupErrorSeen: () => seen.resolve(), drive: async ({ call, fireTimer }) => { const pending = settled(call({ waitMs: 5 })); await fireTimer(0); const out = await pending; warmupGate.reject(failure); await within('the late warmup failure to be reported', seen.promise, 30_000); return out; } }));
}
// Further shapes.
cases.push(await scenario('empty query', '   ', { ready: true, canWarmup: true, warmup: async () => {}, drive: async ({ call }) => settled(call({})) }));
cases.push(await scenario('null-ish query is empty', null, { ready: true, canWarmup: true, warmup: async () => {}, drive: async ({ call }) => settled(call({})) }));
cases.push(await scenario('cold recall that cannot warm up', 'cannot warm', { ready: false, canWarmup: false, warmup: async () => { throw new Error('must not warm'); }, drive: async ({ call }) => settled(call({ waitMs: 50 })) }));
{
  const controller = new AbortController();
  const reason = new Error('already cancelled');
  controller.abort(reason);
  cases.push(await scenario('signal already aborted before the call', 'aborted early', { ready: true, canWarmup: true, warmup: async () => {}, drive: async ({ call }) => settled(call({ signal: controller.signal }), reason) }));
}
{
  const controller = new AbortController();
  controller.abort();
  cases.push(await scenario('signal aborted without a reason', 'aborted bare', { ready: false, canWarmup: true, warmup: async () => {}, drive: async ({ call }) => settled(call({ signal: controller.signal })) }));
}
cases.push(await scenario('zero wait with an already-resolved warmup', 'zero wait', { ready: false, canWarmup: true, warmup: async () => {}, drive: async ({ call }) => settled(call({ waitMs: 0 })) }));
{
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  cases.push(await scenario('warmup completes after a deferred release, before the wait', 'deferred warmup', { ready: false, canWarmup: true, warmup: () => gate, drive: async ({ call }) => { const pending = settled(call({ waitMs: 60_000 })); release(); return pending; } }));
}
cases.push(await scenario('query is trimmed before embedding', '  padded query  ', { ready: true, canWarmup: false, warmup: async () => {}, drive: async ({ call }) => settled(call({})) }));

finish(ctx, {
  url: import.meta.url,
  set: 'memory-recall-readiness',
  golden: {
    domain: 'memory-recall-readiness',
    source: 'src/runtime/memory/lib/recall-embedding-readiness.test.mjs',
    vector,
    cases: [
      { name: 'ready recall embeds immediately as a query (test line 8)', scenario: cases[0] },
      { name: 'cold recall waits for warmup and keeps dense retrieval in the same request (test line 31)', scenario: cases[1] },
      { name: 'cold recall reports warmup failure and preserves lexical fallback (test line 70)', scenario: cases[2] },
      { name: 'cold recall aborts without waiting for the timeout (test line 90)', scenario: cases[3] },
      { name: 'cold recall falls back after the bounded wait while warmup continues (test line 47)', scenario: cases[4] },
      { name: 'further shapes (beyond the test file)', scenarios: cases.slice(5) },
    ],
  },
  extra: {
    entry: { runs: 'embedRecallQuery (recall-embedding-readiness.mjs) with scripted isReady / canWarmup / warmup / embed / onWarmupError and an AbortSignal; setTimeout/clearTimeout are wrapped only to record the armed delay and whether it was cleared', notRun: 'the 3 s default cold wait that expires (case 47: branch gaps-memory-channels) and the real embedder' },
    replay: 'the `memory/recall` request a client makes (mixdog-services memory/service.rs:273 -> Recall::recall, memory/recall/mod.rs:240), whose embedding step is the provider\'s private query_vector (memory/embed/provider.rs:137; is_ready :85, warmup :91). A replay sends a recall while the embedder is cold/ready/failing/cancelled and compares per scenario the returned state class (dense used, lexical fallback after the bounded wait, failure kept lexical, cancellation error), the error name/code/message, the ordered embedder calls (embed with {priority:true, inputType:"query"}) and the timers armed (delay, cleared, fired). Rust awaits the warmup without a bound today (gap item 2 of gaps-memory-channels: the 3 s MIXDOG_RECALL_COLD_EMBED_WAIT_MS bound is work for the Rust side; its Node recording is case 47 here); the other scenarios map to the same function today',
    exclusions: 'none: case 47 (timeout fallback) is recorded here with virtual timers (the wait timer is recorded and fired by hand; no real time passes)',
    normalised: { 'timer handles': 'only the armed delay and the cleared flag are kept' },
  },
});
process.exit(0);
