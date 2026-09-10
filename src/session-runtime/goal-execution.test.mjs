import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGoalRuntime } from './goal-runtime.mjs';

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'goal-execution-'));
  let clock = 2_000_000_000_000;
  const options = { dataDir, now: () => clock };
  const runtime = createGoalRuntime(options);
  const sessionId = 'execution';
  const control = args => runtime.control(sessionId, args);
  const call = async args => JSON.parse(await runtime.executeTool('goal', args, { sessionId }));
  t.after(() => { runtime.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { runtime, dataDir, options, sessionId, control, call, advance: ms => { clock += ms; } };
}

test('maximum time allows early verified completion without a ceremonial task row', async t => {
  const f = fixture(t);
  const created = await f.control({ command: 'Deliver a single verified result --time 1h' });
  assert.equal(created.goal.timeMode, 'max');
  f.advance(1_000);
  const complete = await f.call({ action: 'complete' });
  assert.equal(complete.goal.status, 'complete');
  assert.ok(complete.remaining_ms > 0);
});

test('new sustained durations and unversioned stored durations retain their full commitment', async t => {
  const f = fixture(t);
  await f.control({ command: 'Improve approved work --time 1h --time-mode duration' });
  await assert.rejects(f.call({ action: 'complete' }), /before the requested duration/);
  f.runtime.close();
  const path = join(f.dataDir, 'goals', `${f.sessionId}.json`);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  delete record.goal.timeMode;
  writeFileSync(path, JSON.stringify(record));
  const restored = createGoalRuntime(f.options);
  t.after(() => restored.close());
  assert.equal(restored.snapshot(f.sessionId).timeMode, 'duration');
  await assert.rejects(restored.executeTool('goal', { action: 'complete' }, { sessionId: f.sessionId }), /before the requested duration/);
});

test('time exhaustion stops continuations and cannot silently become an unlimited resume', async t => {
  const f = fixture(t);
  await f.control({ command: 'Deliver work --time 1m' });
  await f.runtime.startTurn(f.sessionId);
  f.advance(60_000);
  await f.runtime.settleTurn(f.sessionId, { status: 'done' });
  assert.equal(f.runtime.continuation(f.sessionId).reason, 'duration_reached');
  await assert.rejects(f.control({ action: 'resume' }), /extend the time budget/);
  const edited = await f.control({ action: 'edit', objective: 'Deliver work', timeLimitMs: 120_000, timeMode: 'max' });
  assert.equal(edited.goal.timeUsedMs, 60_000);
  await f.control({ action: 'resume' });
  assert.equal(f.runtime.continuation(f.sessionId).run, true);
});

test('model waiting requires every remaining task to depend on the user and a reason', async t => {
  const f = fixture(t);
  const created = (await f.call({
    action: 'create', objective: 'Deliver approved work',
    tasks: [{ text: 'Implementation', status: 'pending', kind: 'work' }],
  })).goal;
  await assert.rejects(f.call({ action: 'pause', blocker: 'Choose an option' }), /continue available work/);
  await f.call({ action: 'update_tasks', updates: [{ id: created.tasks[0].id, status: 'awaiting_approval' }] });
  await assert.rejects(f.call({ action: 'pause' }), /blocker is required/);
  await f.call({ action: 'pause', blocker: 'Approve the scope' });
  assert.equal(f.runtime.snapshot(f.sessionId).pauseReason, 'waiting');
  f.advance(5_000);
  await f.call({ action: 'resume', updates: [{ id: created.tasks[0].id, status: 'in_progress' }] });
  assert.equal(f.runtime.snapshot(f.sessionId).timeUsedMs, 0);
});

test('blocking audit counts distinct consecutive turns, survives restart, and ignores duplicate reports', async t => {
  const f = fixture(t);
  await f.control({ command: 'Deliver work' });
  for (let turn = 1; turn <= 2; turn++) {
    await f.runtime.startTurn(f.sessionId);
    for (let repeat = 0; repeat < 2; repeat++) {
      const reply = await f.call({ action: 'block', blocker: 'External credentials unavailable' });
      assert.equal(reply.goal.status, 'active');
      assert.equal(reply.goal.blockAudit.count, turn);
    }
    await f.runtime.settleTurn(f.sessionId, { status: 'done' });
  }
  f.runtime.close();
  const restored = createGoalRuntime(f.options);
  t.after(() => restored.close());
  await restored.startTurn(f.sessionId);
  const blocked = JSON.parse(await restored.executeTool('goal', {
    action: 'block', blocker: 'External credentials unavailable',
  }, { sessionId: f.sessionId }));
  assert.equal(blocked.goal.status, 'blocked');
  assert.equal(restored.continuation(f.sessionId).run, false);
});

test('stop preserves unfinished work across restart and archives it before a replacement goal', async t => {
  const f = fixture(t);
  const created = (await f.call({
    action: 'create', objective: 'Original objective',
    tasks: [{ text: 'Unfinished deliverable', status: 'in_progress', kind: 'work' }],
  })).goal;
  const stopped = (await f.control({ action: 'stop', expectedGoalId: created.id })).goal;
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.tasks[0].status, 'in_progress');
  await assert.rejects(f.control({ action: 'resume' }), /stopped Goal/);
  f.runtime.close();
  const restored = createGoalRuntime(f.options);
  t.after(() => restored.close());
  assert.equal(restored.continuation(f.sessionId).reason, 'stopped');
  await restored.control(f.sessionId, { command: 'New objective' });
  const history = JSON.parse(readFileSync(join(f.dataDir, 'goals', 'history', f.sessionId, `${created.id}.json`), 'utf8'));
  assert.equal(history.goal.status, 'stopped');
  assert.deepEqual(history.goal.tasks, stopped.tasks);
});

test('goal editing preserves progress and rejects stale editor saves atomically', async t => {
  const f = fixture(t);
  const created = (await f.call({
    action: 'create', objective: 'Original scope',
    tasks: [{ text: 'Completed milestone', status: 'completed', kind: 'work' }],
  })).goal;
  const edit = (await f.control({
    action: 'edit', expectedGoalId: created.id, revision: created.revision,
    objective: 'Expanded scope', timeMode: 'duration', timeLimitMs: 60_000,
  })).goal;
  assert.deepEqual(edit.tasks, created.tasks);
  assert.equal(edit.needsTaskReview, true);
  await assert.rejects(f.control({ action: 'edit', objective: 'Stale scope', revision: created.revision }), /changed while editing/);
  assert.equal(f.runtime.snapshot(f.sessionId).objective, 'Expanded scope');
});
