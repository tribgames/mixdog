#!/usr/bin/env node
// Node's recall embedding readiness (src/runtime/memory/lib/recall-embedding-readiness.test.mjs): cases 8 (ready recall
// embeds at once as a query), 31 (cold recall waits for warmup and keeps dense retrieval), 70 (warmup failure keeps the
// lexical fallback and is reported) and 90 (abort without waiting for the timeout) from the real `embedRecallQuery`
// (recall-embedding-readiness.mjs), plus further shapes (empty query, warmup unavailable, already-aborted signal, a
// warmup that is slow to settle but beats the wait). Case 47 (the bounded 3 s wait that falls back while warmup
// continues) is recorded by branch gaps-memory-channels and not recorded again. The embedder, readiness probes and warmup
// are scripted endpoints that log every call; the wait timer is recorded as armed (delay) and cleared, never fired (every
// case here settles before the timer could: the recorder waits on explicit promises, not on time).
//
//   node benchmarks/rust-core/recorders/record-memory-recall-readiness.mjs --tree <dir>
import { begin, capture, finish, importFrom, exact } from './lib/mc-record.mjs';

const ctx = begin();
const { embedRecallQuery } = await importFrom(ctx.tree, 'src/runtime/memory/lib/recall-embedding-readiness.mjs');
const vector = [0.25, 0.75];
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

async function scenario(label, query, config) {
  const log = [];
  const timers = [];
  globalThis.setTimeout = (fn, delay, ...rest) => { const handle = realSetTimeout(fn, delay, ...rest); timers.push({ armed: delay, handle }); return handle; };
  globalThis.clearTimeout = (handle) => { const t = timers.find((x) => x.handle === handle); if (t) t.cleared = true; return realClearTimeout(handle); };
  let outcome;
  try {
    outcome = await config.drive({
      call: (extraOptions) => embedRecallQuery(query, {
        isReady: () => { log.push('isReady'); return config.ready; },
        canWarmup: () => { log.push('canWarmup'); return config.canWarmup; },
        warmup: (...a) => { log.push('warmup'); return config.warmup(...a); },
        embed: async (text, options) => { log.push(['embed', text, exact(options)]); return vector; },
        onWarmupError: (error) => { log.push(['onWarmupError', error?.message ?? String(error)]); },
        ...extraOptions,
      }),
      log,
    });
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
  return { label, query, ...outcome, calls: log, timers: timers.map(({ armed, cleared }) => ({ armed, cleared: cleared === true })) };
}
const settled = (promise, reference = null) => promise.then(
  (value) => ({ result: exact((({ error, ...rest }) => rest)(value)), ...(value.error ? { errorMessage: value.error.message, errorIsTheInjectedObject: reference ? value.error === reference : null } : {}) }),
  (error) => ({ rejected: { name: error?.name ?? null, message: String(error?.message ?? error) }, rejectedWithTheInjectedReason: reference ? error === reference : null }),
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
      { name: 'further shapes (beyond the test file)', scenarios: cases.slice(4) },
    ],
  },
  extra: {
    entry: { runs: 'embedRecallQuery (recall-embedding-readiness.mjs) with scripted isReady / canWarmup / warmup / embed / onWarmupError and an AbortSignal; setTimeout/clearTimeout are wrapped only to record the armed delay and whether it was cleared', notRun: 'the 3 s default cold wait that expires (case 47: branch gaps-memory-channels) and the real embedder' },
    replay: 'mixdog-services memory: mem/embed/provider.rs query_vector + mem/recall/mod.rs search_by_query embedding step; compares per scenario the returned {vector, state, error message}, the rejection (name, message, same reason object), the ordered embedder/readiness/warmup calls (embed options {priority:true, inputType:"query"}) and the timers armed (delay, cleared). Rust awaits warmup without a bound today: the timers list is what a bounded-wait implementation must arm',
    exclusions: 'case 47 (timeout fallback) belongs to the gaps-memory-channels recording',
    normalised: { 'timer handles': 'only the armed delay and the cleared flag are kept' },
  },
});
process.exit(0);
