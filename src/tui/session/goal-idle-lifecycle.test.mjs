import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGoalRuntime } from '../../session-runtime/goal-runtime.mjs';
import { createGoalContinuation } from './goal-continuation.mjs';

const tick = () => new Promise(setImmediate);

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

test('completed duration work waits on the deadline timer without generating more Goal turns', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 2_000_000_000_000 });
  const f = fixture(t);
  await f.call({
    action: 'create',
    objective: 'Finish the approved duration',
    time_limit_minutes: 1,
    time_mode: 'duration',
    tasks: [{ text: 'Verified deliverable', status: 'completed', kind: 'verification' }],
  });
  await f.controller.onGoalTurnStarted();
  f.state.busy = false;
  await f.controller.onGoalTurnSettled({ status: 'done' });
  await tick();
  assert.deepEqual(f.pending, []);
  assert.equal(f.runtime.continuation(f.sessionId).reason, 'duration-wait');
  await assert.rejects(f.call({ action: 'complete' }), /before the requested duration/);

  for (let index = 0; index < 109; index++) f.controller.scheduleGoalContinuation();
  t.mock.timers.tick(59_000);
  await tick();
  assert.deepEqual(f.pending, []);
  assert.equal(f.state.goal.status, 'active');
  assert.equal(f.runtime.snapshot(f.sessionId).remainingMs, 1_000);

  const reached = new Promise((resolve) => {
    const unsubscribe = f.runtime.subscribe(({ goal }) => {
      if (goal?.status !== 'duration_reached') return;
      unsubscribe();
      resolve();
    });
  });
  t.mock.timers.tick(1_000);
  await reached;
  await tick();
  assert.equal(f.state.goal.status, 'duration_reached');
  assert.equal(f.pending.length, 1);
  assert.equal(f.pending[0].mode, 'goal-closeout');
  assert.equal(f.controller.shouldRunGoalContinuation(f.pending[0]), true);
  assert.equal((await f.call({ action: 'complete', revision: f.state.goal.revision })).goal.status, 'complete');
});

test('new work wakes a duration wait without extending the approved budget', async (t) => {
  const f = fixture(t);
  const created = (
    await f.call({
      action: 'create',
      objective: 'Finish the approved duration',
      time_limit_minutes: 60,
      time_mode: 'duration',
      tasks: [{ text: 'Verified deliverable', status: 'completed', kind: 'work' }],
    })
  ).goal;
  f.state.busy = false;
  await tick();
  // A settled list earns one review turn first; this test covers the wake that
  // follows it, so consume that entry before adding the new work.
  assert.equal(f.pending.length, 1);
  f.pending.length = 0;
  await f.call({
    action: 'update_tasks',
    tasks: [{ text: 'User-approved additional check', status: 'pending', kind: 'verification' }],
  });
  await tick();
  assert.equal(f.state.goal.timeLimitMs, created.timeLimitMs);
  assert.equal(f.pending.length, 1);
  assert.equal(f.pending[0].mode, 'goal-continuation');
  assert.equal(f.controller.shouldRunGoalContinuation(f.pending[0]), true);
});

test('a settled duration list gets one review turn before the deadline wait', async (t) => {
  const f = fixture(t);
  await f.call({
    action: 'create',
    objective: 'Finish the approved duration',
    time_limit_minutes: 60,
    time_mode: 'duration',
    tasks: [{ text: 'Verified deliverable', status: 'completed', kind: 'work' }],
  });
  f.state.busy = false;
  await tick();
  assert.equal(f.runtime.continuation(f.sessionId).reason, 'idle-review');
  assert.equal(f.pending.length, 1);
  assert.equal(f.pending[0].mode, 'goal-continuation');
  assert.match(f.pending[0].content, /set_tasks/);

  // The review turn ran and recorded nothing new: the deadline timer owns the
  // remaining duration instead of another identical continuation.
  f.pending.length = 0;
  await f.controller.onGoalTurnStarted();
  f.state.busy = false;
  await f.controller.onGoalTurnSettled({ status: 'done' });
  await tick();
  assert.equal(f.runtime.continuation(f.sessionId).reason, 'duration-wait');
  assert.deepEqual(f.pending, []);

  // A changed task list is a new chance, not the same answered one.
  await f.call({
    action: 'update_tasks',
    tasks: [{ text: 'Recorded follow-up outcome', status: 'completed', kind: 'work' }],
  });
  assert.equal(f.runtime.continuation(f.sessionId).reason, 'idle-review');
});

test('duration waiting cannot suppress unfinished work, objective review, or maximum-budget closeout', async (t) => {
  for (const scenario of ['unfinished', 'unrecorded', 'objective-review', 'max', 'block-audit']) {
    await t.test(scenario, async (t) => {
      const f = fixture(t);
      await f.call({
        action: 'create',
        objective: 'Original approved objective',
        time_limit_minutes: 60,
        time_mode: scenario === 'max' ? 'max' : 'duration',
        ...(scenario === 'unrecorded'
          ? {}
          : {
              tasks: [
                {
                  text: 'Required verification',
                  status: scenario === 'unfinished' ? 'pending' : 'completed',
                  kind: 'verification',
                },
              ],
            }),
      });
      if (scenario === 'objective-review') {
        await f.runtime.control(f.sessionId, { action: 'edit', objective: 'Expanded approved objective' });
      }
      if (scenario === 'block-audit')
        await f.call({ action: 'block', blocker: 'External approval service unavailable' });
      f.state.busy = false;
      f.controller.scheduleGoalContinuation();
      await tick();
      assert.equal(f.pending.length, 1);
      assert.equal(f.controller.shouldRunGoalContinuation(f.pending[0]), true);
    });
  }
});

test('a terminal compact error clears queued Goal work and remains blocked after restart', async (t) => {
  const f = fixture(t);
  await f.call({
    action: 'create',
    objective: 'Keep unfinished work honest',
    tasks: [{ text: 'Unfinished deliverable', status: 'in_progress', kind: 'work' }],
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
  assert.equal(f.state.goal.tasks[0].status, 'in_progress');
  assert.deepEqual(f.pending, []);
  assert.equal(f.controller.shouldRunGoalContinuation(queued), false);

  await f.runtime.close();
  const restored = createGoalRuntime({ dataDir: f.dataDir });
  t.after(() => restored.close());
  assert.equal(restored.continuation(f.sessionId).reason, 'blocked');
  await restored.control(f.sessionId, { action: 'resume' });
  assert.equal(restored.continuation(f.sessionId).run, true);
});
