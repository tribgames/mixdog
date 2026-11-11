#!/usr/bin/env node
// Golden twin of `scripts/session-transport/steering-recovery.test.mjs`: busy-input steering and abort recovery.
//   14  `createSessionApiA().submitAsync` ACKs queue intake before auto-clear settles, `abort({restorePrompt,
//       submissionId})` reclaims the acknowledged entry (scripted queue; the clear gate is a promise the recorder
//       resolves as an explicit, recorded step);
//   75  `appendTuiSteeringPersist` / `readTuiSteeringPersist` keep the submission identity (real spool files in the
//       runtime root, recorded);
//   90  `createSessionApiB().resume` holds the command gate until the steering restore settled (two gates, recorded
//       steps; every wait is on the event that ends it, with a deadline);
//   139 `session.abort` over the real HTTP session transport starts at once while 64 ordinary `session.read` calls
//       are in flight (stub runtime; the 64 reads are issued one after the other, each once the service saw the previous
//       one, so they are all in flight together and arrive in a fixed order; they are released after the abort answered).
//
//   node benchmarks/rust-core/recorders/record-session-transport-steering-recovery.mjs --tree <dir>
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { exact } from './lib/exact.mjs';
import { DEADLINE_MS, DETERMINISM, FIXED_CWD, FIXED_NOW, Signal, installDeterminism, withLoggedDaemon } from './lib/session-wire-harness.mjs';
import { outcomeExact, runSessionRecorder } from './lib/session-rec.mjs';

installDeterminism();

/** A promise with a deadline: the recorder never waits unbounded. */
const withDeadline = (promise, label, ms = DEADLINE_MS) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timed out waiting for: ${label}`)), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});

await runSessionRecorder(import.meta.url, {
  set: 'session-transport-steering-recovery',
  testFile: 'scripts/session-transport/steering-recovery.test.mjs',
  entry: 'Cases 14 and 90 ran the real src/tui/session/session-api.mjs createSessionApiA and session-api-ext.mjs createSessionApiB with scripted dependencies (queue, state setter, restore hooks); case 75 ran src/tui/session/tui-steering-persist.mjs on a temp MIXDOG_DATA_DIR (spool files recorded with their path and bytes); case 139 ran the real HTTP session transport (behind a TCP tap that records every HTTP exchange) + session service + session-client attachSession with the stub runtime of scripts/session-transport/_shared.mjs, 64 gated reads and one abort. Did not run a real runtime or any TUI rendering.',
  replay: 'Cases 14 and 90 are the Node TUI client\'s steering/restore logic (createSessionApiA/B): it has no Rust counterpart (list as Rust-side work). What the Rust core must equal is what a client observes through the app-server protocol (native/core/crates/mixdog-app-protocol): turn/start while a turn is busy (ACK before the queue settles), turn/interrupt with {restorePrompt, submissionId} returning the restored text, thread/resume restoring the queued steering before the thread is released, and, for case 139, turn/interrupt answered at once while 64 thread/read requests are in flight (compare the ordered service calls, the abort options the runtime received and its result). Case 75 (the persisted steering spool: path, bytes, restored rows with their submission identity) is a durable-queue contract: compare the spool rows after the same appends when the Rust pending queue persists steering; otherwise Rust-side work.',
  values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs)',
  exclusions: [
    'case 75: spool paths are recorded as relative to the runtime root with the separator Node produced (a backslash on Windows); the root itself (a temp dir) is not recorded. Files are listed in the directory-walk order the OS returns them, not sorted',
    'wire taps record the HTTP exchanges in request order: `Host` header port value -> <port> and the response `Date` header value -> <date>, at those header paths only; no other value is normalised',
    ...DETERMINISM,
  ],
}, async ({ imp }) => {
  const S = await imp('scripts/session-transport/_shared.mjs');
  const cases = [];

  // test line 14
  {
    const clearGate = Promise.withResolvers();
    let enqueued = 0;
    const queued = [];
    let state = { busy: false, commandBusy: false };
    const log = [];
    const api = S.createSessionApiA({
      runtime: { abort: () => true },
      nextId: () => 'generated-id',
      flags: {}, pending: [], listeners: new Set(),
      getState: () => state, getPublishedState: () => state,
      set: (patch) => { state = { ...state, ...patch }; log.push({ set: exact(patch) }); },
      routeState: () => ({}),
      autoClearBeforeSubmit: () => { log.push('autoClearBeforeSubmit called'); return clearGate.promise; },
      enqueue: (text, options) => { enqueued += 1; queued.push({ text, id: options.id }); log.push({ enqueue: exact({ text, id: options.id }) }); return true; },
      restoreQueued: (_current, selectedId) => {
        const index = queued.findIndex((entry) => entry.id === selectedId);
        log.push({ restoreQueued: selectedId, found: index >= 0 });
        if (index < 0) return { count: 0, ids: [], text: '', pastedImages: null, pastedTexts: null };
        const [entry] = queued.splice(index, 1);
        return { count: 1, ids: [entry.id], text: entry.text, pastedImages: null, pastedTexts: null };
      },
    });
    const steps = [];
    const ack = await api.submitAsync('recover before busy', { id: 'actual-session-idle-1' });
    steps.push({ step: "submitAsync('recover before busy', {id: actual-session-idle-1}) (auto-clear gate still pending)", result: exact(ack), enqueued });
    const restored = api.abort({ restorePrompt: true, submissionId: 'actual-session-idle-1' });
    steps.push({ step: "abort({restorePrompt: true, submissionId: 'actual-session-idle-1'})", result: exact(restored), queuedLength: queued.length });
    clearGate.resolve();
    steps.push({ step: 'resolve the auto-clear gate', queuedLength: queued.length, enqueued });
    cases.push({ name: 'submit-ack-does-not-wait-for-auto-clear-and-remains-reclaimable', testLine: 14, input: exact({ submit: { text: 'recover before busy', options: { id: 'actual-session-idle-1' } }, abort: { restorePrompt: true, submissionId: 'actual-session-idle-1' }, initialState: { busy: false, commandBusy: false } }), result: { steps, log, finalState: exact(state) } });
  }

  // test line 75
  {
    const sessionId = 'steering-recovery-recorded';
    const entry = { id: 'desktop-submit-retry-1', text: 'ship it', submittedAt: FIXED_NOW - 50 };
    await S.appendTuiSteeringPersist(sessionId, entry);
    const restored = await S.readTuiSteeringPersist(sessionId);
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
    const spool = walk(S.RUNTIME_ROOT).filter((f) => /pending|spool/i.test(f) && statSync(f).isFile());
    cases.push({
      name: 'persisted-steering-keeps-the-desktop-submission-identity-across-recovery',
      testLine: 75,
      input: exact({ sessionId, entry, clock: { 'Date.now()': FIXED_NOW } }),
      result: {
        restored: exact(restored),
        spoolFiles: spool.map((f) => ({ path: relative(S.RUNTIME_ROOT, f), text: readFileSync(f, 'utf8') })),
      },
    });
  }

  // test line 90
  {
    const restoreStarted = Promise.withResolvers();
    const restoreGate = Promise.withResolvers();
    let restored = false;
    let sequence = 0;
    let state = { commandBusy: false, stats: {} };
    const releaseStates = [];
    const sets = [];
    const api = S.createSessionApiB({
      runtime: { resume: async (id) => ({ id, messages: [] }) },
      nextId: () => `resume-item-${++sequence}`,
      flags: {}, lifecycle: {}, listeners: new Set(),
      getState: () => state,
      set: (patch) => { sets.push({ patch: exact(patch), restoredAtSet: restored }); if (patch.commandBusy === false) releaseStates.push(restored); state = { ...state, ...patch }; },
      flushEmitImmediate: () => {},
      replaceItems: (items) => items,
      clearToastTimers: () => {},
      routeState: () => ({}),
      resetStatsAndSyncContext: () => state.stats,
      restoreLeadSteeringFromDisk: () => { restoreStarted.resolve(); return restoreGate.promise.then(() => { restored = true; }); },
    });
    const steps = [];
    let settled = false;
    const resuming = api.resume('restart-session', { quiet: true }).then((value) => { settled = true; return value; });
    await withDeadline(restoreStarted.promise, 'resume started its steering restore');
    steps.push({ step: "resume('restart-session', {quiet: true}) started its steering restore (restore gate pending)", state: exact(state), settled, setsSoFar: sets.length });
    restoreGate.resolve();
    const value = await withDeadline(resuming, 'resume settled after the steering restore gate resolved');
    steps.push({ step: 'steering restore gate resolved; resume settled', resumeResult: exact(value), state: exact(state), releaseStates: exact(releaseStates) });
    cases.push({ name: 'process-restart-resume-restores-queued-steering-before-releasing-commandbusy', testLine: 90, input: exact({ resume: { id: 'restart-session', options: { quiet: true } } }), result: { steps, sets, finalState: exact(state) } });
  }

  // test line 139
  {
    const signal = new Signal();
    let startedWork = 0;
    let abortCalls = 0;
    const abortOptions = [];
    const workGate = Promise.withResolvers();
    const sessionFactory = async () => ({
      ...S.createStubSessionRuntime(),
      getSettingsSnapshot() { startedWork += 1; signal.notify(); return workGate.promise; },
      abort(options) {
        abortCalls += 1;
        abortOptions.push(exact(options));
        return { aborted: true, restoreText: 'queued prompt', pastedTexts: { text_1: { text: 'restored text' } } };
      },
    });
    const result = await withLoggedDaemon(S, async ({ discovery, calls, wire }) => {
      const client = await S.attachSession({ discovery, cwd: FIXED_CWD });
      const created = await client.call('session.create', { cwd: FIXED_CWD });
      const { sessionId } = created;
      const work = [];
      let abort;
      let startedBeforeAbort;
      let workOutcomes;
      try {
        // Each read is issued once the service has seen the previous one: all 64 are in flight together, in a fixed order.
        for (let index = 0; index < 64; index += 1) {
          work.push(client.call('session.read', { sessionId, action: 'getSettingsSnapshot', args: [index] }, { callId: `reserved-capacity-work:${index}` }));
          await signal.until(() => startedWork === index + 1, `read ${index} reached the service`);
        }
        startedBeforeAbort = startedWork;
        abort = await outcomeExact(() => client.call('session.abort', { sessionId, options: { restorePrompt: false, submissionId: 'desktop-submit-1' } }, { callId: 'reserved-capacity-abort' }));
      } finally {
        workGate.resolve();
        workOutcomes = await Promise.all(work.map((promise) => outcomeExact(() => promise)));
        await client.close('recorder end');
      }
      return {
        created: exact(created),
        startedBeforeAbort,
        abort,
        readOutcomes: workOutcomes,
        serviceCalls: calls,
        abortCalls,
        abortOptions,
        wire: await wire.exchanges(),
      };
    }, { sessionFactory });
    cases.push({ name: 'abort-starts-immediately-while-ordinary-session-calls-remain-in-flight', testLine: 139, input: exact({ reads: 64, readCallIds: 'reserved-capacity-work:<0..63>', abort: { options: { restorePrompt: false, submissionId: 'desktop-submit-1' }, callId: 'reserved-capacity-abort' }, cwd: FIXED_CWD }), result });
  }
  return { cases };
});
process.exit(0);
