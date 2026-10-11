import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGoalRuntime } from '../runtime/agent/orchestrator/runtime-core/goal-runtime.mjs';

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-activity-'));
  let clock = 2_000_000_000_000;
  const runtime = createGoalRuntime({ dataDir, now: () => clock });
  const sessionId = 'sess_goal_activity';
  const call = async (args) => JSON.parse(await runtime.executeTool('goal', args, { callerSessionId: sessionId }));
  const snapshot = () => runtime.snapshot(sessionId);
  const create = (
    tasks = [
      { text: 'Approved work', status: 'awaiting_approval' },
      { text: 'Verify work', status: 'awaiting_approval' },
    ]
  ) => call({ action: 'create', objective: 'Finish approved work', tasks });
  t.after(() => {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    runtime,
    dataDir,
    sessionId,
    call,
    snapshot,
    create,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test('questions, approval bookkeeping, and carried in-progress rows do not resume a Goal', async (t) => {
  const f = fixture(t);
  await f.create([
    { text: 'Earlier work', status: 'in_progress' },
    { text: 'Verify work', status: 'pending' },
  ]);
  await f.runtime.control(f.sessionId, { action: 'pause' });
  await f.runtime.startTurn(f.sessionId);
  assert.equal((await f.call({ action: 'status' })).goal.status, 'paused');
  await f.call({
    action: 'set_tasks',
    tasks: [...f.snapshot().tasks, { text: 'Ask for approval', status: 'awaiting_approval' }],
  });
  await f.call({
    action: 'update_tasks',
    updates: [{ id: f.snapshot().tasks[0].id, text: 'Clarified earlier work' }],
    tasks: [{ text: 'Future work', status: 'pending' }],
  });
  assert.equal(f.snapshot().status, 'paused');
  await f.runtime.settleTurn(f.sessionId, { status: 'done' });
  assert.equal(f.snapshot().status, 'paused');
  assert.equal(f.runtime.continuation(f.sessionId).run, false);
  // Task bookkeeping cannot override a user-initiated pause.
  await f.call({
    action: 'update_tasks',
    updates: [{ id: f.snapshot().tasks[0].id, status: 'in_progress' }],
  });
  assert.equal(f.snapshot().status, 'paused');
});

test('work-start updates do not silently clear blocking, usage, or duration stops', async (t) => {
  for (const status of ['blocked', 'usage_limited', 'duration_reached']) {
    await t.test(status, async (t) => {
      const f = fixture(t);
      await f.create();
      if (status === 'blocked') {
        await f.runtime.startTurn(f.sessionId);
        await f.call({ action: 'block', blocker: 'External service unavailable' });
        await f.runtime.settleTurn(f.sessionId, { status: 'done' });
      } else if (status === 'usage_limited') {
        await f.runtime.settleTurn(f.sessionId, { usageLimited: true });
      } else {
        await f.runtime.control(f.sessionId, { action: 'time', duration: '1m' });
        f.advance(60_000);
        await f.runtime.settleTurn(f.sessionId, { status: 'done' });
      }
      const current = (await f.call({ action: 'status' })).goal;
      await f.call({
        action: 'update_tasks',
        revision: current.revision,
        updates: [{ id: current.tasks[0].id, status: 'in_progress' }],
      });
      assert.equal(f.snapshot().status, status);
      assert.equal(f.runtime.continuation(f.sessionId).run, false);
    });
  }
});
