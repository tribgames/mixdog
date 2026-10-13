import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGoalRuntime } from './goal-runtime.mjs';

const SESSION = 'sess_goal_dismiss';

function goalRuntime(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-dismiss-'));
  const runtime = createGoalRuntime({ dataDir, deadlineWarningMs: [], generateTitle: null });
  t.after(async () => {
    await runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return runtime;
}

test('dismissing a finished Goal retires its chrome and keeps the record', async (t) => {
  const runtime = goalRuntime(t);
  const { goal } = await runtime.control(SESSION, { action: 'create', objective: 'Ship the parser' });
  await assert.rejects(
    runtime.control(SESSION, { action: 'dismiss', expectedGoalId: goal.id }),
    /only a finished Goal can be dismissed/
  );
  assert.equal(runtime.snapshot(SESSION).status, 'active', 'running work is stopped, never dismissed');

  await runtime.control(SESSION, { action: 'complete' });
  await assert.rejects(
    runtime.control(SESSION, { action: 'dismiss', expectedGoalId: 'goal-from-a-stale-view' }),
    /stale Goal/
  );
  assert.equal(runtime.snapshot(SESSION).status, 'complete');

  const dismissed = await runtime.control(SESSION, { action: 'dismiss', expectedGoalId: goal.id });
  assert.equal(dismissed.ok, true);
  assert.equal(dismissed.goal, null);
  assert.equal(runtime.snapshot(SESSION), null, 'the segment lets go');
  const stored = runtime.storedSnapshot(SESSION);
  assert.equal(stored.id, goal.id);
  assert.equal(stored.status, 'complete');
  assert.ok(stored.archivedAt > 0, 'the record stays, archived');
  // A second press (a double click, another device) changes nothing.
  assert.equal((await runtime.control(SESSION, { action: 'dismiss', expectedGoalId: goal.id })).ok, true);
  assert.equal(runtime.storedSnapshot(SESSION).archivedAt, stored.archivedAt);
});

test('a Goal the model stopped is dismissed the same way', async (t) => {
  const runtime = goalRuntime(t);
  await runtime.control(SESSION, { action: 'create', objective: 'Write the lexer' });
  await runtime.executeTool('goal', { action: 'abandon' }, { callerSessionId: SESSION });
  const stopped = runtime.snapshot(SESSION);
  assert.equal(stopped.status, 'stopped');
  await runtime.control(SESSION, { action: 'dismiss', expectedGoalId: stopped.id });
  assert.equal(runtime.snapshot(SESSION), null);
});
