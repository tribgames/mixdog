import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGoalRuntime } from './goal-runtime.mjs';
import { writeJsonAtomicAsync } from '../../../shared/atomic-file.mjs';

const SESSION = 'sess_goal_quota';

async function limitedGoal(t, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-quota-'));
  const runtime = createGoalRuntime({ dataDir, deadlineWarningMs: [], generateTitle: null, ...options });
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

test('cancelled reactivation rolls back a completed write before publishing the active Goal', async (t) => {
  let intercept = false;
  let current = true;
  const written = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { runtime, goal } = await limitedGoal(t, {
    writeGoalRecord: async (path, record, options) => {
      await writeJsonAtomicAsync(path, record, options);
      if (intercept && record.goal?.status === 'active') {
        written.resolve();
        await release.promise;
      }
    },
  });
  intercept = true;
  const resume = runtime.reactivateUsageLimited(SESSION, goal.id, { isCurrent: () => current });
  await written.promise;
  current = false;
  release.resolve();
  assert.equal(await resume, null);
  assert.equal(runtime.snapshot(SESSION).status, 'usage_limited');
});

test('an activation write that fails after landing is rolled back without admitting a turn', async (t) => {
  let fail = false;
  let admitted = false;
  const { runtime, goal } = await limitedGoal(t, {
    writeGoalRecord: async (path, record, options) => {
      await writeJsonAtomicAsync(path, record, options);
      if (fail && record.goal?.status === 'active') throw new Error('post-write failure');
    },
  });
  fail = true;
  await assert.rejects(
    runtime.reactivateUsageLimited(SESSION, goal.id, {
      isCurrent: () => true,
      accept: () => {
        admitted = true;
        return true;
      },
    }),
    /post-write failure/
  );
  assert.equal(admitted, false);
  assert.equal(runtime.snapshot(SESSION).status, 'usage_limited');
});

test('refused admission leaves the Goal suspended and a later retry can succeed', async (t) => {
  const { runtime, goal } = await limitedGoal(t);
  assert.equal(await runtime.reactivateUsageLimited(SESSION, goal.id, { accept: () => false }), null);
  assert.equal(runtime.snapshot(SESSION).status, 'usage_limited');
  assert.equal((await runtime.reactivateUsageLimited(SESSION, goal.id)).status, 'active');
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
