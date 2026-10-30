import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeJsonAtomicAsync } from '../runtime/shared/atomic-file.mjs';
import { createGoalRuntime, readStoredGoalSnapshot } from '../runtime/agent/orchestrator/runtime-core/goal-runtime.mjs';

function fixture(t, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-integrity-'));
  const runtime = createGoalRuntime({ dataDir, ...options });
  const sessionId = 'sess_goal_integrity';
  const call = async (args) => JSON.parse(await runtime.executeTool('goal', args, { callerSessionId: sessionId }));
  const snapshot = () => runtime.snapshot(sessionId);
  const create = (extra = {}) => call({ action: 'create', objective: 'Deliver the requested work', ...extra });
  t.after(() => {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { runtime, dataDir, sessionId, call, snapshot, create };
}

test('failed persistence exposes no speculative lifecycle state and can be retried safely', async (t) => {
  let fail = false;
  const f = fixture(t, {
    writeGoalRecord: async (...args) => {
      if (fail) throw new Error('injected disk failure');
      return writeJsonAtomicAsync(...args);
    },
  });
  await f.create();
  const events = [];
  f.runtime.subscribe((event) => events.push(event));
  fail = true;
  await assert.rejects(f.call({ action: 'complete' }), /injected disk failure/);
  assert.equal(events.length, 0);
  assert.equal(f.snapshot().status, 'active');
  assert.equal(readStoredGoalSnapshot({ dataDir: f.dataDir, sessionId: f.sessionId }).status, 'active');
  fail = false;
  assert.equal((await f.call({ action: 'complete' })).goal.status, 'complete');
});

for (const [label, corrupt] of [
  ['torn', '{broken existing Goal'],
  ['NUL-filled', '\0'.repeat(48)],
]) {
  test(`a ${label} Goal record is kept aside and never blocks the Goal feature`, async (t) => {
    const f = fixture(t);
    mkdirSync(join(f.dataDir, 'goals'));
    const goals = join(f.dataDir, 'goals');
    const path = join(goals, `${f.sessionId}.json`);
    writeFileSync(path, corrupt);
    assert.equal(f.snapshot(), null);
    assert.equal((await f.call({ action: 'status' })).goal ?? null, null);
    assert.equal((await f.create()).goal.status, 'active');
    const aside = readdirSync(goals).filter((name) => name.includes('.corrupt-'));
    assert.equal(aside.length, 1);
    assert.equal(readFileSync(join(goals, aside[0]), 'utf8'), corrupt);
  });
}

test('the model surface is status, create, complete and block only', async (t) => {
  const f = fixture(t);
  await f.create();
  for (const action of ['pause', 'resume', 'set_tasks', 'update_tasks', 'abandon']) {
    await assert.rejects(f.call({ action }), /goal action must be one of: status, create, complete, block/);
  }
  // Fields a frozen schema still fills carry nothing and are not refused.
  const status = await f.call({ action: 'status', revision: 3, tasks: [], time_mode: 'max' });
  assert.equal(status.goal.status, 'active');
  for (const field of ['tasks', 'tasksCompleted', 'tasksTotal', 'revision', 'timeMode']) {
    assert.equal(Object.hasOwn(status.goal, field), false, field);
  }
  await assert.rejects(f.call({ action: 'status', bogus: true }), /unknown fields: bogus/);
});

test('completed Goals cannot be resurrected through block or a new settlement', async (t) => {
  const f = fixture(t);
  await f.create();
  await f.runtime.control(f.sessionId, { action: 'complete' });
  await assert.rejects(f.call({ action: 'block', blocker: 'irrelevant' }), /completed Goal cannot/);
  assert.equal(f.snapshot().status, 'complete');
  assert.equal((await f.call({ action: 'complete' })).goal.status, 'complete');
});

test('a time cap is an upper bound: verified work completes before it runs out', async (t) => {
  let clock = 2_000_000_000_000;
  const f = fixture(t, { now: () => clock });
  const created = (await f.create({ time_limit_minutes: 60 })).goal;
  assert.equal(created.timeLimitMs, 60 * 60_000);
  clock += 5 * 60_000;
  assert.equal((await f.call({ action: 'complete' })).goal.status, 'complete');
});

test('a legacy duration record reads as a cap and keeps its tasks for the todo list', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.dataDir, 'goals'));
  const at = Date.now();
  writeFileSync(
    join(f.dataDir, 'goals', `${f.sessionId}.json`),
    JSON.stringify({
      version: 1,
      goal: {
        id: 'goal_legacy',
        revision: 7,
        objective: 'Legacy work',
        status: 'active',
        timeMode: 'duration',
        timeLimitMs: 60 * 60_000,
        timeUsedMs: 0,
        lastStartedAt: at,
        createdAt: at,
        updatedAt: at,
        tasks: [
          { id: 'task_1', text: 'Shipped part', status: 'completed' },
          { id: 'task_2', text: 'Needs approval', status: 'awaiting_approval' },
        ],
      },
    })
  );
  const goal = f.snapshot();
  assert.equal(Object.hasOwn(goal, 'timeMode'), false);
  assert.deepEqual(
    f.runtime.legacyTasks(f.sessionId).map((task) => task.text),
    ['Shipped part', 'Needs approval']
  );
  await f.runtime.clearLegacyTasks(f.sessionId);
  assert.deepEqual(f.runtime.legacyTasks(f.sessionId), []);
  // Early completion is allowed: the legacy full-period commitment is gone.
  assert.equal((await f.call({ action: 'complete' })).goal.status, 'complete');
});

test('ordinary settlements return bounded acknowledgements while status keeps the full Goal', async (t) => {
  const f = fixture(t);
  await f.create();
  const reply = await f.call({ action: 'block', blocker: 'The user must sign in to the vendor console' });
  assert.equal(reply.goal.status, 'blocked');
  assert.equal(reply.goal.objective, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(reply)) < 300);
  assert.equal((await f.call({ action: 'status' })).goal.objective, 'Deliver the requested work');
});

test('user pause and resume stay user controls and resume continues the Goal', async (t) => {
  const f = fixture(t);
  await f.create();
  assert.equal((await f.runtime.control(f.sessionId, { action: 'pause' })).goal.status, 'paused');
  assert.equal(f.runtime.continuation(f.sessionId).run, false);
  assert.equal((await f.runtime.control(f.sessionId, { action: 'resume' })).goal.status, 'active');
  assert.equal(f.runtime.continuation(f.sessionId).run, true);
});

test('edit takes objective and time_limit_minutes', async (t) => {
  const f = fixture(t);
  await f.create();
  const edited = (
    await f.runtime.control(f.sessionId, { action: 'edit', objective: 'Changed work', time_limit_minutes: 30 })
  ).goal;
  assert.equal(edited.objective, 'Changed work');
  assert.equal(edited.timeLimitMs, 30 * 60_000);
  const uncapped = (
    await f.runtime.control(f.sessionId, { action: 'edit', objective: 'Changed work', time_limit_minutes: 0 })
  ).goal;
  assert.equal(uncapped.timeLimitMs, 0);
});
