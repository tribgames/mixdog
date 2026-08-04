import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AgentAwakeService, AWAKE_STALE_AFTER_MS, snapshotHasActiveWork } from './agent-awake.ts';
import { createTurnAttention, turnInProgress } from './turn-attention.ts';

function fakeBlocker() {
  const state = { nextId: 1, active: new Set(), starts: 0, stops: 0 };
  return {
    state,
    start(type) {
      assert.equal(type, 'prevent-app-suspension');
      const id = state.nextId++;
      state.active.add(id);
      state.starts += 1;
      return id;
    },
    stop(id) {
      state.active.delete(id);
      state.stops += 1;
    },
    isStarted(id) {
      return state.active.has(id);
    },
  };
}

test('snapshotHasActiveWork mirrors renderer activity plus background shell jobs', () => {
  assert.equal(snapshotHasActiveWork(null), false);
  assert.equal(snapshotHasActiveWork({}), false);
  assert.equal(snapshotHasActiveWork({ busy: true }), true);
  assert.equal(snapshotHasActiveWork({ commandBusy: true }), true);
  assert.equal(snapshotHasActiveWork({ thinking: 'planning' }), true);
  assert.equal(snapshotHasActiveWork({ spinner: { mode: 'work' } }), true);
  assert.equal(snapshotHasActiveWork({ spinner: { active: false } }), false);
  assert.equal(snapshotHasActiveWork({ commandStatus: { active: false } }), false);
  assert.equal(snapshotHasActiveWork({ shellJobs: { count: 2 } }), true);
  assert.equal(snapshotHasActiveWork({ shellJobs: { count: 0 } }), false);
});

test('awake service blocks only while enabled AND working, without churn', () => {
  const blocker = fakeBlocker();
  const service = new AgentAwakeService(blocker);

  service.onSnapshot({ busy: true });
  assert.equal(service.isBlocking(), true);
  service.onSnapshot({ busy: true });
  service.onSnapshot({ busy: true });
  assert.equal(blocker.state.starts, 1, 'repeat snapshots must not restart the blocker');

  service.onSnapshot({ busy: false });
  assert.equal(service.isBlocking(), false);
  assert.equal(blocker.state.stops, 1);

  service.setEnabled(false);
  service.onSnapshot({ busy: true });
  assert.equal(service.isBlocking(), false, 'disabled service must never block');

  service.setEnabled(true);
  assert.equal(service.isBlocking(), true, 're-enabling mid-work resumes the blocker');
  service.dispose();
  assert.equal(service.isBlocking(), false);
});

test('a frozen working signal is released after the stale window', () => {
  const blocker = fakeBlocker();
  let now = 1_000;
  const service = new AgentAwakeService(blocker, () => now);
  service.onSnapshot({ busy: true });
  assert.equal(service.isBlocking(), true);

  now += AWAKE_STALE_AFTER_MS + 1;
  service.reevaluate();
  assert.equal(service.isBlocking(), false, 'stale signal must not hold the machine awake');

  // A fresh signal re-arms it.
  service.onSnapshot({ busy: true });
  assert.equal(service.isBlocking(), true);
  service.dispose();
});

test('blocker failures stay best-effort', () => {
  const service = new AgentAwakeService({
    start() { throw new Error('platform refused'); },
    stop() { throw new Error('platform refused'); },
    isStarted() { return false; },
  });
  service.onSnapshot({ busy: true });
  assert.equal(service.isBlocking(), false);
  service.dispose();
});

test('turn attention flashes only on busy→idle while unfocused, cleared by focus', () => {
  assert.equal(turnInProgress({ busy: true }), true);
  assert.equal(turnInProgress({ commandBusy: true }), true);
  assert.equal(turnInProgress({}), false);
  assert.equal(turnInProgress(null), false);

  const calls = [];
  let focused = true;
  const attention = createTurnAttention({
    isFocused: () => focused,
    flashFrame: (flag) => calls.push(['flash', flag]),
    bounceDock: () => calls.push(['bounce']),
  });

  // Focused completion: no signal.
  attention.onSnapshot({ busy: true });
  attention.onSnapshot({ busy: false });
  assert.deepEqual(calls, []);

  // Unfocused completion: flash + bounce, then focus clears the flash.
  focused = false;
  attention.onSnapshot({ busy: true });
  attention.onSnapshot({ busy: false });
  assert.deepEqual(calls, [['flash', true], ['bounce']]);
  attention.onFocus();
  assert.deepEqual(calls, [['flash', true], ['bounce'], ['flash', false]]);

  // Focus without a pending signal must not touch the frame.
  attention.onFocus();
  assert.deepEqual(calls, [['flash', true], ['bounce'], ['flash', false]]);

  // Idle→idle pushes never signal.
  attention.onSnapshot({ busy: false });
  attention.onSnapshot({ busy: false });
  assert.deepEqual(calls, [['flash', true], ['bounce'], ['flash', false]]);
});
