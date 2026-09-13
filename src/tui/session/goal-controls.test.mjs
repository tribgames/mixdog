import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoalContinuation } from './goal-continuation.mjs';
import { createSessionApiA } from './session-api.mjs';

const immediate = () => new Promise(resolve => setImmediate(resolve));

test('goal control persists pause or stop before cancelling the live turn', async () => {
  for (const action of ['pause', 'stop']) {
    const calls = [];
    const state = { busy: true, goal: { status: 'active' } };
    const runtime = {
      goalControl: async args => { calls.push(args.action); state.goal = { status: args.action === 'pause' ? 'paused' : 'stopped' }; return { action: args.action, goal: state.goal }; },
      goalStatus: () => state.goal,
      abort: () => { calls.push(`abort:${state.goal.status}`); return true; },
    };
    const api = createSessionApiA({
      runtime, flags: { leadTurnEpoch: 1 }, pending: [], listeners: new Set(),
      getState: () => state, set: patch => Object.assign(state, patch),
      cancelQueuedGoalContinuations: () => calls.push('remove-continuation'),
    });
    await api.goalControl({ action });
    assert.deepEqual(calls, [action, 'remove-continuation', `abort:${state.goal.status}`]);
  }
});

test('idle release schedules once and yields queued work to remote ownership', async () => {
  const state = { sessionId: 'goal-owner', busy: false, commandBusy: true, goal: { id: 'goal', status: 'active' } };
  const pending = [];
  let listener;
  const runtime = {
    onGoalStatusChange: callback => { listener = callback; return () => {}; },
    goalContinuation: () => ({ run: state.goal.status === 'active', goal: state.goal, prompt: 'Continue' }),
  };
  const controller = createGoalContinuation({
    runtime, flags: {}, getState: () => state, set: patch => Object.assign(state, patch),
    getPending: () => pending, enqueue: (content, options) => pending.push({ content, ...options }),
  });
  try {
    controller.scheduleGoalContinuation();
    await immediate();
    assert.equal(pending.length, 0);
    state.commandBusy = false;
    controller.scheduleGoalContinuation();
    controller.scheduleGoalContinuation();
    await immediate();
    assert.equal(pending.length, 1);
    state.sessionRemoteAttached = true;
    listener({ sessionId: state.sessionId, goal: state.goal });
    await immediate();
    assert.equal(pending.length, 0);
  } finally { controller.disposeGoalContinuation(); }
});
