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
    /only a finished or stalled Goal can be dismissed/
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

test('a Goal the model completed is dismissed the same way', async (t) => {
  const runtime = goalRuntime(t);
  await runtime.control(SESSION, { action: 'create', objective: 'Write the lexer' });
  await runtime.executeTool('goal', { action: 'complete' }, { callerSessionId: SESSION });
  const stopped = runtime.snapshot(SESSION);
  assert.equal(stopped.status, 'complete');
  await runtime.control(SESSION, { action: 'dismiss', expectedGoalId: stopped.id });
  assert.equal(runtime.snapshot(SESSION), null);
});

test('a stalled Goal is dismissed in one step and frees the session for a new Goal', async (t) => {
  for (const stall of ['pause', 'block']) {
    const runtime = goalRuntime(t);
    const session = `${SESSION}_${stall}`;
    const { goal } = await runtime.control(session, { action: 'create', objective: 'Port the parser' });
    if (stall === 'pause') await runtime.control(session, { action: 'pause' });
    else await runtime.executeTool('goal', { action: 'block', blocker: 'Needs a key' }, { callerSessionId: session });
    assert.notEqual(runtime.snapshot(session).status, 'active');

    const dismissed = await runtime.control(session, { action: 'dismiss', expectedGoalId: goal.id });
    assert.equal(dismissed.ok, true);
    assert.equal(runtime.snapshot(session), null, `a ${stall}d Goal lets go of its segment`);
    const stored = runtime.storedSnapshot(session);
    assert.equal(stored.id, goal.id);
    assert.equal(stored.status, 'stopped');
    assert.ok(stored.archivedAt > 0);
    const next = await runtime.control(session, { action: 'create', objective: 'Port the lexer' });
    assert.equal(next.ok, true);
  }
});

test('a new Goal over a stalled one asks first, then replaces it into history', async (t) => {
  const runtime = goalRuntime(t);
  const { goal } = await runtime.control(SESSION, { action: 'create', objective: 'Old work' });
  await runtime.control(SESSION, { action: 'pause' });

  const asked = await runtime.control(SESSION, { command: 'New work --time 30m' });
  assert.equal(asked.ok, false);
  assert.equal(asked.code, 'goal-replace-required');
  assert.equal(asked.goal.id, goal.id);
  assert.equal(runtime.snapshot(SESSION).id, goal.id, 'nothing changed before the user agreed');

  assert.match(asked.message, new RegExp(`/goal --replace=${goal.id}`));
  const replaced = await runtime.control(SESSION, { command: `--replace=${goal.id} New work --time 30m` });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.goal.objective, 'New work');
  assert.equal(replaced.goal.timeLimitMs, 30 * 60_000);
  assert.notEqual(runtime.snapshot(SESSION).id, goal.id);

  // The desktop agrees through the flag rather than the command text.
  await runtime.control(SESSION, { action: 'pause' });
  const viaFlag = await runtime.control(SESSION, {
    command: 'Newer work',
    replace: true,
    expectedGoalId: replaced.goal.id,
  });
  assert.equal(viaFlag.ok, true);
  assert.equal(viaFlag.goal.objective, 'Newer work');

  // A running Goal is never replaced this way; the model's tool never is.
  await assert.rejects(runtime.control(SESSION, { command: '--replace Another' }), /unfinished Goal exists/);
});

test('a replace confirmation is bound to the Goal the user saw', async (t) => {
  const runtime = goalRuntime(t);
  const { goal: a } = await runtime.control(SESSION, { action: 'create', objective: 'Goal A' });
  await runtime.control(SESSION, { action: 'pause' });
  // The dialog showed A; A is replaced by B, and B pauses before the user accepts.
  const { goal: b } = await runtime.control(SESSION, { command: 'Goal B', replace: true, expectedGoalId: a.id });
  await runtime.control(SESSION, { action: 'pause' });

  await assert.rejects(
    runtime.control(SESSION, { command: 'Goal C', replace: true, expectedGoalId: a.id }),
    /stale Goal replace/
  );
  assert.equal(runtime.snapshot(SESSION).id, b.id, 'the newer Goal was not retired');
  assert.equal(runtime.snapshot(SESSION).status, 'paused');
});

test('a typed /goal --replace must name the stalled Goal it was offered for', async (t) => {
  const runtime = goalRuntime(t);
  const { goal: a } = await runtime.control(SESSION, { action: 'create', objective: 'Goal A' });
  await runtime.control(SESSION, { action: 'pause' });
  const asked = await runtime.control(SESSION, { command: 'Goal C' });
  assert.match(asked.message, new RegExp(`--replace=${a.id}`));
  // A is replaced by B, which also stalls, before the user types the hint.
  const { goal: b } = await runtime.control(SESSION, { command: `--replace=${a.id} Goal B` });
  await runtime.control(SESSION, { action: 'pause' });

  await assert.rejects(runtime.control(SESSION, { command: `--replace=${a.id} Goal C` }), /stale Goal replace/);
  await assert.rejects(runtime.control(SESSION, { command: '--replace Goal C' }), /must name the stalled Goal/);
  assert.equal(runtime.snapshot(SESSION).id, b.id, 'the newer stalled Goal survives');
});
