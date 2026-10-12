import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGoalRuntime } from './goal-runtime.mjs';

const SESSION = 'sess_goal_quota';

async function limitedGoal(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-quota-'));
  const runtime = createGoalRuntime({ dataDir, deadlineWarningMs: [], generateTitle: null });
  t.after(async () => {
    await runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const { goal } = await runtime.control(SESSION, { action: 'create', objective: 'Ship the parser' });
  await runtime.startTurn(SESSION);
  const limited = await runtime.settleTurn(SESSION, { status: 'failed', usageLimited: true, error: 'quota' });
  assert.equal(limited.status, 'usage_limited');
  return { runtime, goal };
}

test('a quota resume reactivates the same usage-limited Goal', async (t) => {
  const { runtime, goal } = await limitedGoal(t);
  assert.equal(await runtime.reactivateUsageLimited(SESSION, 'some-other-goal'), null);
  assert.equal(runtime.snapshot(SESSION).status, 'usage_limited');
  const revived = await runtime.reactivateUsageLimited(SESSION, goal.id);
  assert.equal(revived.status, 'active');
  assert.equal(revived.id, goal.id);
  // Already active: nothing to revive.
  assert.equal(await runtime.reactivateUsageLimited(SESSION, goal.id), null);
});

test('a paused, stopped or replaced Goal is never revived', async (t) => {
  const paused = await limitedGoal(t);
  await paused.runtime.control(SESSION, { action: 'pause' });
  assert.equal(await paused.runtime.reactivateUsageLimited(SESSION, paused.goal.id), null);
  assert.equal(paused.runtime.snapshot(SESSION).status, 'paused');

  const stopped = await limitedGoal(t);
  await stopped.runtime.control(SESSION, { action: 'stop' });
  assert.equal(await stopped.runtime.reactivateUsageLimited(SESSION, stopped.goal.id), null);

  const replaced = await limitedGoal(t);
  await replaced.runtime.control(SESSION, { action: 'complete' });
  await replaced.runtime.archiveCompletedOnUserInput(SESSION);
  const { goal: successor } = await replaced.runtime.control(SESSION, { action: 'create', objective: 'Next' });
  assert.equal(await replaced.runtime.reactivateUsageLimited(SESSION, replaced.goal.id), null);
  assert.equal(replaced.runtime.snapshot(SESSION).id, successor.id);
  assert.equal(replaced.runtime.snapshot(SESSION).status, 'active');
});
