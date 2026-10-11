import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SessionAddressError,
  assertAdmissionOpen,
  assertNotAddressed,
  assertResumeTarget,
  beginCanonicalClose,
  finishCanonicalClose,
  initSessionAddress,
  bindSessionAddress,
  ownerLifecycle,
} from './session-address.mjs';
import { closeCanonicalSession } from './lifecycle/teardown/session-close.mjs';
import { createCompletionWakeScheduler, createNotificationBus } from './notification-bus.mjs';
import { SessionClosedError } from '../runtime/agent/orchestrator/session/manager/session-errors.mjs';

function makeRt() {
  const rt = { session: null, reservedSessionId: null, sessionCreatePromise: null };
  initSessionAddress(rt);
  return rt;
}

test('the address binds once, is idempotent for the same id and refuses a re-key', () => {
  const rt = makeRt();
  assert.equal(bindSessionAddress(rt, 'sess_a'), 'sess_a');
  assert.equal(bindSessionAddress(rt, 'sess_a'), 'sess_a');
  assert.throws(() => bindSessionAddress(rt, 'sess_b'), SessionAddressError);
  assert.throws(() => assertNotAddressed(rt, 'newSession'), SessionAddressError);
  assert.throws(() => assertResumeTarget(rt, 'sess_b'), SessionAddressError);
  assertResumeTarget(rt, 'sess_a');
  assert.equal(rt.addressedSessionId, 'sess_a');
});

test('closeCanonicalSession fences before the manager close and goes terminal only after a durable close', () => {
  const rt = makeRt();
  const observed = [];
  const session = { id: 'sess_a' };
  let current = session;
  const mgr = {
    closeSession() {
      observed.push(rt.admission);
      return true;
    },
  };
  const deps = {
    getSession: () => current,
    setSession: (v) => {
      current = v;
    },
    mgr,
    beginCanonicalClose: (id) => beginCanonicalClose(rt, id),
    finishCanonicalClose: (previous, ok) => finishCanonicalClose(rt, previous, ok),
    isCanonicallyClosed: () => rt.admission === 'terminal',
  };
  assert.equal(closeCanonicalSession(deps), true);
  assert.deepEqual(observed, ['closing'], 'admission was fenced while the manager close ran');
  assert.equal(rt.admission, 'terminal');
  assert.equal(rt.addressedSessionId, 'sess_a', 'the address survives the close');
  assert.equal(rt.lifecycleGeneration, 1);
  assert.equal(current, null);
  assert.equal(closeCanonicalSession(deps), true, 'closing a terminal runtime is idempotent');
});

test('a failed durable close restores admission and keeps the session', () => {
  const rt = makeRt();
  let current = { id: 'sess_a' };
  const deps = {
    getSession: () => current,
    setSession: (v) => {
      current = v;
    },
    mgr: { closeSession: () => false },
    beginCanonicalClose: (id) => beginCanonicalClose(rt, id),
    finishCanonicalClose: (previous, ok) => finishCanonicalClose(rt, previous, ok),
  };
  assert.equal(closeCanonicalSession(deps), false);
  assert.equal(rt.admission, 'open');
  assert.equal(rt.lifecycleGeneration, 0);
  assert.equal(current.id, 'sess_a');
  deps.mgr.closeSession = () => {
    throw new Error('boom');
  };
  assert.throws(() => closeCanonicalSession(deps), /boom/);
  assert.equal(rt.admission, 'open');
});

function makeBus(rt, { enqueued = [] } = {}) {
  const woke = [];
  const mgr = {
    enqueuePendingMessage: (id, entry) => {
      enqueued.push({ id, entry });
      return 1;
    },
  };
  const bus = createNotificationBus({
    listeners: new Set(),
    mgr,
    getOwnerLifecycle: (id) => ownerLifecycle(rt, id),
    onCompletionQueued: (detail) => woke.push(detail),
  });
  return { bus, woke, enqueued };
}

const SHELL_DONE = '<task-notification><task-id>shell_1</task-id><status>cancelled</status></task-notification>';
const SHELL_META = { execution_id: 'shell_1', status: 'cancelled', execution_surface: 'shell' };

test('a closed owner keeps the completion for listeners but never queues or wakes the model', () => {
  const rt = makeRt();
  bindSessionAddress(rt, 'sess_a');
  const { bus, woke, enqueued } = makeBus(rt);
  const seen = [];
  bus.subscribeRuntimeNotification('sess_a', (event) => {
    seen.push(event.meta);
    return true;
  });
  // The fn a shell job captured while the owner was still open.
  const notify = bus.notifyFnForSession('sess_a');
  assert.equal(notify(SHELL_DONE, SHELL_META), true);
  assert.equal(seen.at(-1).owner_closed, undefined);

  beginCanonicalClose(rt, 'sess_a');
  assert.equal(notify(SHELL_DONE, { ...SHELL_META, execution_id: 'shell_2' }), true, 'UI/history still handled');
  assert.equal(seen.at(-1).owner_closed, true);
  finishCanonicalClose(rt, 'open', true);
  assert.equal(notify(SHELL_DONE, { ...SHELL_META, execution_id: 'shell_3' }), true);
  assert.equal(seen.at(-1).owner_closed, true);
  assert.equal(bus.notifySessionCompletion('sess_a', SHELL_DONE, { ...SHELL_META, execution_id: 'shell_4' }), true);
  assert.deepEqual(
    enqueued.filter((e) => /shell_[234]/.test(JSON.stringify(e.entry))),
    [],
    'no model-visible enqueue after the fence'
  );
  assert.ok(
    woke.every((w) => w.executionId === 'shell_1'),
    'a wake is only ever requested for the completion delivered while the owner was open'
  );
});

test('a closed owner with no listener reports the completion as not delivered instead of queuing it', () => {
  const rt = makeRt();
  bindSessionAddress(rt, 'sess_bare');
  const { bus, enqueued } = makeBus(rt);
  finishCanonicalClose(rt, beginCanonicalClose(rt, 'sess_bare'), true);
  assert.equal(bus.notifySessionCompletion('sess_bare', SHELL_DONE, SHELL_META), false);
  assert.equal(bus.notifySession('sess_bare', 'plain text'), false);
  assert.deepEqual(enqueued, []);
});

test('a callback captured under an earlier lifecycle generation is treated as closed', () => {
  const rt = makeRt();
  bindSessionAddress(rt, 'sess_bare');
  const { bus, enqueued } = makeBus(rt);
  const notify = bus.notifyFnForSession('sess_bare');
  rt.lifecycleGeneration = 5; // owner re-materialized under a new generation
  assert.equal(notify(SHELL_DONE, SHELL_META), false);
  assert.deepEqual(enqueued, []);
});

test('the completion wake refuses a fenced owner at request time and inside the delayed callback', async () => {
  const rt = makeRt();
  bindSessionAddress(rt, 'sess_a');
  const asks = [];
  const wake = createCompletionWakeScheduler({
    getCurrentSessionId: () => 'sess_a',
    getTurnApi: () => ({ ask: async (...args) => asks.push(args) }),
    getOwnerLifecycle: (id) => ownerLifecycle(rt, id),
  });
  assert.equal(wake({ sessionId: 'sess_a', executionId: 'x1' }), true);
  // Close begins after the wake was scheduled but before its callback runs.
  beginCanonicalClose(rt, 'sess_a');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asks, [], 'the delayed callback re-validates the owner');
  assert.equal(wake({ sessionId: 'sess_a', executionId: 'x2' }), false);
});

test('SessionClosedError is what a fenced admission raises', () => {
  const rt = makeRt();
  bindSessionAddress(rt, 'sess_a');
  assertAdmissionOpen(rt);
  beginCanonicalClose(rt, 'sess_a');
  assert.throws(() => assertAdmissionOpen(rt), SessionClosedError);
});
