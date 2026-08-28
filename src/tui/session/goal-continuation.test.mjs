import assert from 'node:assert/strict';
import test from 'node:test';

import { createGoalContinuation } from './goal-continuation.mjs';

const settleImmediate = () => new Promise((resolve) => setImmediate(resolve));

test('completed Goal stays hidden while its user-input archive is in flight', async () => {
  const goal = { id: 'goal-complete', status: 'complete', objective: 'Finished work' };
  const state = {
    busy: false,
    commandBusy: false,
    sessionId: 'sess_goal_complete',
    goal,
  };
  let runtimeGoal = goal;
  let listener = null;
  let resolveArchive;
  const archive = new Promise((resolve) => { resolveArchive = resolve; });
  const controller = createGoalContinuation({
    runtime: {
      id: state.sessionId,
      goalStatus: () => runtimeGoal,
      archiveCompletedGoalOnUserInput: () => archive,
      onGoalStatusChange: (next) => {
        listener = next;
        return () => { listener = null; };
      },
    },
    flags: { disposed: false, pendingSessionReset: false },
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    getPending: () => [],
    enqueue: () => true,
  });
  try {
    controller.archiveCompletedGoalOnUserInput();
    assert.equal(state.goal, null);

    listener?.({ sessionId: state.sessionId, goal });
    assert.equal(state.goal, null);

    runtimeGoal = null;
    resolveArchive(null);
    await archive;
    await Promise.resolve();
    assert.equal(state.goal, null);
  } finally {
    controller.disposeGoalContinuation();
  }
});

test('failed completed Goal archive restores the persisted Goal snapshot', async () => {
  const goal = { id: 'goal-restore', status: 'complete', objective: 'Restore me' };
  const state = {
    busy: false,
    commandBusy: false,
    sessionId: 'sess_goal_restore',
    goal,
  };
  let rejectArchive;
  const archive = new Promise((_resolve, reject) => { rejectArchive = reject; });
  const controller = createGoalContinuation({
    runtime: {
      id: state.sessionId,
      goalStatus: () => goal,
      archiveCompletedGoalOnUserInput: () => archive,
      onGoalStatusChange: () => () => {},
    },
    flags: { disposed: false, pendingSessionReset: false },
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    getPending: () => [],
    enqueue: () => true,
  });
  try {
    controller.archiveCompletedGoalOnUserInput();
    assert.equal(state.goal, null);

    rejectArchive(new Error('disk write failed'));
    await archive.catch(() => {});
    await Promise.resolve();
    assert.equal(state.goal, goal);
  } finally {
    controller.disposeGoalContinuation();
  }
});

test('idle Goal schedules one hidden continuation and user input cancels it', async () => {
  const goal = { id: 'goal-1', status: 'active', objective: 'Finish it' };
  const state = { busy: false, commandBusy: false, sessionId: 'sess_goal', goal };
  const pending = [];
  let listener = null;
  const controller = createGoalContinuation({
    runtime: {
      id: 'sess_goal',
      goalStatus: () => goal,
      goalContinuation: () => ({ run: true, reason: 'idle', goal, prompt: 'hidden continuation' }),
      goalTurnStarted: async () => goal,
      goalTurnSettled: async () => goal,
      onGoalStatusChange: (next) => {
        listener = next;
        return () => { listener = null; };
      },
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

    controller.cancelQueuedGoalContinuations();
    assert.equal(pending.length, 0);

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
    await controller.onGoalTurnSettled({ status: 'done' });
    await settleImmediate();
    assert.equal(pending.length, 0);
  } finally {
    controller.disposeGoalContinuation();
  }
});

test('restart hydration preserves every non-active Goal snapshot without scheduling work', async () => {
  for (const status of ['paused', 'blocked', 'complete']) {
    const goal = {
      id: `goal-${status}`,
      status,
      objective: `Keep ${status}`,
      tasks: [{ id: 'task_1', text: 'Keep progress', status: 'completed', kind: 'work' }],
    };
    const state = {
      busy: false,
      commandBusy: false,
      sessionId: `sess_goal_${status}`,
      goal: null,
    };
    const pending = [];
    const controller = createGoalContinuation({
      runtime: {
        id: state.sessionId,
        goalStatus: () => goal,
        goalContinuation: () => ({ run: false, reason: status, goal }),
        onGoalStatusChange: () => () => {},
      },
      flags: { disposed: false, pendingSessionReset: false },
      getState: () => state,
      set: (patch) => Object.assign(state, patch),
      getPending: () => pending,
      enqueue: (text, options) => pending.push({ content: text, ...options }),
    });
    try {
      assert.equal(controller.refreshGoalState(), goal);
      assert.equal(state.goal, goal);
      controller.scheduleGoalContinuation();
      await settleImmediate();
      assert.equal(pending.length, 0);
    } finally {
      controller.disposeGoalContinuation();
    }
  }
});
