import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeJsonAtomicAsync } from '../runtime/shared/atomic-file.mjs';
import { createGoalRuntime, readStoredGoalSnapshot } from './goal-runtime.mjs';

function fixture(t, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-activity-'));
  let clock = 2_000_000_000_000;
  const runtime = createGoalRuntime({ dataDir, now: () => clock, ...options });
  const sessionId = 'sess_goal_activity';
  const call = async (args) => JSON.parse(await runtime.executeTool('goal', args, { callerSessionId: sessionId }));
  const snapshot = () => runtime.snapshot(sessionId);
  const create = (tasks = [
    { text: 'Approved work', status: 'pending', kind: 'work' },
    { text: 'Verify work', status: 'awaiting_approval', kind: 'verification' },
  ]) => call({ action: 'create', objective: 'Finish approved work', tasks });
  t.after(() => { runtime.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { runtime, dataDir, sessionId, call, snapshot, create, advance: (ms) => { clock += ms; } };
}

test('starting a paused task publishes task progress, activation, and clock together', async (t) => {
  const writes = [];
  const f = fixture(t, {
    writeGoalRecord: async (...args) => {
      await writeJsonAtomicAsync(...args);
      writes.push(structuredClone(args[1].goal));
    },
  });
  await f.create();
  f.advance(1_000);
  await f.call({ action: 'pause' });
  const paused = f.snapshot();
  f.advance(30_000);
  await f.runtime.startTurn(f.sessionId);
  const events = [];
  f.runtime.subscribe(({ goal }) => events.push(goal));
  writes.length = 0;
  const reply = await f.call({
    action: 'update_tasks', revision: paused.revision,
    updates: [{ id: paused.tasks[0].id, status: 'in_progress' }],
  });
  const resumed = f.snapshot();
  assert.equal(reply.goal.status, 'active');
  assert.equal(resumed.revision, paused.revision + 1);
  assert.equal(resumed.tasks[0].status, 'in_progress');
  assert.equal(resumed.tasks[1].status, 'awaiting_approval');
  assert.equal(resumed.timeUsedMs, paused.timeUsedMs, 'waiting time is not counted as work');
  assert.equal(writes.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'active');
  assert.deepEqual(writes[0].tasks, resumed.tasks);
  assert.equal(f.runtime.continuation(f.sessionId).run, true);
  f.advance(2_000);
  assert.equal(f.snapshot().timeUsedMs, paused.timeUsedMs + 2_000);
});

test('questions, approval bookkeeping, and carried in-progress rows do not resume a Goal', async (t) => {
  const f = fixture(t);
  await f.create([
    { text: 'Earlier work', status: 'in_progress', kind: 'work' },
    { text: 'Verify work', status: 'pending', kind: 'verification' },
  ]);
  await f.call({ action: 'pause' });
  await f.runtime.startTurn(f.sessionId);
  assert.equal((await f.call({ action: 'status' })).goal.status, 'paused');
  await f.call({
    action: 'set_tasks',
    tasks: [...f.snapshot().tasks, { text: 'Ask for approval', status: 'awaiting_approval', kind: 'work' }],
  });
  await f.call({
    action: 'update_tasks',
    updates: [{ id: f.snapshot().tasks[0].id, text: 'Clarified earlier work' }],
    tasks: [{ text: 'Future work', status: 'pending', kind: 'work' }],
  });
  assert.equal(f.snapshot().status, 'paused');
  await f.runtime.settleTurn(f.sessionId, { status: 'done' });
  assert.equal(f.snapshot().status, 'paused');
  assert.equal(f.runtime.continuation(f.sessionId).run, false);
  // An addressed work-start patch is an explicit restart, even if pause left
  // the row marked in_progress from the preceding turn.
  await f.call({
    action: 'update_tasks',
    updates: [{ id: f.snapshot().tasks[0].id, status: 'in_progress' }],
  });
  assert.equal(f.snapshot().status, 'active');
});

test('full task transitions and newly started tasks also resume paused work', async (t) => {
  for (const action of ['set_tasks', 'update_tasks', 'set_goal_tasks']) {
    await t.test(action, async (t) => {
      const f = fixture(t);
      await f.create();
      await f.call({ action: 'pause' });
      const tasks = action === 'update_tasks'
        ? [{ text: 'Approved addition', status: 'in_progress', kind: 'work' }]
        : f.snapshot().tasks.map((task, index) => index ? task : { ...task, status: 'in_progress' });
      const reply = action === 'set_goal_tasks'
        ? JSON.parse(await f.runtime.executeTool(action, { tasks }, { callerSessionId: f.sessionId }))
        : await f.call({ action, tasks });
      assert.equal(reply.goal.status, 'active');
      assert.equal(f.snapshot().tasks.find((task) => task.kind === 'verification').status, 'awaiting_approval');
    });
  }
});

test('work-start task writes cannot bypass revision, validation, or persistence failures', async (t) => {
  let fail = false;
  const f = fixture(t, {
    writeGoalRecord: async (...args) => {
      if (fail) throw new Error('injected work-start failure');
      return writeJsonAtomicAsync(...args);
    },
  });
  await f.create();
  await f.call({ action: 'pause' });
  const paused = f.snapshot();
  const args = {
    action: 'update_tasks', revision: paused.revision,
    updates: [{ id: paused.tasks[0].id, status: 'in_progress' }],
  };
  const events = [];
  f.runtime.subscribe((event) => events.push(event));
  await assert.rejects(f.call({ ...args, revision: paused.revision - 1 }), /stale Goal revision/);
  await assert.rejects(f.call({ ...args, tasks: [{ text: '', status: 'pending', kind: 'work' }] }), /task text is required/);
  fail = true;
  await assert.rejects(f.call(args), /injected work-start failure/);
  const stored = readStoredGoalSnapshot({ dataDir: f.dataDir, sessionId: f.sessionId });
  for (const key of ['status', 'revision', 'tasks', 'timeUsedMs', 'lastStartedAt']) {
    assert.deepEqual(f.snapshot()[key], paused[key], key);
    assert.deepEqual(stored[key], paused[key], `stored ${key}`);
  }
  assert.equal(events.length, 0);
  fail = false;
  assert.equal((await f.call(args)).goal.status, 'active');
});

test('cancel after task-driven resume freezes the clock and preserves paused state on reload', async (t) => {
  const f = fixture(t);
  await f.create();
  await f.call({ action: 'pause' });
  await f.runtime.startTurn(f.sessionId);
  await f.call({
    action: 'update_tasks',
    updates: [{ id: f.snapshot().tasks[0].id, status: 'in_progress' }],
  });
  f.advance(4_000);
  const cancelled = await f.runtime.settleTurn(f.sessionId, { status: 'cancelled' });
  assert.equal(cancelled.status, 'paused');
  f.advance(10_000);
  assert.equal(f.snapshot().timeUsedMs, cancelled.timeUsedMs);
  const restored = createGoalRuntime({ dataDir: f.dataDir });
  t.after(() => restored.close());
  assert.equal(restored.snapshot(f.sessionId).status, 'paused');
  assert.equal(restored.continuation(f.sessionId).run, false);
});

test('work-start updates do not silently clear blocking, usage, or duration stops', async (t) => {
  for (const status of ['blocked', 'usage_limited', 'duration_reached']) {
    await t.test(status, async (t) => {
      const f = fixture(t);
      await f.create();
      if (status === 'blocked') {
        await f.runtime.executeTool('update_goal', { status, blocker: 'External service unavailable' }, { callerSessionId: f.sessionId });
      } else if (status === 'usage_limited') {
        await f.runtime.settleTurn(f.sessionId, { usageLimited: true });
      } else {
        await f.runtime.control(f.sessionId, { action: 'time', duration: '1m' });
        f.advance(60_000);
        await f.runtime.settleTurn(f.sessionId, { status: 'done' });
      }
      const current = (await f.call({ action: 'status' })).goal;
      await f.call({
        action: 'update_tasks', revision: current.revision,
        updates: [{ id: current.tasks[0].id, status: 'in_progress' }],
      });
      assert.equal(f.snapshot().status, status);
      assert.equal(f.runtime.continuation(f.sessionId).run, false);
    });
  }
});
