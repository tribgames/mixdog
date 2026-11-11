#!/usr/bin/env node
// Node's memory service lifecycle (src/runtime/memory/lib/memory-service-lifecycle.test.mjs): the shutdown-failure and
// restart cases (185 restart after shutdown and after a failed acquisition, 203 explicit shutdown reports cleanup
// failures, the per-step "releases independent resources after X fails" loop, 282 failed worker shutdown still drains
// requests before storage closes, 310 several failures stay available) from the real `createMemoryServiceLifecycle`
// (memory-service-lifecycle.mjs) driven with its owners as scripted endpoints (initialize, listener open/close, advertise,
// withdraw, stop background work, shutdown) that append to one ordered event log. Not recorded: 57, 90, 121, 234 (covered
// by mem/tests/boot.rs two_first_uses_share_one_install_and_see_its_outcome, a_stop_cancels_and_joins_an_opening...,
// :299, :319), and the listener cases 73, 131, 142, 161, 178, 216 (the memory service has no HTTP listener in the core,
// protocol.md:863). Waits are explicit promises (a drain of microtask turns where the test used setImmediate); no timers.
//
//   node benchmarks/rust-core/recorders/record-memory-service-lifecycle.mjs --tree <dir>
import { begin, capture, finish, importFrom, exact } from './lib/mc-record.mjs';

const ctx = begin();
const { createMemoryServiceLifecycle } = await importFrom(ctx.tree, 'src/runtime/memory/lib/memory-service-lifecycle.mjs');

const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const drain = async () => { for (let i = 0; i < 50; i += 1) await Promise.resolve(); };
const errorOf = (error) => (error instanceof AggregateError
  ? { name: error.name, message: error.message, errors: error.errors.map((e) => ({ name: e.name, message: e.message })) }
  : { name: error?.name ?? null, message: String(error?.message ?? error) });
const settle = (promise) => promise.then((value) => ({ result: exact(value) }), (error) => ({ error: errorOf(error) }));

function fixture(overrides = {}) {
  const calls = [];
  const lifecycle = createMemoryServiceLifecycle({
    initialize: async () => { calls.push('initialize'); },
    openListener: async () => { calls.push('listen'); return 3350; },
    closeListener: async () => { calls.push('close'); },
    advertisePort: (port) => { calls.push(['advertise', port]); },
    withdraw: () => { calls.push('withdraw'); },
    stopBackgroundWork: async () => { calls.push('stop-background'); },
    shutdown: async () => { calls.push('shutdown'); },
    onStart: () => { calls.push('start'); },
    onReady: (port) => { calls.push(['ready', port]); },
    onInitError: (error) => { calls.push(['error', errorOf(error)]); },
    ...overrides,
  });
  return { lifecycle, calls };
}
const state = (lifecycle) => ({ initialized: lifecycle.getInitialized(), stopping: lifecycle.isStopping(), hasInitPromise: lifecycle.getInitPromise() != null });

const cases = [];
{
  let attempts = 0;
  const failure = new Error('first attempt failed');
  const { lifecycle, calls } = fixture({ initialize: async () => { calls.push('initialize'); if (++attempts === 1) throw failure; } });
  const steps = [];
  const run = async (label, promise) => { const out = await settle(promise); steps.push({ label, ...out, state: state(lifecycle), calls: calls.splice(0) }); };
  const first = lifecycle.init().then((v) => v, (e) => { steps.sameAsFailure = e === failure; throw e; });
  await run('init (first attempt fails)', first);
  await run('init again', lifecycle.init());
  await run('stop', lifecycle.stop());
  await run('init after stop', lifecycle.init());
  await run('stop', lifecycle.stop());
  cases.push({ name: 'initialization can restart after shutdown and after a failed acquisition (test line 185)', attempts, firstErrorIsTheInjectedObject: steps.sameAsFailure === true, steps });
}
{
  const failure = new Error('database close failed');
  const { lifecycle, calls } = fixture({ shutdown: async () => { calls.push('shutdown'); throw failure; } });
  const steps = [];
  await lifecycle.init();
  steps.push({ label: 'init', state: state(lifecycle), calls: calls.splice(0) });
  const out = await settle(lifecycle.stop().catch((e) => { steps.sameObject = e === failure; throw e; }));
  steps.push({ label: 'stop (shutdown throws)', ...out, state: state(lifecycle), calls: calls.splice(0) });
  cases.push({ name: 'explicit shutdown reports cleanup failures and clears readiness (test line 203)', errorIsTheInjectedObject: steps.sameObject === true, steps });
}
for (const step of ['withdraw', 'closeListener', 'stopBackgroundWork', 'shutdown']) {
  const failure = new Error(`${step} failed`);
  const cleanup = [];
  const overrides = Object.fromEntries(['withdraw', 'closeListener', 'stopBackgroundWork', 'shutdown'].map((name) => [name, () => { cleanup.push(name); if (name === step) throw failure; }]));
  const { lifecycle, calls } = fixture(overrides);
  await lifecycle.init();
  calls.splice(0);
  let same = null;
  const out = await settle(lifecycle.stop().catch((e) => { same = e === failure; throw e; }));
  cases.push({ name: `shutdown releases independent resources after ${step} fails (test loop${step === 'shutdown' ? ': the fourth step is a further shape' : ''})`, failingStep: step, ...out, errorIsTheInjectedObject: same, cleanupOrder: cleanup, state: state(lifecycle) });
}
{
  const drainGate = deferred();
  const failure = new Error('worker termination failed');
  const events = [];
  const { lifecycle } = fixture({
    closeListener: () => { events.push('listener-closing'); return drainGate.promise; },
    stopBackgroundWork: async () => { events.push('workers-stop-throws'); throw failure; },
    shutdown: async () => { events.push('storage-closed'); },
  });
  await lifecycle.init();
  let settled = false;
  let same = null;
  const stopped = lifecycle.stop().catch((e) => { same = e === failure; throw e; }).finally(() => { settled = true; });
  const result = settle(stopped);
  await drain();
  const beforeRelease = { stopSettled: settled, storageClosed: events.includes('storage-closed'), events: [...events] };
  drainGate.resolve();
  const out = await result;
  cases.push({ name: 'failed worker shutdown still drains active requests before storage closes (test line 282)', beforeDrainReleased: beforeRelease, ...out, errorIsTheInjectedObject: same, eventsAfter: events, state: state(lifecycle) });
}
{
  const failures = [new Error('listener close failed'), new Error('database close failed')];
  const { lifecycle, calls } = fixture({
    closeListener: async () => { calls.push('close'); throw failures[0]; },
    shutdown: async () => { calls.push('shutdown'); throw failures[1]; },
  });
  await lifecycle.init();
  calls.splice(0);
  let sameErrors = null;
  const out = await settle(lifecycle.stop().catch((e) => { sameErrors = e instanceof AggregateError && e.errors.length === 2 && e.errors[0] === failures[0] && e.errors[1] === failures[1]; throw e; }));
  cases.push({ name: 'multiple shutdown failures remain available after every cleanup is attempted (test line 310)', ...out, aggregateHoldsTheInjectedErrorsInOrder: sameErrors, calls, state: state(lifecycle) });
}

finish(ctx, {
  url: import.meta.url,
  set: 'memory-service-lifecycle',
  golden: { domain: 'memory-service-lifecycle', source: 'src/runtime/memory/lib/memory-service-lifecycle.test.mjs', cases },
  extra: {
    entry: { runs: 'createMemoryServiceLifecycle (memory-service-lifecycle.mjs): init, stop, getInitialized, isStopping, getInitPromise', notRun: 'the owners behind its callbacks (database initialize, loopback listener, port advert, background workers, storage shutdown): scripted endpoints that append to one ordered event log' },
    replay: 'mixdog-services memory: mem/boot.rs start/stop (the opening, stop-with-cleanup-failures path): drives the same scripted owners and compares per step the result or error (message; AggregateError members in order), the ordered owner calls and the lifecycle state flags. A stop that fails still runs every cleanup in the stated order (withdraw, closeListener, stopBackgroundWork, shutdown); Rust has no listener/port owners, so a replay maps `close`/`advertise`/`withdraw` to its own seams or drops them by name',
    exclusions: 'test cases 57, 90, 121, 234 are covered by mem/tests/boot.rs; cases 73, 131, 142, 161, 178, 216 exercise the HTTP listener the core does not have (listed, not recorded)',
    normalised: { 'error identity': 'the test asserts error === the injected object; recorded as errorIsTheInjectedObject / aggregateHoldsTheInjectedErrorsInOrder booleans' },
  },
});
process.exit(0);
