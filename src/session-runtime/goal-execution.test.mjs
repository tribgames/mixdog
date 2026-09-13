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
  t.after(async () => { await runtime.close(); rmSync(dataDir, { recursive: true, force: true }); });
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

for (const priorStatus of ['paused', 'duration_reached', 'active']) {
  test(`an approved additional round updates a ${priorStatus} Goal's time and checklist atomically`, async t => {
    const f = fixture(t);
    const hour = 3_600_000;
    const created = (await f.call({
      action: 'create', objective: 'Expand revenue research without production changes',
      time_limit_minutes: 180, time_mode: 'duration',
      tasks: Array.from({ length: 11 }, (_, i) => ({
        text: `Verified milestone ${i + 1}`, status: 'completed', kind: 'work',
      })),
    })).goal;
    f.advance(priorStatus === 'active' ? hour : 3 * hour);
    if (priorStatus === 'paused') await f.runtime.settleTurn(f.sessionId, { status: 'cancelled' });
    if (priorStatus === 'duration_reached') await f.runtime.settleTurn(f.sessionId, { status: 'done' });
    const before = (await f.call({ action: 'status' })).goal;
    assert.equal(before.status, priorStatus);
    const events = [];
    f.runtime.subscribe(event => events.push(event));
    const resumed = (await f.call({
      action: 'resume', revision: before.revision, time_limit_minutes: 300,
      tasks: [{ text: 'Find new matched revenue samples and another period', status: 'in_progress', kind: 'work' }],
    })).goal;
    assert.equal(events.length, 1);
    assert.equal(resumed.id, created.id);
    assert.equal(resumed.status, 'active');
    assert.equal(resumed.timeUsedMs, before.timeUsedMs);
    assert.equal(resumed.remainingMs, 5 * hour);
    assert.equal(resumed.timeLimitMs, before.timeUsedMs + 5 * hour);
    assert.equal(resumed.timeMode, 'duration');
    assert.equal(resumed.tasksCompleted, 11);
    assert.equal(resumed.tasksTotal, 12);
    assert.deepEqual(resumed.tasks.slice(0, 11), created.tasks);
    assert.equal(f.runtime.continuation(f.sessionId).run, true);
    assert.equal(JSON.parse(readFileSync(join(f.dataDir, 'goals', `${f.sessionId}.json`), 'utf8')).goal.timeLimitMs, resumed.timeLimitMs);
  });
}

test('resume changes a time mode only when supplied and preserves a plain continuation budget', async t => {
  const f = fixture(t);
  await f.call({ action: 'create', objective: 'Continue approved work', time_limit_minutes: 180, time_mode: 'duration' });
  f.advance(60_000);
  const paused = (await f.control({ action: 'pause' })).goal;
  const resumed = (await f.call({
    action: 'resume', revision: paused.revision, time_limit_minutes: 300, time_mode: 'max',
  })).goal;
  assert.equal(resumed.timeMode, 'max');
  assert.equal(resumed.remainingMs, 300 * 60_000);
  f.advance(60_000);
  const pausedAgain = (await f.control({ action: 'pause' })).goal;
  const continued = (await f.call({ action: 'resume', revision: pausedAgain.revision })).goal;
  assert.equal(continued.timeMode, 'max');
  assert.equal(continued.timeLimitMs, resumed.timeLimitMs);
  assert.equal(continued.remainingMs, 299 * 60_000);
});

test('invalid or stale additional-round mutations cannot partially extend time or append tasks', async t => {
  const f = fixture(t);
  await f.call({ action: 'create', objective: 'Keep approved work', time_limit_minutes: 180 });
  f.advance(60_000);
  await f.control({ action: 'pause' });
  const before = (await f.call({ action: 'status' })).goal;
  for (const [changes, error] of [
    [{ time_limit_minutes: 0 }, /positive/],
    [{ time_limit_minutes: 300, time_mode: 'invalid' }, /timeMode/],
    [{ time_limit_minutes: 7 * 24 * 60 }, /exceeds 7 days/],
    [{ time_limit_minutes: 300, revision: before.revision - 1 }, /stale Goal revision/],
    [{ time_limit_minutes: 300, updates: [{ id: 'missing-task', status: 'completed' }] }, /unknown.*task/i],
  ]) {
    await assert.rejects(f.call({
      action: 'resume', revision: before.revision,
      tasks: [{ text: 'New round', status: 'in_progress', kind: 'work' }],
      ...changes,
    }), error);
    assert.deepEqual(f.runtime.snapshot(f.sessionId), before);
  }
});

test('a new round after completion archives the prior evidence and starts its own budget', async t => {
  const f = fixture(t);
  const created = (await f.call({
    action: 'create', objective: 'Prior research', time_limit_minutes: 180,
    tasks: [{ text: 'Verified result with retained evidence', status: 'completed', kind: 'work' }],
  })).goal;
  f.advance(60_000);
  await f.call({ action: 'complete' });
  const completed = f.runtime.snapshot(f.sessionId);
  const next = (await f.call({
    action: 'create', objective: 'Additional research', time_limit_minutes: 300,
    tasks: [{ text: 'New research scope', status: 'in_progress', kind: 'work' }],
  })).goal;
  assert.notEqual(next.id, created.id);
  assert.equal(next.timeLimitMs, 300 * 60_000);
  assert.equal(next.timeUsedMs, 0);
  assert.equal(next.remainingMs, 300 * 60_000);
  assert.equal(next.tasksCompleted, 0);
  assert.equal(next.tasksTotal, 1);
  const archived = JSON.parse(readFileSync(join(f.dataDir, 'goals', 'history', f.sessionId, `${created.id}.json`), 'utf8')).goal;
  assert.equal(archived.status, 'complete');
  assert.equal(archived.timeUsedMs, completed.timeUsedMs);
  assert.deepEqual(archived.tasks, completed.tasks);
});
