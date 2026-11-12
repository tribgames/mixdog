#!/usr/bin/env node
// Node's memory service lifecycle (src/runtime/memory/lib/memory-service-lifecycle.test.mjs): every test of the file from the real
// `createMemoryServiceLifecycle` (memory-service-lifecycle.mjs), recorded at the service boundary, i.e. what a caller of init()/stop()
// can observe: who is handed the instance (the same init promise, one acquisition), what a cancelled or failed acquisition leaves
// behind (readiness, advertised port, state flags), and the ORDER in which the owners are released. The owners behind the callbacks
// (runtime initialize, listener open/close, port advert, background workers, shutdown) are scripted endpoints appending to ONE ordered
// event log; the one real listener (case 216) is createLoopbackListener on an http.Server. No timer, sleep or drain count: every wait
// is a promise that resolves when the product reaches the step (an event in the log), with a 30 s deadline whose message names it.
//
//   node benchmarks/rust-core/recorders/record-memory-service-lifecycle.mjs --tree <dir>
import http from 'node:http';
import net from 'node:net';
import { mock } from 'node:test';
import { begin, finish, importFrom, exact, within } from './lib/mc-record.mjs';

const ctx = begin();
const { createMemoryServiceLifecycle } = await importFrom(ctx.tree, 'src/runtime/memory/lib/memory-service-lifecycle.mjs');
const { createMemoryDaemonLifecycle } = await importFrom(ctx.tree, 'src/runtime/memory/lib/memory-daemon-lifecycle.mjs');
const { createLoopbackListener } = await importFrom(ctx.tree, 'src/runtime/shared/loopback-listener.mjs');

const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const errorOf = (error) => (error instanceof AggregateError ? { error: exact(error), members: error.errors.map((e) => exact(e)) } : exact(error));
const outcome = (promise) => promise.then((value) => ({ result: exact(value) }), (error) => ({ error: errorOf(error) }));

// One ordered event log with "wait until" on it.
function harness(overrides = {}) {
  const calls = [];
  const waiters = [];
  const push = (entry) => { calls.push(entry); for (const w of [...waiters]) if (w.test(calls)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); } };
  const until = (label, test) => (test(calls) ? Promise.resolve() : within(label, new Promise((resolve) => waiters.push({ test, resolve })), 30_000));
  const has = (name) => (list) => list.some((c) => (Array.isArray(c) ? c[0] === name : c === name));
  const lifecycle = createMemoryServiceLifecycle({
    initialize: async () => { push('initialize'); },
    openListener: async () => { push('listen'); return 3350; },
    closeListener: async () => { push('close'); },
    advertisePort: (port) => { push(['advertise', port]); },
    withdraw: () => { push('withdraw'); },
    stopBackgroundWork: async () => { push('stop-background'); },
    shutdown: async () => { push('shutdown'); },
    onStart: () => { push('start'); },
    onReady: (port) => { push(['ready', port]); },
    onInitError: (error) => { push(['error', errorOf(error)]); },
    ...(typeof overrides === 'function' ? overrides(push) : overrides),
  });
  const state = () => ({ initialized: lifecycle.getInitialized(), stopping: lifecycle.isStopping(), hasInitPromise: lifecycle.getInitPromise() != null });
  const steps = [];
  let taken = 0;
  const mark = (label, extra = {}) => { steps.push({ label, ...extra, state: state(), calls: calls.slice(taken) }); taken = calls.length; };
  return { lifecycle, calls, push, until, has, state, mark, steps };
}
const cases = [];
const add = (line, name, body) => cases.push({ name: `${name} (test line ${line})`, ...body });

{
  const h = harness();
  const started = h.lifecycle.init();
  const sameWhilePending = h.lifecycle.init() === started;
  await started;
  const again = h.lifecycle.init();
  await again;
  h.mark('init x2 concurrently, then once more', { sameInitPromiseWhilePending: sameWhilePending });
  await h.lifecycle.stop();
  h.mark('stop');
  add(57, 'concurrent initialization opens each owner and publishes readiness once', { steps: h.steps });
}
{
  const runtime = deferred();
  const h = harness({ initialize: () => runtime.promise });
  const started = h.lifecycle.init();
  await h.until('the port to be advertised while the runtime is pending', h.has('advertise'));
  h.mark('init with the runtime pending: the port is advertised, ready is not published');
  runtime.resolve();
  await started;
  h.mark('runtime resolves');
  await h.lifecycle.stop();
  h.mark('stop');
  add(73, 'the bound port is advertised before runtime readiness, but ready waits for both', { steps: h.steps });
}
{
  const runtime = deferred();
  let signal;
  const h = harness((push) => ({ initialize: async (value) => { signal = value; push('initialize'); await runtime.promise; push('acquired'); } }));
  const rejected = outcome(h.lifecycle.init());
  await h.until('the runtime acquisition to start', h.has('initialize'));
  const stopped = h.lifecycle.stop();
  const sameStop = h.lifecycle.stop() === stopped;
  const aborted = signal.aborted;
  const laterInit = await outcome(h.lifecycle.init());
  await h.until('withdraw and close while the acquisition is in flight', (c) => c.includes('withdraw') && c.includes('close'));
  h.mark('init pending, then stop(): the signal is aborted, a second stop returns the same promise, init() is refused', { signalAbortedAtStop: aborted, secondStopIsTheSamePromise: sameStop, initDuringStop: laterInit, shutdownCalledYet: h.calls.includes('shutdown') });
  runtime.resolve();
  const initOutcome = await rejected;
  await stopped;
  h.mark('the acquisition finishes: shutdown comes after it, no ready', { initOutcome, acquiredBeforeShutdown: h.calls.indexOf('acquired') < h.calls.indexOf('shutdown') });
  add(90, 'shutdown waits for in-flight acquisition before releasing its resources', { steps: h.steps });
}
{
  const h = harness();
  const rejected = outcome(h.lifecycle.init());
  await h.lifecycle.stop();
  h.mark('init() and stop() in the same tick', { initOutcome: await rejected });
  add(121, 'same-tick shutdown cancels queued acquisition instead of starting it', { steps: h.steps, initializeCalled: h.calls.includes('initialize'), listenCalled: h.calls.includes('listen') });
}
{
  const bind = deferred();
  const h = harness((push) => ({ openListener: () => { push('listen'); return bind.promise; } }));
  const rejected = outcome(h.lifecycle.init());
  await h.until('the listener open to start', h.has('listen'));
  const stopped = h.lifecycle.stop();
  bind.resolve(3350);
  const initOutcome = await rejected;
  await stopped;
  h.mark('init with the bind pending, stop(), the bind resolves late', { initOutcome, anyAdvertiseOrReady: h.calls.some(Array.isArray) });
  add(131, 'a late listener result cannot re-advertise or report ready after stop', { steps: h.steps });
}
{
  const bind = deferred();
  const failure = new Error('database unavailable');
  const h = harness((push) => ({
    initialize: async () => { push('initialize'); throw failure; },
    openListener: () => { push('listen'); return bind.promise; },
    closeListener: async () => { push('close'); bind.reject(new Error('bind cancelled')); },
  }));
  let same = null;
  const initOutcome = await outcome(h.lifecycle.init().catch((error) => { same = error === failure; throw error; }));
  h.mark('runtime fails while the bind is pending', { initOutcome, errorIsTheInjectedObject: same === true });
  add(142, 'runtime failure during a pending HTTP bind is handled and releases both owners', { steps: h.steps });
}
{
  const runtime = deferred();
  const failure = new Error('bind denied');
  const h = harness((push) => ({ initialize: () => runtime.promise, openListener: async () => { push('listen'); throw failure; } }));
  let same = null;
  const rejected = outcome(h.lifecycle.init().catch((error) => { same = error === failure; throw error; }));
  await h.until('the failing listener open', h.has('listen'));
  h.mark('the bind fails while the runtime is pending', { shutdownCalledYet: h.calls.includes('shutdown') });
  runtime.resolve();
  const initOutcome = await rejected;
  h.mark('the runtime acquisition ends', { initOutcome, errorIsTheInjectedObject: same === true });
  add(161, 'listener failure waits for runtime acquisition and preserves the bind error', { steps: h.steps });
}
{
  const h = harness({ openListener: async () => null });
  await h.lifecycle.init();
  h.mark('init with a null port (integrated or secondary startup)');
  await h.lifecycle.stop();
  h.mark('stop');
  add(178, 'integrated or secondary startup reports a null port without advertising', { steps: h.steps });
}
{
  let attempts = 0;
  const failure = new Error('first attempt failed');
  const h = harness((push) => ({ initialize: async () => { push('initialize'); if (++attempts === 1) throw failure; } }));
  let same = null;
  const first = await outcome(h.lifecycle.init().catch((error) => { same = error === failure; throw error; }));
  h.mark('init (the first attempt fails)', { ...first, errorIsTheInjectedObject: same === true });
  await h.lifecycle.init();
  h.mark('init again');
  await h.lifecycle.stop();
  h.mark('stop');
  await h.lifecycle.init();
  h.mark('init after stop');
  await h.lifecycle.stop();
  h.mark('stop');
  add(185, 'initialization can restart after shutdown and after a failed acquisition', { attempts, steps: h.steps });
}
{
  const failure = new Error('database close failed');
  const h = harness((push) => ({ shutdown: async () => { push('shutdown'); throw failure; } }));
  await h.lifecycle.init();
  h.mark('init');
  let same = null;
  const stopOutcome = await outcome(h.lifecycle.stop().catch((error) => { same = error === failure; throw error; }));
  h.mark('stop (shutdown throws)', { ...stopOutcome, errorIsTheInjectedObject: same === true });
  add(203, 'explicit shutdown reports cleanup failures and clears readiness', { steps: h.steps });
}
{
  // The one real listener: createLoopbackListener on an http.Server, closed by the service shutdown while the runtime is pending.
  const server = http.createServer();
  const listener = createLoopbackListener({ server, onListening() {}, onError() {} });
  const runtime = deferred();
  const h = harness((push) => ({ initialize: () => runtime.promise, openListener: async () => { push('listen'); return listener.start(); }, closeListener: async () => { push('close'); return listener.stop(); }, advertisePort: () => { push(['advertise', '<port>']); }, onReady: () => { push(['ready', '<port>']); } }));
  const rejected = outcome(h.lifecycle.init());
  await h.until('the real listener to be opened', h.has('listen'));
  await h.until('the real listener to be bound', () => server.listening);
  const port = server.address().port;
  const stopped = h.lifecycle.stop();
  runtime.resolve();
  const initOutcome = await rejected;
  await stopped;
  const connect = await within('the connection attempt after shutdown', new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); resolve('connected'); }); s.on('error', (e) => resolve(e.code)); }), 30_000);
  h.mark('init with the runtime pending and a real listener bound, then stop()', { initOutcome, serverListeningAfterStop: server.listening, connectAfterStop: connect });
  add(216, 'service shutdown closes a real listener while runtime initialization is pending', { steps: h.steps });
}
{
  const listenerClosed = deferred();
  const h = harness((push) => ({
    closeListener: () => { push('listener-closing'); return listenerClosed.promise; },
    stopBackgroundWork: async () => { push('workers-stopped'); listenerClosed.resolve(); },
    shutdown: async () => { push('storage-closed'); },
  }));
  await h.lifecycle.init();
  h.mark('init');
  const stopped = h.lifecycle.stop();
  await h.until('the workers to be stopped while the listener is still draining', h.has('workers-stopped'));
  await stopped;
  h.mark('stop: the workers are stopped before the request drain ends, storage closes last', { order: h.calls.filter((c) => typeof c === 'string' && ['listener-closing', 'workers-stopped', 'storage-closed'].includes(c)) });
  add(234, 'shutdown stops workers before waiting for requests that depend on those workers', { steps: h.steps });
}
for (const step of ['withdraw', 'closeListener', 'stopBackgroundWork', 'shutdown']) {
  const failure = new Error(`${step} failed`);
  const cleanup = [];
  const h = harness(() => Object.fromEntries(['withdraw', 'closeListener', 'stopBackgroundWork', 'shutdown'].map((name) => [name, () => { cleanup.push(name); if (name === step) throw failure; }])));
  await h.lifecycle.init();
  h.mark('init');
  let same = null;
  const stopOutcome = await outcome(h.lifecycle.stop().catch((error) => { same = error === failure; throw error; }));
  h.mark(`stop (${step} throws)`, { ...stopOutcome, errorIsTheInjectedObject: same === true, cleanupOrder: cleanup });
  add(250, `shutdown releases independent resources after ${step} fails${step === 'shutdown' ? ' (a further shape: the test loop has three steps)' : ''}`, { failingStep: step, steps: h.steps });
}
{
  const drainGate = deferred();
  const failure = new Error('worker termination failed');
  let stopSettled = false;
  const h = harness((push) => ({
    closeListener: () => { push('listener-closing'); return drainGate.promise; },
    stopBackgroundWork: async () => { push('workers-stop-throws'); throw failure; },
    shutdown: async () => { push('storage-closed'); },
  }));
  await h.lifecycle.init();
  h.mark('init');
  let same = null;
  const stopped = outcome(h.lifecycle.stop().catch((error) => { same = error === failure; throw error; }).finally(() => { stopSettled = true; }));
  await h.until('the worker shutdown failure', h.has('workers-stop-throws'));
  h.mark('the worker stop failed while the request drain is still open', { stopSettled, storageClosed: h.calls.includes('storage-closed') });
  drainGate.resolve();
  const stopOutcome = await stopped;
  h.mark('the drain ends', { ...stopOutcome, errorIsTheInjectedObject: same === true, storageClosed: h.calls.includes('storage-closed') });
  add(282, 'failed worker shutdown still drains active requests before storage closes', { steps: h.steps });
}
{
  const failures = [new Error('listener close failed'), new Error('database close failed')];
  const h = harness((push) => ({ closeListener: async () => { push('close'); throw failures[0]; }, shutdown: async () => { push('shutdown'); throw failures[1]; } }));
  await h.lifecycle.init();
  h.mark('init');
  let aggregateOk = null;
  const stopOutcome = await outcome(h.lifecycle.stop().catch((error) => { aggregateOk = error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === failures[0] && error.errors[1] === failures[1]; throw error; }));
  h.mark('stop (listener close and shutdown both throw)', { ...stopOutcome, aggregateHoldsTheInjectedErrorsInOrder: aggregateOk });
  add(310, 'multiple shutdown failures remain available after every cleanup is attempted', { steps: h.steps });
}
{
  // Quit: the daemon releases its registration (daemon.mjs:372-378) and the memory process stops when its last client is gone
  // (memory-daemon-lifecycle.mjs:60-74, wired at index.mjs:162-171 with log = __mixdogMemoryLog, its stderr, which the daemon's
  // spawner mirrors into memory-runtime-proxy.log, daemon-spawn.mjs:110-115). The real createMemoryDaemonLifecycle over the real
  // createMemoryServiceLifecycle whose stop fails; the grace timer runs on node:test's mock clock, moved by one explicit tick, and
  // process.exit is captured (restored on every path).
  const quits = [];
  for (const [failing, endpoints] of [
    ['storage', { shutdown: 'database close failed' }],
    ['worker stop and storage', { stopBackgroundWork: 'worker termination failed', shutdown: 'database close failed' }],
  ]) {
    const h = harness((push) => Object.fromEntries(Object.entries(endpoints).map(([step, text]) => [step, async () => { push(step); throw new Error(text); }])));
    await h.lifecycle.init();
    const logs = [];
    const exits = [];
    const exited = deferred();
    const realExit = process.exit;
    process.exit = (code) => { exits.push(code); exited.resolve(); };
    try {
      mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
      let daemon;
      try {
        const alive = new Set([4242]);
        daemon = createMemoryDaemonLifecycle({
          daemonMode: true, idleTtlMs: 0, clientGraceMs: 10_000,
          parsePositivePid: (pid) => (Number.isInteger(pid) && pid > 0 ? pid : null),
          isPidAlive: (pid) => alive.has(pid),
          isStopping: () => h.lifecycle.isStopping(),
          stop: () => h.lifecycle.stop(),
          log: (chunk) => { logs.push(chunk); },
        });
        daemon.registerClient(4242);
        alive.delete(4242);
        daemon.deregisterClient(4242);
        mock.timers.tick(10_000);
      } finally {
        daemon?.reset();
        mock.timers.reset();
      }
      await within('the memory process to exit after its failed client-grace stop', exited.promise, 30_000);
    } finally {
      process.exit = realExit;
    }
    quits.push({ failing, logs, exitCodes: exits, calls: h.calls });
  }
  cases.push({ name: 'at quit the last client leaves and the memory stop fails: what the memory process writes (memory-daemon-lifecycle.mjs:60-74)', quits });
}

finish(ctx, {
  url: import.meta.url,
  set: 'memory-service-lifecycle',
  golden: { domain: 'memory-service-lifecycle', source: 'src/runtime/memory/lib/memory-service-lifecycle.test.mjs', cases },
  extra: {
    entry: { runs: 'createMemoryServiceLifecycle (memory-service-lifecycle.mjs): init, stop, getInitialized, isStopping, getInitPromise; case 216 also the real createLoopbackListener (shared/loopback-listener.mjs) on an http.Server', notRun: 'the owners behind its callbacks (database initialize, port advert, background workers, storage shutdown): scripted endpoints appending to one ordered event log' },
    replay: "mixdog-services memory/replays/service_lifecycle.rs against MemoryStack (memory/boot.rs): MemoryStack::start builds the stack over a scripted PgRuntimeSource::Install (Node's scripted initialize: logs its entry where Node's did, held at a gate, failing with the recorded text, or handing over MIXDOG_PG_RUNTIME so the opening reaches a real private cluster), a memory request's database use (stack.db().client()) is init(), MemoryStack::stop is stop(). Compared per step: the use's outcome (error name and message), state.initialized = MemoryStack::is_open, state.stopping = MemoryStack::is_stopping, the calls mapped initialize -> install entry, acquired -> the held install's release, stop-background/workers-stopped/workers-stop-throws -> the stop's background-work step, shutdown/storage-closed -> its storage release (both observed and failed through the development-only StopSeam, test-support), cleanupOrder/order -> those steps in order, sameInitPromiseWhilePending -> one install for concurrent uses, signalAbortedAtStop -> the install's cancel token at the stop, initializeCalled -> the install count, attempts -> installs over both cores of case 8. The next start after a stop is the next core's stack over the same profile (the core never reopens a stopped stack). What is the listener's or the port advert's alone is declared in `declared` (no client of memory in K1 reaches either: `listenerClients`). Case 18 (quit) runs the host's quit stop (MemoryStack::stop_for_quit, called by the composed core's memory stop step and its startup-failure release, mixdog-app-server-daemon compose_flip.rs) with the same failures injected through the StopSeam and compares the lines it writes to the memory worker's stderr (mixdog_rt::memory_stderr!, the core's memory-runtime-proxy.log) with `logs`' failure line, as the bytes node_log::bare writes",
    listenerClients: {
      claim: 'nothing in K1 connects to a memory listener or reads the memory port advert, so neither has a client-visible counterpart',
      core: 'native/core has no memory listener, advert or discovery reader: the memory stack runs in the daemon (mixdog-app-server-daemon compose_flip.rs MemoryStack::start) and is reached by in-process calls',
      desktop: 'apps/desktop reaches memory only through the core control RPC (apps/desktop/src/main/session-host.ts:1004,1011 transport.invokeControl); no file under apps/ reads discovery/memory.json',
      cli: 'apps/ holds desktop, mixdogd-npm, mobile, relay: none reads the memory advert or connects to a memory port',
      nodeReadersDeletedAtK1: [
        'src/runtime/shared/service-discovery.mjs:81,108 readLiveServiceAdvert/readServicePort (K1 delete list, scratch/rust-core/k1/delete-list.md:3215)',
        'src/runtime/agent/orchestrator/mcp/client-transport.mjs:48,53 and client-config.mjs:15 (delete-list.md:1822,1818)',
        'src/runtime/agent/orchestrator/agent-trace-io.mjs:232 (delete-list.md:1778)',
        'src/session-runtime/services/memory-runtime-proxy/discovery.mjs:27 and rpc.mjs:88, the memory runtime proxy (src/session-runtime/**, delete-list.md:3343)',
        'src/runtime/memory/lib/memory-port-advertiser.mjs:65 and memory-config-flags.mjs:7 (src/runtime/memory/lib/**, delete-list.md:2999)',
      ],
    },
    declared: [
      { what: 'calls start and error', reason: 'log lines (runtime/memory/index.mjs:578,580); the error itself is compared as the use\'s outcome' },
      { what: 'calls ready', reason: 'a log line and the idle timer (index.mjs:582-588); readiness is compared as state.initialized' },
      { what: 'calls listen, advertise, withdraw, close, listener-closing; cleanupOrder withdraw, closeListener; order listener-closing', reason: "the HTTP listener and the port advert: the core's memory serves no HTTP and writes no advert; nothing in K1 connects to one (`listenerClients`)" },
      { what: 'state.hasInitPromise', reason: 'read only by the HTTP router (http-router.mjs:36), which the in-process memory does not serve' },
      { what: 'the calls after `error` in cases 5 and 8 (step 0)', reason: 'the stop a failed initialization runs on itself (memory-service-lifecycle.mjs:55-59) releases the listener and storage that was never opened; the core releases a partly opened cluster inside the opening (boot.rs release_on_failure) and runs no stop' },
      { case: 2, what: 'secondStopIsTheSamePromise', reason: 'the core\'s stop has one caller, the host\'s shutdown' },
      { case: 3, what: 'listenCalled', reason: 'no listener' },
      { case: 16, step: 1, what: 'the step while the request drain is open', reason: 'the drain is the listener\'s closing (memory-service-lifecycle.mjs:83-91); its worker-stop call is compared with the last step' },
      { case: 4, reason: 'a late listener result: the listener alone' },
      { case: 6, reason: 'a listener failure: the listener alone' },
      { case: 10, reason: 'a real listener closed at stop: the listener alone (the pending initialization refused at stop is case 2)' },
      { case: 12, reason: 'withdraw fails: the port advert alone' },
      { case: 13, reason: 'closeListener fails: the listener alone' },
      { case: 17, reason: 'the aggregate holds the listener close failure: the listener alone (the storage failure alone is case 9)' },
      { case: 18, what: 'logs: the `daemon client grace elapsed (…); shutting down` line', reason: "Daemon mode is in scope: the core's memory replaces the memory process the host forks, not an in-process memory. The host reaches memory only through the proxy (standalone/daemon.mjs:221 getStandaloneMemoryRuntime, session-runtime/runtime-modules.mjs:19), which forks it with MIXDOG_MEMORY_DAEMON=1 (memory-runtime-proxy/daemon-spawn.mjs:55), so the client grace is armed there (index.mjs:159,162-171; memory-daemon-lifecycle.mjs:60-74): the host's quit deregisters its client (daemon.mjs:375, client-registry.mjs:76-85), deregisterClient arms the 10 s grace (memory-daemon-lifecycle.mjs:98-102; MEMORY_CLIENT_GRACE_MS, index.mjs:161), registerClient cancels it (:87-93), and its callback prunes dead clients and looks at nothing else (:64-65): a call in progress does not delay the stop. The core has no grace, by decision (decisions.md, WORK-PACKAGES §8: idle stop — the core stops immediately when the last client leaves and no work is running, no grace timer): its memory shares the host's process, so nothing outlives the host that a later client could re-register with, and a grace the host waited out would delay its quit by 10 s. At quit it stops at once (MemoryStack::stop_for_quit), through the same failing steps; a line naming the elapsed grace would be untrue; the failure line is compared" },
      { case: 18, what: 'exitCodes', reason: 'the exit code of the separate memory process (process.exit(1)); the core\'s memory has no process of its own, and the daemon\'s exit code at quit is its own' },
      { case: 18, what: 'calls', reason: 'the scripted endpoints\' calls, compared in cases 9 and 14-16' },
    ],
    exclusions: 'none: every test of the file is recorded (the three-step failure loop is recorded for four steps; shutdown is a further shape)',
    normalised: { 'error identity': 'the test asserts error === the injected object; recorded as errorIsTheInjectedObject / aggregateHoldsTheInjectedErrorsInOrder booleans', 'listener port': 'case 216: the real ephemeral port is written <port> in the advertise/ready events; only the observable result of connecting after stop (ECONNREFUSED)' },
  },
});
process.exit(0);
