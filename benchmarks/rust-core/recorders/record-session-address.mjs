#!/usr/bin/env node
// Golden twin of `src/session-runtime/session-address.test.mjs`: the durable address of an addressed runtime
// (`session-address.mjs`: bind / re-key refusal / resume target / canonical-close fence), `closeCanonicalSession`
// (`lifecycle/teardown/session-close.mjs`) and what the notification bus and the completion-wake scheduler
// (`notification-bus.mjs`) do for a fenced owner. The manager (`closeSession`, `enqueuePendingMessage`), the turn api
// (`ask`) and the listeners are scripted endpoints. The wake's deferred callback is a `setImmediate`: the recorder
// captures it (virtual clock: each arming and each explicit run is a recorded step) instead of waiting for the loop.
//
//   node benchmarks/rust-core/recorders/record-session-address.mjs --tree <dir>
import { exact } from './lib/exact.mjs';
import { runSessionRecorder } from './lib/session-rec.mjs';

await runSessionRecorder(import.meta.url, {
  set: 'session-address',
  testFile: 'src/session-runtime/session-address.test.mjs',
  entry: 'Ran session-address.mjs, lifecycle/teardown/session-close.mjs (closeCanonicalSession) and notification-bus.mjs (createNotificationBus, createCompletionWakeScheduler) with scripted manager / turn api; setImmediate captured and run by the recorder. Did not run a real runtime facade nor the real manager close.',
  replay: 'mixdog-core-session close fence (S/close.rs detach/close/tombstone, admission open->closing->terminal, lifecycle generation) and the completion-notification routing of a closed owner: drive the same ordered steps per case and compare every step outcome (value or error name/message/props), the runtime snapshot after each step, the manager calls, listener events, enqueued entries and wake asks.',
  values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs)',
  exclusions: ['the wake scheduler\'s setImmediate is captured and run by the recorder; the 20 ms WAKE_DELAY stderr note is not triggered (queuedAt = now) and not recorded'],
}, async ({ imp }) => {
  const A = await imp('src/session-runtime/session-address.mjs');
  const { closeCanonicalSession } = await imp('src/session-runtime/lifecycle/teardown/session-close.mjs');
  const { createCompletionWakeScheduler, createNotificationBus } = await imp('src/session-runtime/notification-bus.mjs');
  const { SessionClosedError } = await imp('src/runtime/agent/orchestrator/session/manager/session-errors.mjs');

  // The error as xact stores it (name, message, code, own props), plus which Node classes it is an instance of.
  const props = (error) => ({ error: exact(error), instanceOf: { SessionAddressError: error instanceof A.SessionAddressError, SessionClosedError: error instanceof SessionClosedError } });
  const step = async (label, fn) => {
    let result;
    try {
      const value = await fn();
      result = { ok: exact(value) };
    } catch (error) { result = props(error); }
    return { step: label, ...result };
  };
  const makeRt = () => {
    const rt = { session: null, reservedSessionId: null, sessionCreatePromise: null };
    A.initSessionAddress(rt);
    return rt;
  };
  const snap = (rt) => exact({ addressedSessionId: rt.addressedSessionId, admission: rt.admission, lifecycleGeneration: rt.lifecycleGeneration });
  const cases = [];
  const add = (name, line, input, steps, extra = {}) => cases.push({ name, testLine: line, input, result: { steps, ...extra } });

  // test line 24
  {
    const rt = makeRt();
    const steps = [];
    for (const [label, fn] of [
      ['bindSessionAddress(sess_a)', () => A.bindSessionAddress(rt, 'sess_a')],
      ['bindSessionAddress(sess_a) again', () => A.bindSessionAddress(rt, 'sess_a')],
      ['bindSessionAddress(sess_b)', () => A.bindSessionAddress(rt, 'sess_b')],
      ['assertNotAddressed(newSession)', () => A.assertNotAddressed(rt, 'newSession')],
      ['assertResumeTarget(sess_b)', () => A.assertResumeTarget(rt, 'sess_b')],
      ['assertResumeTarget(sess_a)', () => A.assertResumeTarget(rt, 'sess_a')],
    ]) steps.push({ ...(await step(label, fn)), rt: snap(rt) });
    add('address-binds-once-is-idempotent-and-refuses-a-re-key', 24, { initialRt: snap(makeRt()) }, steps);
  }

  // closeCanonicalSession scenarios
  const closeDeps = (rt, observed, getCurrent, setCurrent, closeSession) => ({
    getSession: getCurrent,
    setSession: setCurrent,
    mgr: { closeSession: (...args) => { observed.push(exact({ admission: rt.admission, args })); return closeSession(); } },
    beginCanonicalClose: (id) => A.beginCanonicalClose(rt, id),
    finishCanonicalClose: (previous, ok) => A.finishCanonicalClose(rt, previous, ok),
    isCanonicallyClosed: () => rt.admission === 'terminal',
  });

  // test line 35
  {
    const rt = makeRt();
    const observed = [];
    let current = { id: 'sess_a' };
    const deps = closeDeps(rt, observed, () => current, (v) => { current = v; }, () => true);
    const steps = [];
    steps.push({ ...(await step('closeCanonicalSession', () => closeCanonicalSession(deps))), rt: snap(rt), currentSession: exact(current), managerCalls: observed.slice() });
    steps.push({ ...(await step('closeCanonicalSession again (terminal)', () => closeCanonicalSession(deps))), rt: snap(rt), currentSession: exact(current), managerCalls: observed.slice() });
    add('close-fences-before-the-manager-close-and-goes-terminal-after-a-durable-close', 35, { session: { id: 'sess_a' }, manager: 'closeSession returns true' }, steps);
  }

  // test line 65
  {
    const rt = makeRt();
    const observed = [];
    let current = { id: 'sess_a' };
    let behaviour = () => false;
    const deps = closeDeps(rt, observed, () => current, (v) => { current = v; }, () => behaviour());
    delete deps.isCanonicallyClosed;
    const steps = [];
    steps.push({ ...(await step('closeCanonicalSession (manager returns false)', () => closeCanonicalSession(deps))), rt: snap(rt), currentSession: exact(current), managerCalls: observed.slice() });
    behaviour = () => { throw new Error('boom'); };
    steps.push({ ...(await step('closeCanonicalSession (manager throws boom)', () => closeCanonicalSession(deps))), rt: snap(rt), currentSession: exact(current), managerCalls: observed.slice() });
    add('failed-durable-close-restores-admission-and-keeps-the-session', 65, { session: { id: 'sess_a' }, manager: ['closeSession returns false', 'closeSession throws Error(boom)'] }, steps);
  }

  // notification bus
  const SHELL_DONE = '<task-notification><task-id>shell_1</task-id><status>cancelled</status></task-notification>';
  const SHELL_META = { execution_id: 'shell_1', status: 'cancelled', execution_surface: 'shell' };
  const makeBus = (rt) => {
    const enqueued = [];
    const woke = [];
    const bus = createNotificationBus({
      listeners: new Set(),
      mgr: { enqueuePendingMessage: (id, entry) => { enqueued.push(exact({ id, entry })); return 1; } },
      getOwnerLifecycle: (id) => A.ownerLifecycle(rt, id),
      onCompletionQueued: (detail) => woke.push(exact(detail)),
    });
    return { bus, woke, enqueued };
  };

  // test line 108
  {
    const rt = makeRt();
    A.bindSessionAddress(rt, 'sess_a');
    const { bus, woke, enqueued } = makeBus(rt);
    const seen = [];
    bus.subscribeRuntimeNotification('sess_a', (event) => { seen.push(exact(event.meta)); return true; });
    const notify = bus.notifyFnForSession('sess_a');
    const steps = [];
    const rec = async (label, fn) => steps.push({ ...(await step(label, fn)), rt: snap(rt), lastSeenMeta: exact(seen.at(-1)), seenCount: seen.length, enqueuedCount: enqueued.length, wakeCount: woke.length });
    await rec('notify(SHELL_DONE, shell_1) while open', () => notify(SHELL_DONE, SHELL_META));
    await rec('beginCanonicalClose', () => A.beginCanonicalClose(rt, 'sess_a'));
    await rec('notify(shell_2) while closing', () => notify(SHELL_DONE, { ...SHELL_META, execution_id: 'shell_2' }));
    await rec('finishCanonicalClose(open, true)', () => A.finishCanonicalClose(rt, 'open', true));
    await rec('notify(shell_3) while terminal', () => notify(SHELL_DONE, { ...SHELL_META, execution_id: 'shell_3' }));
    await rec('notifySessionCompletion(shell_4) while terminal', () => bus.notifySessionCompletion('sess_a', SHELL_DONE, { ...SHELL_META, execution_id: 'shell_4' }));
    add('closed-owner-keeps-the-completion-for-listeners-but-never-queues-or-wakes', 108,
      { sessionId: 'sess_a', completionText: SHELL_DONE, meta: SHELL_META },
      steps, { enqueued, woke, seen });
  }

  // test line 140
  {
    const rt = makeRt();
    A.bindSessionAddress(rt, 'sess_bare');
    const { bus, enqueued, woke } = makeBus(rt);
    const steps = [];
    steps.push(await step('finishCanonicalClose(beginCanonicalClose(sess_bare), true)', () => A.finishCanonicalClose(rt, A.beginCanonicalClose(rt, 'sess_bare'), true)));
    steps.push({ ...(await step('notifySessionCompletion', () => bus.notifySessionCompletion('sess_bare', SHELL_DONE, SHELL_META))), rt: snap(rt) });
    steps.push({ ...(await step("notifySession('plain text')", () => bus.notifySession('sess_bare', 'plain text'))), rt: snap(rt) });
    add('closed-owner-with-no-listener-reports-not-delivered', 140, { sessionId: 'sess_bare', completionText: SHELL_DONE, meta: SHELL_META }, steps, { enqueued, woke });
  }

  // test line 150
  {
    const rt = makeRt();
    A.bindSessionAddress(rt, 'sess_bare');
    const { bus, enqueued, woke } = makeBus(rt);
    const notify = bus.notifyFnForSession('sess_bare');
    rt.lifecycleGeneration = 5;
    const steps = [{ ...(await step('notify after lifecycleGeneration = 5', () => notify(SHELL_DONE, SHELL_META))), rt: snap(rt) }];
    add('callback-captured-under-an-earlier-generation-is-closed', 150, { sessionId: 'sess_bare', setLifecycleGeneration: 5 }, steps, { enqueued, woke });
  }

  // test line 160: completion wake; setImmediate is captured and run by the recorder
  {
    const rt = makeRt();
    A.bindSessionAddress(rt, 'sess_a');
    const asks = [];
    const wake = createCompletionWakeScheduler({
      getCurrentSessionId: () => 'sess_a',
      getTurnApi: () => ({ ask: async (...args) => { asks.push(exact(args)); } }),
      getOwnerLifecycle: (id) => A.ownerLifecycle(rt, id),
    });
    const realImmediate = globalThis.setImmediate;
    const captured = [];
    globalThis.setImmediate = (fn) => { captured.push(fn); return { unref() {} }; };
    const steps = [];
    try {
      steps.push({ ...(await step('wake({sessionId: sess_a, executionId: x1})', () => wake({ sessionId: 'sess_a', executionId: 'x1' }))), immediateArmed: captured.length });
      steps.push({ ...(await step('beginCanonicalClose', () => A.beginCanonicalClose(rt, 'sess_a'))), rt: snap(rt) });
      for (const fn of captured.splice(0)) steps.push({ ...(await step('run the delayed callback', () => fn())), asks: asks.slice() });
      steps.push({ ...(await step('wake({sessionId: sess_a, executionId: x2})', () => wake({ sessionId: 'sess_a', executionId: 'x2' }))), immediateArmed: captured.length });
    } finally { globalThis.setImmediate = realImmediate; }
    add('completion-wake-refuses-a-fenced-owner-at-request-time-and-in-the-delayed-callback', 160, { sessionId: 'sess_a', executionIds: ['x1', 'x2'], turnApi: 'ask records its arguments' }, steps, { asks });
  }

  // test line 178
  {
    const rt = makeRt();
    A.bindSessionAddress(rt, 'sess_a');
    const steps = [];
    steps.push({ ...(await step('assertAdmissionOpen (open)', () => A.assertAdmissionOpen(rt))), rt: snap(rt) });
    steps.push({ ...(await step('beginCanonicalClose', () => A.beginCanonicalClose(rt, 'sess_a'))), rt: snap(rt) });
    steps.push({ ...(await step('assertAdmissionOpen (closing)', () => A.assertAdmissionOpen(rt))), rt: snap(rt) });
    add('fenced-admission-raises-session-closed-error', 178, { sessionId: 'sess_a' }, steps);
  }

  return { cases };
});
