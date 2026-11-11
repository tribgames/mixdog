#!/usr/bin/env node
// Golden twin of `scripts/session-transport/steering-recovery.test.mjs`: busy-input steering and abort recovery.
//   14  `createSessionApiA().submitAsync` ACKs queue intake before auto-clear settles, `abort({restorePrompt,
//       submissionId})` reclaims the acknowledged entry (scripted queue; the clear gate is a promise the recorder
//       resolves as an explicit, recorded step);
//   75  `appendTuiSteeringPersist` / `readTuiSteeringPersist` keep the submission identity (real spool files in the
//       runtime root, recorded);
//   90  `createSessionApiB().resume` holds the command gate until the steering restore settled (two gates, recorded
//       steps; one setImmediate turn is a recorded step);
//   139 `session.abort` over the real HTTP session transport starts at once while 64 ordinary `session.read` calls
//       are in flight (stub runtime; the 64 reads are released by the recorder after the abort answered).
//
//   node benchmarks/rust-core/recorders/record-session-transport-steering-recovery.mjs --tree <dir>
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { NORMALISED, Signal, callOutcome, createNormaliser, withLoggedDaemon } from './lib/session-daemon-harness.mjs';
import { runSessionRecorder } from './lib/session-rec.mjs';

await runSessionRecorder(import.meta.url, {
  set: 'session-transport-steering-recovery',
  testFile: 'scripts/session-transport/steering-recovery.test.mjs',
  entry: 'Cases 14 and 90 ran the real src/tui/session/session-api.mjs createSessionApiA and session-api-ext.mjs createSessionApiB with scripted dependencies (queue, state setter, restore hooks); case 75 ran src/tui/session/tui-steering-persist.mjs on a temp MIXDOG_DATA_DIR (spool files recorded); case 139 ran the real HTTP session transport + session service + session-client attachSession with the stub runtime of scripts/session-transport/_shared.mjs, 64 gated reads and one abort. Did not run a real runtime or any TUI rendering.',
  replay: 'mixdog-core-session S/control.rs steer / S/actor.rs restore_taken, restored_reply (ACK before auto-clear, targeted abort reclaim), the durable pending queue (steering persisted with its submission id/time) and the abort control path: drive the same ordered steps and compare each step\'s outcome and the observed state (enqueued count, queue length, restored text/ids, commandBusy, release states, spool rows, abort options/result, service call order).',
  exclusions: [
    'case 75: ids ts_<base36 ms>_<8 hex> (steeringPersistId, spool text) -> ts_<id>; 13-digit ms timestamps in the spool text -> <ms>; submittedAt is recorded as its offset from the time the recorder took (-50 as in the test)',
    'case 139: the 64 reads reach the service in HTTP arrival order, which varies: recorded sorted by their args[0] index; the single abort call is recorded with its position relative to the reads (after all 64 started)',
    ...NORMALISED,
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
      set: (patch) => { state = { ...state, ...patch }; log.push({ set: patch }); },
      routeState: () => ({}),
      autoClearBeforeSubmit: () => { log.push('autoClearBeforeSubmit called'); return clearGate.promise; },
      enqueue: (text, options) => { enqueued += 1; queued.push({ text, id: options.id }); log.push({ enqueue: { text, id: options.id } }); return true; },
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
    steps.push({ step: "submitAsync('recover before busy', {id: actual-session-idle-1}) (auto-clear gate still pending)", result: ack, enqueued });
    const restored = api.abort({ restorePrompt: true, submissionId: 'actual-session-idle-1' });
    steps.push({ step: "abort({restorePrompt: true, submissionId: 'actual-session-idle-1'})", result: restored, queuedLength: queued.length });
    clearGate.resolve();
    steps.push({ step: 'resolve the auto-clear gate', queuedLength: queued.length, enqueued });
    cases.push({ name: 'submit-ack-does-not-wait-for-auto-clear-and-remains-reclaimable', testLine: 14, input: { submit: { text: 'recover before busy', options: { id: 'actual-session-idle-1' } }, abort: { restorePrompt: true, submissionId: 'actual-session-idle-1' }, initialState: { busy: false, commandBusy: false } }, result: { steps, log, finalState: state } });
  }

  // test line 75
  {
    const ids = createNormaliser(S.RUNTIME_ROOT);
    const now = Date.now();
    const sessionId = 'steering-recovery-recorded';
    const entry = { id: 'desktop-submit-retry-1', text: 'ship it', submittedAt: now - 50 };
    await S.appendTuiSteeringPersist(sessionId, entry);
    const restored = await S.readTuiSteeringPersist(sessionId);
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
    const spool = walk(S.RUNTIME_ROOT).filter((f) => /pending|spool/i.test(f) && statSync(f).isFile());
    const normText = (t) => t.replace(/ts_[0-9a-z]+_[0-9a-f]{8}/g, 'ts_<id>').replace(/\b1[0-9]{12}\b/g, (m) => (Number(m) === entry.submittedAt ? '<submittedAt>' : '<ms>'));
    cases.push({
      name: 'persisted-steering-keeps-the-desktop-submission-identity-across-recovery',
      testLine: 75,
      input: { sessionId, entry: { id: entry.id, text: entry.text, submittedAt: '<now-50>' } },
      result: {
        restored: restored.map((row) => ({ ...row, steeringPersistId: row.steeringPersistId.replace(/ts_[0-9a-z]+_[0-9a-f]{8}/, 'ts_<id>'), submittedAt: row.submittedAt === entry.submittedAt ? '<now-50>' : row.submittedAt })),
        restoredSubmittedAtEqualsEntry: restored[0]?.submittedAt === entry.submittedAt,
        spoolFiles: spool.map((f) => ({ path: relative(S.RUNTIME_ROOT, f).replaceAll('\\', '/').replace(/ts_[0-9a-z]+_[0-9a-f]{8}/g, 'ts_<id>'), text: ids.norm(normText(readFileSync(f, 'utf8'))) })).sort((a, b) => (a.path < b.path ? -1 : 1)),
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
      set: (patch) => { sets.push({ patch, restoredAtSet: restored }); if (patch.commandBusy === false) releaseStates.push(restored); state = { ...state, ...patch }; },
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
    await restoreStarted.promise;
    await new Promise((resolve) => setImmediate(resolve));
    steps.push({ step: "resume('restart-session', {quiet: true}) started; steering restore pending; one setImmediate turn", commandBusy: state.commandBusy, settled });
    restoreGate.resolve();
    const value = await resuming;
    steps.push({ step: 'steering restore gate resolved; resume settled', resumeResult: value, commandBusy: state.commandBusy, releaseStates });
    cases.push({ name: 'process-restart-resume-restores-queued-steering-before-releasing-commandbusy', testLine: 90, input: { resume: { id: 'restart-session', options: { quiet: true } } }, result: { steps, sets, finalState: state } });
  }

  // test line 139
  {
    const ids = createNormaliser(S.RUNTIME_ROOT);
    const signal = new Signal();
    let startedWork = 0;
    let abortCalls = 0;
    let abortOptions = null;
    const workGate = Promise.withResolvers();
    const sessionFactory = async () => ({
      ...S.createStubSessionRuntime(),
      getSettingsSnapshot() { startedWork += 1; signal.notify(); return workGate.promise; },
      abort(options) {
        abortCalls += 1;
        abortOptions = options;
        return { aborted: true, restoreText: 'queued prompt', pastedTexts: { text_1: { text: 'restored text' } } };
      },
    });
    const result = await withLoggedDaemon(S, ids.norm, ids, async ({ discovery, calls }) => {
      const client = await S.attachSession({ discovery, cwd: process.cwd() });
      const { sessionId } = await client.call('session.create', { cwd: process.cwd() });
      const work = Array.from({ length: 64 }, (_, index) => client.call('session.read', { sessionId, action: 'getSettingsSnapshot', args: [index] }, { callId: `reserved-capacity-work:${index}` }));
      let abort;
      let startedBeforeAbort;
      let workOutcomes;
      try {
        await signal.until(() => startedWork === work.length, 'the 64 ordinary session.read calls started at the service');
        startedBeforeAbort = startedWork;
        abort = await callOutcome(ids.norm, client.call('session.abort', { sessionId, options: { restorePrompt: false, submissionId: 'desktop-submit-1' } }, { callId: 'reserved-capacity-abort' }));
      } finally {
        workGate.resolve();
        workOutcomes = await Promise.all(work.map((promise) => callOutcome(ids.norm, promise)));
        await client.close('recorder end');
      }
      const reads = calls.filter((c) => c.name === 'session.read').sort((a, b) => a.args.args[0] - b.args.args[0]);
      return {
        startedBeforeAbort,
        abort,
        abortCallIndex: calls.findIndex((c) => c.name === 'session.abort'),
        serviceCallNamesInOrder: calls.map((c) => c.name).map((n, i, all) => (n === 'session.read' ? 'session.read' : n)).filter((n, i, all) => n !== 'session.read' || all[i - 1] !== 'session.read'),
        reads: reads.map(({ args, context, result, error }) => ({ args, callIdContext: context, result: result ?? null, error: error ?? null })),
        readOutcomes: workOutcomes,
        abortCall: calls.find((c) => c.name === 'session.abort'),
        abortCalls,
        abortOptions,
      };
    }, { sessionFactory });
    cases.push({ name: 'abort-starts-immediately-while-ordinary-session-calls-remain-in-flight', testLine: 139, input: { reads: 64, readCallIds: 'reserved-capacity-work:<0..63>', abort: { options: { restorePrompt: false, submissionId: 'desktop-submit-1' }, callId: 'reserved-capacity-abort' } }, result });
  }
  return { cases };
});
process.exit(0);