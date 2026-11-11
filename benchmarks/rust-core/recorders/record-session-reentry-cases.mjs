#!/usr/bin/env node
// Recording of apps/desktop/src/main/session-reentry.test.mjs (b6f10295a): the desktop SessionHost over the real session service
// (createSessionService with a scripted stored session and runtime) on node:test mock timers (Date, setInterval, setTimeout at
// 1_800_000_000_000; every tick is a recorded input). Cases: eviction and re-entry (open before or after the next submit), a delayed stored read
// versus a new turn, cold-refresh ticks not stacking reads, read tracing (diagnostic sink records), a traced read keeping its
// rejection, and a replayed submission id. Per step the recording holds the published texts, the service size and the stored read count.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-session-reentry-cases.mjs --tree <export of b6f10295a with node_modules>
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { openSet } from './lib/case-set.mjs';

const set = openSet('session-reentry-cases', import.meta.url, { clock: false });
const { createSessionService } = await set.load('src/standalone/session-service.mjs');
const { SessionHost } = await set.load('apps/desktop/src/main/session-host.ts');
const { setTranscriptReadDiagnosticSink } = await set.load('apps/desktop/src/shared/transcript-read-diagnostics.ts');
const NOW = 1_800_000_000_000;
const realSetTimeout = globalThis.setTimeout; const realClearTimeout = globalThis.clearTimeout; // the mock timers replace the globals
/** Waits for the event that ends a step; a step that never happens fails the recording, naming the step (the deadline is a real timer, outside the mocked clock). */
const within = (promise, ms, step) => new Promise((resolve, reject) => { const timer = realSetTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for: ${step}`)), ms); promise.then((v) => { realClearTimeout(timer); resolve(v); }, (e) => { realClearTimeout(timer); reject(e); }); });
async function sessionFixture() {
  mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: NOW });
  const directory = await mkdtemp(join(tmpdir(), 'session-reentry-'));
  const id = 'reentered_session';
  const ctx = { clientToken: 'reentry-view' };
  let stored = { sessionId: id, items: [], queued: [], busy: false, projectionStamp: '0' };
  let sink, runtime, heldRead, updateWaiter, disposeWaiter, lastColdRefresh;
  let reads = 0;
  const updates = [];
  const persist = (items) => { stored = { ...stored, items, projectionStamp: String(Number(stored.projectionStamp) + 1) }; };
  const service = createSessionService({
    idleEvictMs: 100, evictSweepMs: 100,
    sessionExists: async (sessionId) => sessionId === id,
    readStoredSession: async () => stored,
    async createSessionRuntime() {
      let state = stored;
      let listener = () => {};
      const append = (kind, text, itemId) => { persist([...state.items, { id: itemId, kind, text }]); state = stored; listener(); };
      runtime = {
        getState: () => state,
        subscribe(next) { listener = next; return () => { listener = () => {}; }; },
        resume: async () => true,
        async submitAsync(prompt, options) { append('user', prompt, options.id); append('assistant', `reply: ${prompt}`, `${options.id}-reply`); return true; },
        append, async dispose() { disposeWaiter?.resolve(); disposeWaiter = null; },
      };
      return runtime;
    },
    onFrame(frame, targets) { if (targets?.has(ctx.clientToken)) sink?.(frame); },
  });
  const host = await SessionHost.create(
    { userDataPath: directory, resourcesPath: directory, appPath: directory, packaged: false },
    {
      async attachSessionClient({ onFrame }) {
        sink = onFrame;
        const call = (method) => (args) => service.handleCall(`session.${method}`, args, ctx);
        return {
          list: call('list'), create: call('create'), subscribe: call('subscribe'), unsubscribe: call('unsubscribe'), submit: call('submit'), abort: call('abort'), approve: call('approve'), configure: call('configure'),
          async read(args) {
            reads++;
            const result = await service.handleCall('session.read', args, ctx);
            if (heldRead) { const pending = heldRead; heldRead = null; pending.captured.resolve(); await pending.release.promise; }
            return result;
          },
          async close() { service.releaseClient(ctx.clientToken); },
        };
      },
      async loadProjects() { return {}; }, async loadSessionStore() { return {}; }, async loadStatuslineSegments() { return {}; }, async executeCodeGraphTool() { return {}; },
    },
  );
  const catalog = host.catalog;
  const refreshColdViews = catalog.refreshColdViews.bind(catalog);
  catalog.refreshColdViews = () => { lastColdRefresh = refreshColdViews(); return lastColdRefresh; };
  host.subscribeSessionStates((update) => { updates.push(update); updateWaiter?.resolve(update); updateWaiter = null; });
  const steps = [];
  const texts = () => updates.at(-1)?.snapshot?.items.map((item) => item.text);
  return {
    id, host, service, updates, steps, texts,
    get runtime() { return runtime; }, get reads() { return reads; },
    mark: (step, extra = {}) => steps.push({ step, texts: texts(), lastUpdate: structuredClone(updates.at(-1)), serviceSize: service.size, storedReads: reads, updateCount: updates.length, ...extra }),
    nextDispose() { disposeWaiter = Promise.withResolvers(); return disposeWaiter.promise; },
    get lastColdRefresh() { return lastColdRefresh; },
    persist(text) { persist([...stored.items, { id: stored.projectionStamp, kind: 'assistant', text }]); },
    nextUpdate() { updateWaiter = Promise.withResolvers(); return updateWaiter.promise; },
    holdRead() { const pending = { captured: Promise.withResolvers(), release: Promise.withResolvers() }; heldRead = pending; return pending; },
    async dispose() { await host.dispose(); await service.stop('test complete'); await rm(directory, { recursive: true, force: true }); mock.timers.reset(); },
  };
}
async function run(name, fn) { await set.run(name, async () => { const f = await sessionFixture(); try { return await fn(f); } finally { await f.dispose(); } }); }

for (const reopenBeforeSubmit of [true, false]) {
  await run(`an evicted session delivers new prompts and replies (reopen first: ${reopenBeforeSubmit})`, async (f) => {
    await f.host.setVisibleSessions([f.id]);
    await f.host.submitToSession(f.id, 'first', { id: 'first' });
    f.mark('first submitted');
    for (let index = 0; index < 12; index++) { f.runtime.append('assistant', `old progress ${index}`, `progress-${index}`); mock.timers.tick(20); }
    f.mark('old runtime advanced 12 rows (tick 20 ms each)', { lastText: f.texts().at(-1) });
    await f.host.setVisibleSessions([]);
    const evicted = f.nextDispose();
    mock.timers.tick(10_000);
    await within(evicted, 5000, 'the idle sweep to dispose the hidden session runtime');
    f.mark('hidden, 10 s tick, evict sweep drained');
    f.persist('persisted after leaving');
    if (reopenBeforeSubmit) {
      await f.host.setVisibleSessions([f.id]);
      f.mark('reopened (stored view)', { lastText: f.texts().at(-1) });
      f.persist('cold refresh');
      const refreshed = f.nextUpdate();
      mock.timers.tick(1_000);
      await refreshed;
      f.mark('cold refresh tick', { lastText: f.texts().at(-1) });
    }
    const accepted = await f.host.submitToSession(f.id, 'next', { id: 'next' });
    if (!reopenBeforeSubmit) await f.host.setVisibleSessions([f.id]);
    f.mark('next submitted', { accepted, lastTwo: f.texts().slice(-2) });
    const reads = f.reads;
    mock.timers.tick(1_000);
    f.mark('1 s tick after live publication', { readsUnchanged: f.reads === reads });
    return { reopenBeforeSubmit, idleEvictMs: 100, evictSweepMs: 100, nowMs: NOW, steps: f.steps };
  });
}
await run('a delayed stored reply cannot overwrite a newly materialized turn', async (f) => {
  f.persist('stored answer');
  await f.host.setVisibleSessions([f.id]);
  f.mark('opened with a stored answer');
  const held = f.holdRead();
  const reading = f.host.prefetchSession(f.id);
  await held.captured.promise;
  f.mark('prefetch read held');
  await f.host.submitToSession(f.id, 'new turn', { id: 'new-turn' });
  f.mark('new turn submitted while the read is held');
  held.release.resolve();
  await reading;
  f.mark('read released', { lastTwo: f.texts().slice(-2) });
  return { steps: f.steps };
});
await run('cold refresh ticks do not stack reads while that session is still loading', async (f) => {
  f.persist('stored answer');
  await f.host.setVisibleSessions([f.id]);
  const held = f.holdRead();
  const reads = f.reads;
  mock.timers.tick(1_000);
  await held.captured.promise;
  mock.timers.tick(5_000);
  f.mark('1 s tick, read held, 5 s more ticks', { readsSinceOpen: f.reads - reads });
  const refreshing = f.lastColdRefresh;
  held.release.resolve();
  await within(refreshing, 5000, 'the held cold-view refresh to settle');
  mock.timers.tick(1_000);
  f.mark('read settled, 1 s tick', { readsSinceOpen: f.reads - reads });
  return { steps: f.steps };
});
await run('read tracing measures a held host read and propagates its correlation without changing the result', async (f) => {
  f.persist('private saved answer');
  let now = 0;
  const realNow = performance.now;
  performance.now = () => now;
  const records = [];
  const restore = setTranscriptReadDiagnosticSink((entry) => records.push(structuredClone(entry)));
  try {
    const held = f.holdRead();
    const reading = f.host.prefetchSession(f.id, undefined, 'read-host-1');
    await held.captured.promise;
    const recordsWhileHeld = structuredClone(records);
    now = 321;
    held.release.resolve();
    const result = await reading;
    f.mark('prefetch finished');
    return { performanceNowWhileHeld: 0, performanceNowAtRelease: 321, recordsWhileHeld, result, records, lastUpdate: f.updates.at(-1), texts: f.texts(), steps: f.steps };
  } finally { restore(); performance.now = realNow; }
});
await run('a traced host read preserves its original rejection', async (f) => {
  const failureValue = new Error('private read failure');
  const original = f.host.sessionClient.read;
  f.host.sessionClient.read = async () => { throw failureValue; };
  const records = [];
  const restore = setTranscriptReadDiagnosticSink((entry) => records.push(structuredClone(entry)));
  try {
    let outcome;
    try { await f.host.prefetchSession(f.id, undefined, 'read-host-failure'); outcome = { resolved: true }; } catch (error) { outcome = { rejected: error, sameErrorObject: error === failureValue }; }
    return { outcome, records };
  } finally { restore(); f.host.sessionClient.read = original; }
});
await run('a replayed submission id joins the original instead of double-submitting', async (f) => {
  await f.host.setVisibleSessions([f.id]);
  const first = f.host.submitToSession(f.id, 'once', { id: 'retry-id' });
  const replay = f.host.submitToSession(f.id, 'once', { id: 'retry-id' });
  const both = await Promise.all([first, replay]);
  const again = await f.host.submitToSession(f.id, 'once', { id: 'retry-id' });
  f.mark('after replays');
  return { both, again, onceCount: f.texts().filter((text) => text === 'once').length, texts: f.texts(), steps: f.steps };
});

await set.finish({
  entry: { hops: "No wire in the Node test: the daemon client is the real session service called in process (handleCall).", runs: "apps/desktop/src/main/session-host.ts SessionHost (setVisibleSessions, submitToSession, prefetchSession, subscribeSessionStates) over the real createSessionService (idle eviction sweep, handleCall session.*) with a scripted stored session and runtime, node:test mock timers, the read-diagnostics sink", notRun: 'no real runtime or store; the daemon client is the service called in-process' },
  replay: { entry: 'mixdog-core-session + mixdog-app-server (session host re-entry): replay each step list on a virtual clock (mock timers: Date, setInterval, setTimeout from 1_800_000_000_000; tick values are in the step labels); compare published texts, service size, stored read count and diagnostics records after each step', normalised: { dataDir: 'temp user-data dir not in the recording', clock: 'mock timers, not the shared fixed Date.now' } },
});
process.exit(0);
