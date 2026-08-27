import assert from 'node:assert/strict';
import test from 'node:test';

import { createGoalContinuation } from './goal-continuation.mjs';

const settleImmediate = () => new Promise((resolve) => setImmediate(resolve));

test('idle Goal schedules one hidden continuation and user input cancels it', async () => {
  const goal = { id: 'goal-1', status: 'active', objective: 'Finish it' };
  const state = { busy: false, commandBusy: false, sessionId: 'sess_goal', goal };
  const pending = [];
  let listener = null;
  let archived = 0;
  const controller = createGoalContinuation({
    runtime: {
      id: 'sess_goal',
      goalStatus: () => goal,
      goalContinuation: () => ({ run: true, reason: 'idle', goal, prompt: 'hidden continuation' }),
      onGoalStatusChange: (next) => {
        listener = next;
        return () => { listener = null; };
      },
      archiveCompletedGoalOnUserInput: async () => { archived += 1; },
    },
    flags: { disposed: false, pendingSessionReset: false },
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    getPending: () => pending,
    enqueue: (text, options) => {
      pending.push({ content: text, ...options });
      return true;
    },
  });
  try {
    assert.equal(controller.scheduleGoalContinuation(), true);
    controller.scheduleGoalContinuation();
    await settleImmediate();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].mode, 'goal-continuation');
    assert.equal(pending[0].priority, 'later');
    assert.equal(controller.shouldRunGoalContinuation(pending[0]), true);

    controller.archiveCompletedGoalOnUserInput();
    assert.equal(pending.length, 0);
    await settleImmediate();
    assert.equal(archived, 1);

    listener?.({ sessionId: 'sess_goal', goal: { ...goal, status: 'paused' } });
    await settleImmediate();
    assert.equal(pending.length, 0);
  } finally {
    controller.disposeGoalContinuation();
  }
});

test('busy or agent-parked Goal does not enqueue a continuation', async () => {
  const goal = { id: 'goal-2', status: 'active' };
  const state = { busy: true, commandBusy: false, sessionId: 'sess_goal_busy', goal };
  const pending = [];
  const controller = createGoalContinuation({
    runtime: {
      id: 'sess_goal_busy',
      goalStatus: () => goal,
      goalContinuation: () => ({ run: false, reason: 'agent-running', goal }),
      onGoalStatusChange: () => () => {},
    },
    flags: { disposed: false, pendingSessionReset: false },
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    getPending: () => pending,
    enqueue: (text, options) => pending.push({ content: text, ...options }),
  });
  try {
    controller.scheduleGoalContinuation();
    await settleImmediate();
    assert.equal(pending.length, 0);
    state.busy = false;
    controller.onGoalTurnSettled('done');
    await settleImmediate();
    assert.equal(pending.length, 0);
  } finally {
    controller.disposeGoalContinuation();
  }
});
