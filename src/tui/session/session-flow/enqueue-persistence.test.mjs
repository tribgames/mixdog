import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

let persisted;
const dropped = [];
mock.module('../tui-steering-persist.mjs', {
  namedExports: {
    appendTuiSteeringPersist: (_sessionId, entry) => {
      entry.steeringPersistId = `ts_${entry.id}`;
      return persisted;
    },
    dropTuiSteeringPersist: (sessionId, entries) => {
      dropped.push([sessionId, entries.map((entry) => entry.steeringPersistId)]);
      return Promise.resolve();
    },
    drainTuiSteeringPersist: async () => [],
  },
});
const { createSessionFlow } = await import('../session-flow.mjs');

function busyFlow() {
  const state = { busy: true, commandBusy: false, queued: [] };
  const pending = [];
  let nextId = 0;
  const flow = createSessionFlow({
    runtime: { id: 'session-persistence' },
    flags: {},
    pending,
    pendingNotificationKeys: new Set(),
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    nextId: () => `queued-${++nextId}`,
    tuiDebug() {},
    pushUserOrSyntheticItem() {},
    flushDeferredExecutionPendingResumeKick() {},
    runTurn: async () => 'done',
  });
  return { state, pending, flow };
}

test('a steering prompt a turn already took stays accepted when its durable mirror fails', async () => {
  const f = busyFlow();
  let fail;
  persisted = new Promise((resolve) => {
    fail = () => resolve(false);
  });
  const accepted = f.flow.enqueue('steer this', { id: 'submit-1', awaitPersistence: true });
  const steered = f.flow.drainPendingSteering({ turnEpoch: 1 });
  assert.deepEqual(
    steered.map((message) => message.content),
    ['steer this']
  );
  fail();
  assert.equal(await accepted, true);
});

test('a steering prompt still queued is withdrawn and rejected when its durable mirror fails', async () => {
  const f = busyFlow();
  persisted = Promise.resolve(false);
  assert.equal(await f.flow.enqueue('steer this', { id: 'submit-2', awaitPersistence: true }), false);
  assert.deepEqual(f.pending, []);
  assert.deepEqual(f.state.queued, []);
  assert.deepEqual(f.flow.drainPendingSteering({ turnEpoch: 1 }), []);
});

test('a queued prompt restored to the draft drops its durable steering mirror', async () => {
  const f = busyFlow();
  persisted = Promise.resolve(true);
  assert.equal(await f.flow.enqueue('take me back', { id: 'submit-3', awaitPersistence: true }), true);
  dropped.length = 0;
  const restored = f.flow.restoreQueued('', 'submit-3');
  assert.equal(restored.count, 1);
  assert.deepEqual(dropped, [['session-persistence', ['ts_submit-3']]]);
});
