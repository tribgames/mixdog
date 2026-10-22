// Canonical-close execution fence at the local-session boundary, over the real
// queue (session-flow), the real notification feed (agent-job-feed) and the
// real lifecycle api; only the runtime beneath is a stand-in whose
// closeCanonicalSession can fire the completions a manager close would.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The durable steering mirror writes under the data dir: pin it to a temp root
// before any runtime module resolves it, so this suite never touches real data.
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-session-admission-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const { flushTuiSteeringPersist } = await import('./tui-steering-persist.mjs');
test.after(async () => {
  // In-memory admission assertions can finish before the durable queue writes.
  await flushTuiSteeringPersist();
  rmSync(dataDir, { recursive: true, force: true });
});
const { createAgentJobFeed } = await import('./agent-job-feed.mjs');
const { createSessionFlow } = await import('./session-flow.mjs');
const { createSessionApi } = await import('./session-api.mjs');
const { renderAgentCompletionEnvelope } = await import('../../runtime/shared/task-notification-envelope.mjs');
const { _clearDeliveredCompletions } = await import(
  '../../runtime/agent/orchestrator/session/manager/delivered-completions.mjs'
);

const tick = () => new Promise((resolve) => setImmediate(resolve));

function completion(executionId, meta = {}) {
  const text = renderAgentCompletionEnvelope({ id: executionId, status: 'cancelled', result: `result ${executionId}` });
  return {
    content: text,
    meta: { execution_id: executionId, status: 'cancelled', execution_surface: 'agent', ...meta },
  };
}

function harness({ close = () => true, busy = false } = {}) {
  _clearDeliveredCompletions();
  const state = { busy, commandBusy: false, queued: [], items: [], sessionId: 'sess_A', provider: '' };
  const flags = { admission: 'open' };
  const pending = [];
  const turns = [];
  const responses = [];
  let handler = null;
  let seq = 0;
  const runtime = {
    id: 'sess_A',
    interruptTaskWait() {},
    onNotification(fn) {
      handler = fn;
      return () => {};
    },
    closeCanonicalSession: (reason) => close(reason),
  };
  const real = {
    runtime,
    flags,
    pending,
    pendingNotificationKeys: new Set(),
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    nextId: () => `id-${++seq}`,
    tuiDebug() {},
    flushEmitImmediate() {},
    pushUserOrSyntheticItem() {},
    runTurn: async (content, options) => {
      turns.push({ content, options });
      return 'done';
    },
  };
  const feed = createAgentJobFeed({
    runtime,
    getState: real.getState,
    set: real.set,
    nextId: real.nextId,
    getDisposed: () => false,
    patchItem() {},
    enqueue: (...args) => real.enqueue(...args),
    drain: (...args) => real.drain(...args),
    pushUserOrSyntheticItem() {},
    pushAsyncAgentResponse: (text) => responses.push(text),
    makeQueueEntry: (...args) => real.makeQueueEntry(...args),
    getPending: () => pending,
    agentStatusState: () => ({}),
    displayedExecutionNotificationKeys: new Set(),
    itemIndexById: new Map(),
    pushNotice() {},
    getAdmission: () => flags.admission || 'open',
  });
  Object.assign(real, {
    flushDeferredExecutionPendingResumeKick: feed.flushDeferredExecutionPendingResumeKick,
    kickExecutionPendingResume: feed.kickExecutionPendingResume,
  });
  Object.assign(real, createSessionFlow(real));
  feed.subscribeRuntimeNotifications();
  const bag = new Proxy(real, { get: (target, key) => (key in target ? target[key] : () => ({})), has: () => true });
  const api = createSessionApi(bag);
  return {
    state,
    flags,
    pending,
    turns,
    responses,
    feed,
    flow: real,
    api,
    runtime,
    deliver: (event) => handler(event),
    setClose: (fn) => {
      runtime.closeCanonicalSession = (reason) => fn(reason);
    },
  };
}

test('control: a completion delivered while the session is open is queued and runs', async () => {
  const h = harness();
  h.deliver(completion('exec-open'));
  await tick();
  assert.equal(h.turns.length, 1);
  assert.match(String(h.turns[0].content), /exec-open/);
});

test('completion DURING shell cancellation (inside the manager close) starts no model work', async () => {
  const h = harness();
  h.setClose(() => {
    // The manager close cancels the shell; its completion is delivered
    // synchronously through the notification bus into the live listener.
    h.deliver(completion('exec-shell', { owner_closed: undefined }));
    return true;
  });
  assert.equal(h.api.closeCanonicalSession('agent cancel'), true);
  await tick();
  assert.deepEqual(h.turns, []);
  assert.deepEqual(h.pending, []);
  assert.equal(h.responses.length, 1, 'the result still reaches the UI/history as a card');
  assert.equal(h.flags.admission, 'terminal');
});

test('completion AFTER close and AFTER the old turn settles starts no model work', async () => {
  const h = harness({ busy: true });
  assert.equal(h.api.closeCanonicalSession('agent cancel'), true);
  h.deliver(completion('exec-after-close'));
  h.deliver(completion('exec-flagged', { owner_closed: true }));
  // The old turn settles: the busy-release hook kicks the queue.
  h.state.busy = false;
  await h.flow.drain();
  h.feed.flushDeferredExecutionPendingResumeKick();
  await tick();
  assert.deepEqual(h.turns, []);
  assert.deepEqual(h.pending, []);
  assert.equal(h.responses.length, 2);
});

test('a notification already queued when the close begins is settled, never run', async () => {
  const h = harness({ busy: true });
  h.deliver(completion('exec-queued'));
  assert.equal(h.pending.length, 1, 'queued behind the active turn');
  assert.equal(h.api.closeCanonicalSession('agent cancel'), true);
  assert.deepEqual(h.pending, []);
  assert.deepEqual(h.state.queued, []);
  h.state.busy = false;
  await h.flow.drain();
  await tick();
  assert.deepEqual(h.turns, []);
});

test('queued submissions are settled explicitly and later submissions are rejected', async () => {
  const h = harness({ busy: true });
  const settled = [];
  assert.equal(h.api.submit('first', { id: 's1', onSettled: (d) => settled.push(['s1', d.status]) }), true);
  assert.equal(h.api.submit('second', { id: 's2', onSettled: (d) => settled.push(['s2', d.status]) }), true);
  assert.equal(h.api.closeCanonicalSession('agent cancel'), true);
  assert.deepEqual(settled, [
    ['s1', 'rejected'],
    ['s2', 'rejected'],
  ]);
  assert.deepEqual(h.pending, []);
  assert.equal(h.api.submit('late'), false);
  assert.equal(await h.api.submitAsync('late async'), false);
  assert.deepEqual(await h.api.submitAndWait('late wait'), { status: 'rejected', result: null, session: null });
  assert.deepEqual(h.turns, []);
});

test('durable close failure: admission restored, accepted input retained and delivered once, cancel not successful', async () => {
  const h = harness({ busy: false });
  h.setClose(() => {
    // Input accepted while closing is held, not dropped and not run mid-close.
    assert.equal(h.api.submit('keep me', { id: 'keep' }), true);
    h.deliver(completion('exec-mid-close'));
    return false;
  });
  assert.equal(h.api.closeCanonicalSession('agent cancel'), false);
  assert.equal(h.flags.admission, 'open');
  await tick();
  assert.equal(h.turns.length, 1, 'the retained prompt runs exactly once');
  assert.match(String(h.turns[0].content), /keep me/);
  assert.ok(!String(h.turns[0].content).includes('exec-mid-close'), 'no notification-driven model work during close');
  // The runtime is usable again.
  assert.equal(h.api.submit('after failure'), true);
  await tick();
  assert.equal(h.turns.length, 2);
});

test('a throwing close restores admission and rethrows', async () => {
  const h = harness();
  h.setClose(() => {
    throw new Error('disk full');
  });
  assert.throws(() => h.api.closeCanonicalSession('agent cancel'), /disk full/);
  assert.equal(h.flags.admission, 'open');
  assert.equal(h.api.submit('still works'), true);
  await tick();
  assert.equal(h.turns.length, 1);
});

test('every admission route is closed after the canonical close', async () => {
  const h = harness();
  assert.equal(h.api.closeCanonicalSession('agent cancel'), true);
  // pending-resume kick (completion wake) and its deferred flush
  h.feed.kickExecutionPendingResume('late body', 'exec-late');
  h.feed.flushDeferredExecutionPendingResumeKick();
  // direct model-visible enqueues
  assert.equal(h.flow.enqueue('n', { mode: 'task-notification' }), false);
  assert.equal(h.flow.enqueue('p', { mode: 'pending-resume' }), false);
  assert.equal(h.flow.enqueue('g', { mode: 'goal-closeout' }), false);
  // steering / pre-send injection
  assert.equal(h.flow.hasPendingSteering(), false);
  assert.deepEqual(h.flow.drainPendingSteering(), []);
  // restored queue (abort requeue after the close) is settled, not parked
  const settled = [];
  h.flow.requeueEntriesFront([
    { id: 'r1', text: 'restored', mode: 'task-notification', onSettled: (d) => settled.push(d.status) },
  ]);
  assert.deepEqual(settled, ['rejected']);
  await h.flow.drain();
  await tick();
  assert.deepEqual(h.pending, []);
  assert.deepEqual(h.turns, []);
  // idempotent
  assert.equal(h.api.closeCanonicalSession('again'), true);
});

test('a result flagged owner_closed by the bus keeps its card but never enqueues even while the fence is open', async () => {
  const h = harness();
  h.deliver(completion('exec-flagged', { owner_closed: true }));
  await tick();
  assert.equal(h.responses.length, 1);
  assert.deepEqual(h.turns, []);
  assert.deepEqual(h.pending, []);
});
