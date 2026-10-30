import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGoalRuntime } from '../../runtime/agent/orchestrator/runtime-core/goal-runtime.mjs';
import { waitUntil } from '../../runtime/shared/wait-until.test-support.mjs';
import { createGoalContinuation } from './goal-continuation.mjs';

// The lane schedules its next continuation with one setImmediate queued
// before this one, so (FIFO) it has already run when this resolves. Used only
// to assert that NOTHING was queued; positive assertions poll with waitUntil.
const tick = () => new Promise(setImmediate);
const pendingCount = (f, n) => waitUntil(() => f.pending.length === n, { message: `pending queue length ${n}` });

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'goal-idle-lifecycle-'));
  const runtime = createGoalRuntime({ dataDir, deadlineWarningMs: [] });
  const sessionId = 'goal-idle-lifecycle';
  const state = { sessionId, busy: true, commandBusy: false, goal: null };
  const pending = [];
  const controller = createGoalContinuation({
    runtime: {
      id: sessionId,
      goalStatus: () => runtime.snapshot(sessionId),
      goalContinuation: () => runtime.continuation(sessionId),
      goalTurnStarted: () => runtime.startTurn(sessionId),
      goalTurnSettled: (detail) => runtime.settleTurn(sessionId, detail),
      onGoalStatusChange: (listener) => runtime.subscribe(listener),
    },
    flags: {},
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    getPending: () => pending,
    enqueue: (content, options) => pending.push({ content, ...options }),
  });
  t.after(async () => {
    controller.disposeGoalContinuation();
    await runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const call = async (args) => JSON.parse(await runtime.executeTool('goal', args, { sessionId }));
  return { runtime, controller, dataDir, sessionId, state, pending, call };
}

test('a reached time cap stops Goal turns and queues one closeout the model may complete from', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 2_000_000_000_000 });
  const f = fixture(t);
  await f.call({ action: 'create', objective: 'Finish within the cap', time_limit_minutes: 1 });
  await f.controller.onGoalTurnStarted();
  f.state.busy = true;
  const reached = new Promise((resolve) => {
    const unsubscribe = f.runtime.subscribe(({ goal }) => {
      if (goal?.status !== 'duration_reached') return;
      unsubscribe();
      resolve();
    });
  });
  t.mock.timers.tick(60_000);
  await reached;
  assert.equal(f.state.goal.status, 'duration_reached');
  assert.equal(f.pending.length, 1);
  assert.equal(f.pending[0].mode, 'goal-closeout');
  assert.match(f.pending[0].content, /not evidence that the objective was achieved/);
  assert.equal(f.controller.shouldRunGoalContinuation(f.pending[0]), true);
  assert.equal(f.runtime.continuation(f.sessionId).run, false);
  assert.equal((await f.call({ action: 'complete' })).goal.status, 'complete');
});

test('an automatic turn without a tool call waits until a user turn', async (t) => {
  const f = fixture(t);
  await f.call({ action: 'create', objective: 'Keep improving within the cap', time_limit_minutes: 60 });
  const turn = async (detail) => {
    f.pending.length = 0;
    f.state.busy = true;
    await f.controller.onGoalTurnStarted();
    f.state.busy = false;
    await f.controller.onGoalTurnSettled({ status: 'done', ...detail });
    await tick();
  };
  await turn({ automatic: true, toolCalls: 3 });
  assert.equal(f.pending.length, 1);
  assert.equal(f.pending[0].mode, 'goal-continuation');
  await turn({ automatic: true, toolCalls: 0 });
  assert.deepEqual(f.pending, []);
  assert.equal(f.runtime.continuation(f.sessionId).reason, 'no-progress-wait');
  f.controller.scheduleGoalContinuation();
  await tick();
  assert.deepEqual(f.pending, []);
  await turn({ automatic: false, toolCalls: 0 });
  assert.equal(f.pending.length, 1);
  assert.equal(f.pending[0].mode, 'goal-continuation');
});

test('an automatic blocker re-check keeps Goal turns going only while it calls tools', async (t) => {
  const f = fixture(t);
  await f.call({
    action: 'create',
    objective: 'Train once the GPU is free',
  });
  await f.controller.onGoalTurnStarted();
  f.state.busy = false;
  await f.controller.onGoalTurnSettled({ status: 'done', automatic: true, toolCalls: 1 });
  await pendingCount(f, 1);
  assert.equal(f.pending[0].mode, 'goal-continuation');

  f.pending.length = 0;
  await f.controller.onGoalTurnStarted();
  await f.controller.onGoalTurnSettled({ status: 'done', automatic: true, toolCalls: 0 });
  await tick();
  assert.deepEqual(f.pending, []);
  assert.equal(f.runtime.continuation(f.sessionId).reason, 'no-progress-wait');
  assert.equal(f.state.goal.status, 'active');
});

test('a terminal compact error clears queued Goal work and remains blocked after restart', async (t) => {
  const f = fixture(t);
  await f.call({
    action: 'create',
    objective: 'Keep unfinished work honest',
  });
  await f.controller.onGoalTurnStarted();
  const queued = { mode: 'goal-continuation', goalId: f.state.goal.id, content: 'Stale automatic work' };
  f.pending.push(queued);
  const error = 'agent compact failed: mandatory session context exceeds compact budget=250000 (mandatory=263795)';
  f.state.busy = false;
  await f.controller.onGoalTurnSettled({ status: 'failed', error });
  await tick();
  assert.equal(f.state.goal.status, 'blocked');
  assert.equal(f.state.goal.blocker, error);
  assert.deepEqual(f.pending, []);
  assert.equal(f.controller.shouldRunGoalContinuation(queued), false);

  await f.runtime.close();
  const restored = createGoalRuntime({ dataDir: f.dataDir });
  t.after(() => restored.close());
  assert.equal(restored.continuation(f.sessionId).reason, 'blocked');
  await restored.control(f.sessionId, { action: 'resume' });
  assert.equal(restored.continuation(f.sessionId).run, true);
});
