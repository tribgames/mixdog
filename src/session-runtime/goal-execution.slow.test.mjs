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
  const control = (args) => runtime.control(sessionId, args);
  const call = async (args) => JSON.parse(await runtime.executeTool('goal', args, { sessionId }));
  t.after(async () => {
    await runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    runtime,
    dataDir,
    options,
    sessionId,
    control,
    call,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test('maximum time allows early verified completion without a ceremonial task row', async (t) => {
  const f = fixture(t);
  const created = await f.control({ command: 'Deliver a single verified result --time 1h --time-mode max' });
  assert.equal(created.goal.timeMode, 'max');
  f.advance(1_000);
  const complete = await f.call({ action: 'complete' });
  assert.equal(complete.goal.status, 'complete');
  assert.ok(complete.remaining_ms > 0);
});

test('a stated budget without a mode commits the full period; no budget stays max', async (t) => {
  const f = fixture(t);
  const timed = await f.call({ action: 'create', objective: 'Polish in rounds', time_limit_minutes: 300 });
  assert.equal(timed.goal.timeMode, 'duration');
  await assert.rejects(f.call({ action: 'complete' }), /requested duration/);
  await f.call({ action: 'abandon' });
  const untimed = await f.call({ action: 'create', objective: 'Deliver one fix' });
  assert.equal(untimed.goal.timeMode, 'max');
});

test('continuation tiers send the rules once, then pointers, and the task list only when it goes stale', async (t) => {
  const f = fixture(t);
  await f.control({ command: 'Deliver a single verified result --time 1h' });
  const first = f.runtime.continuation(f.sessionId);
  assert.equal(first.run, true);
  assert.match(first.prompt, /Before completing, audit each user condition/);
  assert.match(first.prompt, /Durable tasks:/);

  // Rules and list are both in the transcript now, so the quiet turns between
  // them only point at the work, with the revision and the remaining budget.
  const { revision } = f.runtime.snapshot(f.sessionId);
  for (let quiet = 1; quiet < 10; quiet += 1) {
    const minimal = f.runtime.continuation(f.sessionId);
    assert.equal(minimal.run, true);
    assert.match(minimal.prompt, new RegExp(`^Revision: ${revision}$`, 'm'));
    assert.match(minimal.prompt, /Time remaining:/);
    assert.match(minimal.prompt, /still apply unchanged/);
    assert.doesNotMatch(minimal.prompt, /Durable tasks:|Deliver a single verified result/);
    assert.ok(
      minimal.prompt.length * 4 < first.prompt.length,
      `minimal prompt ${minimal.prompt.length} is not a quarter of ${first.prompt.length}`
    );
  }

  // The tenth quiet continuation re-shows the durable state without the rules,
  // and the count starts over from that delivery.
  const stale = f.runtime.continuation(f.sessionId);
  assert.match(stale.prompt, /Durable tasks:/);
  assert.match(stale.prompt, /Deliver a single verified result/);
  assert.doesNotMatch(stale.prompt, /Before completing, audit each user condition/);
  for (let quiet = 1; quiet < 10; quiet += 1) {
    assert.doesNotMatch(f.runtime.continuation(f.sessionId).prompt, /Durable tasks:/);
  }
  assert.match(f.runtime.continuation(f.sessionId).prompt, /Durable tasks:/);

  // Compaction, an objective change, or a paused-state reminder resets the
  // marker: the lost rules are delivered again in full.
  f.runtime.resetContinuationRules(f.sessionId);
  assert.match(f.runtime.continuation(f.sessionId).prompt, /Before completing, audit each user condition/);
});

test('a task mutation replaces the next continuation state block with a pointer', async (t) => {
  const f = fixture(t);
  await f.control({ command: 'Keep the approved work moving --time 1h' });
  await f.runtime.startTurn(f.sessionId);
  assert.match(f.runtime.continuation(f.sessionId).prompt, /Before completing, audit each user condition/);
  // One short of the stale-list reminder.
  for (let quiet = 1; quiet < 10; quiet += 1) f.runtime.continuation(f.sessionId);

  await f.call({ action: 'set_tasks', tasks: [{ text: 'Implement the approved result', status: 'in_progress' }] });
  // The fresh list is already in the model's own tool result, so the next
  // continuation points at it instead of replaying it.
  const next = f.runtime.continuation(f.sessionId);
  assert.doesNotMatch(next.prompt, /Durable tasks:|Implement the approved result/);
  assert.match(next.prompt, new RegExp(`^Revision: ${f.runtime.snapshot(f.sessionId).revision}$`, 'm'));
  for (let quiet = 1; quiet < 10; quiet += 1) {
    assert.doesNotMatch(f.runtime.continuation(f.sessionId).prompt, /Durable tasks:/);
  }
  assert.match(f.runtime.continuation(f.sessionId).prompt, /Durable tasks:/);
});

test('new sustained durations and unversioned stored durations retain their full commitment', async (t) => {
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
  await assert.rejects(
    restored.executeTool('goal', { action: 'complete' }, { sessionId: f.sessionId }),
    /before the requested duration/
  );
});

test('time exhaustion stops continuations and cannot silently become an unlimited resume', async (t) => {
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

test('model waiting requires every remaining task to depend on the user and a reason', async (t) => {
  const f = fixture(t);
  const created = (
    await f.call({
      action: 'create',
      objective: 'Deliver approved work',
      tasks: [{ text: 'Implementation', status: 'pending' }],
    })
  ).goal;
  await assert.rejects(f.call({ action: 'pause', blocker: 'Choose an option' }), /continue available work/);
  await f.call({ action: 'update_tasks', updates: [{ id: created.tasks[0].id, status: 'awaiting_approval' }] });
  await assert.rejects(f.call({ action: 'pause' }), /blocker is required/);
  await f.call({ action: 'pause', blocker: 'Approve the scope' });
  assert.equal(f.runtime.snapshot(f.sessionId).pauseReason, 'waiting');
  f.advance(5_000);
  await f.call({ action: 'resume', updates: [{ id: created.tasks[0].id, status: 'in_progress' }] });
  assert.equal(f.runtime.snapshot(f.sessionId).timeUsedMs, 0);
});

test('blocking audit counts distinct consecutive turns, survives restart, and ignores duplicate reports', async (t) => {
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
  const blocked = JSON.parse(
    await restored.executeTool(
      'goal',
      {
        action: 'block',
        blocker: 'External credentials unavailable',
      },
      { sessionId: f.sessionId }
    )
  );
  assert.equal(blocked.goal.status, 'blocked');
  assert.equal(restored.continuation(f.sessionId).run, false);
});

test('stop preserves unfinished work across restart and archives it before a replacement goal', async (t) => {
  const f = fixture(t);
  const created = (
    await f.call({
      action: 'create',
      objective: 'Original objective',
      tasks: [{ text: 'Unfinished deliverable', status: 'in_progress' }],
    })
  ).goal;
  const stopped = (await f.control({ action: 'stop', expectedGoalId: created.id })).goal;
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.tasks[0].status, 'in_progress');
  // A user-confirmed stop retires the chrome at once; the record still exists.
  assert.equal(f.runtime.snapshot(f.sessionId), null);
  assert.equal(f.runtime.storedSnapshot(f.sessionId).status, 'stopped');
  await assert.rejects(f.control({ action: 'resume' }), /stopped Goal/);
  f.runtime.close();
  const restored = createGoalRuntime(f.options);
  t.after(() => restored.close());
  assert.equal(restored.snapshot(f.sessionId), null);
  assert.equal(restored.continuation(f.sessionId).reason, 'missing');
  await restored.control(f.sessionId, { command: 'New objective' });
  const history = JSON.parse(
    readFileSync(join(f.dataDir, 'goals', 'history', f.sessionId, `${created.id}.json`), 'utf8')
  );
  assert.equal(history.goal.status, 'stopped');
  assert.deepEqual(history.goal.tasks, stopped.tasks);
});

test('goal editing preserves progress and rejects stale editor saves atomically', async (t) => {
  const f = fixture(t);
  const created = (
    await f.call({
      action: 'create',
      objective: 'Original scope',
      tasks: [{ text: 'Completed milestone', status: 'completed' }],
    })
  ).goal;
  const edit = (
    await f.control({
      action: 'edit',
      expectedGoalId: created.id,
      revision: created.revision,
      objective: 'Expanded scope',
      timeMode: 'duration',
      timeLimitMs: 60_000,
    })
  ).goal;
  assert.deepEqual(edit.tasks, created.tasks);
  assert.equal(edit.needsTaskReview, true);
  await assert.rejects(
    f.control({ action: 'edit', objective: 'Stale scope', revision: created.revision }),
    /changed while editing/
  );
  assert.equal(f.runtime.snapshot(f.sessionId).objective, 'Expanded scope');
});

for (const priorStatus of ['paused', 'duration_reached', 'active']) {
  test(`an approved additional round updates a ${priorStatus} Goal's time and checklist atomically`, async (t) => {
    const f = fixture(t);
    const hour = 3_600_000;
    const created = (
      await f.call({
        action: 'create',
        objective: 'Expand revenue research without production changes',
        time_limit_minutes: 180,
        time_mode: 'duration',
        tasks: Array.from({ length: 11 }, (_, i) => ({
          text: `Verified milestone ${i + 1}`,
          status: 'completed',
        })),
      })
    ).goal;
    f.advance(priorStatus === 'active' ? hour : 3 * hour);
    if (priorStatus === 'paused') await f.runtime.settleTurn(f.sessionId, { status: 'cancelled' });
    if (priorStatus === 'duration_reached') await f.runtime.settleTurn(f.sessionId, { status: 'done' });
    const before = (await f.call({ action: 'status' })).goal;
    assert.equal(before.status, priorStatus);
    const events = [];
    f.runtime.subscribe((event) => events.push(event));
    const resumed = (
      await f.call({
        action: 'resume',
        revision: before.revision,
        time_limit_minutes: 300,
        tasks: [{ text: 'Find new matched revenue samples and another period', status: 'in_progress' }],
      })
    ).goal;
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
    assert.equal(
      JSON.parse(readFileSync(join(f.dataDir, 'goals', `${f.sessionId}.json`), 'utf8')).goal.timeLimitMs,
      resumed.timeLimitMs
    );
  });
}

test('resume changes a time mode only when supplied and preserves a plain continuation budget', async (t) => {
  const f = fixture(t);
  await f.call({
    action: 'create',
    objective: 'Continue approved work',
    time_limit_minutes: 180,
    time_mode: 'duration',
  });
  f.advance(60_000);
  const paused = (await f.control({ action: 'pause' })).goal;
  const resumed = (
    await f.call({
      action: 'resume',
      revision: paused.revision,
      time_limit_minutes: 300,
      time_mode: 'max',
    })
  ).goal;
  assert.equal(resumed.timeMode, 'max');
  assert.equal(resumed.remainingMs, 300 * 60_000);
  f.advance(60_000);
  const pausedAgain = (await f.control({ action: 'pause' })).goal;
  const continued = (await f.call({ action: 'resume', revision: pausedAgain.revision })).goal;
  assert.equal(continued.timeMode, 'max');
  assert.equal(continued.timeLimitMs, resumed.timeLimitMs);
  assert.equal(continued.remainingMs, 299 * 60_000);
});

test('invalid or stale additional-round mutations cannot partially extend time or append tasks', async (t) => {
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
    await assert.rejects(
      f.call({
        action: 'resume',
        revision: before.revision,
        tasks: [{ text: 'New round', status: 'in_progress' }],
        ...changes,
      }),
      error
    );
    assert.deepEqual(f.runtime.snapshot(f.sessionId), before);
  }
});

test('a new round after completion archives the prior evidence and starts its own budget', async (t) => {
  const f = fixture(t);
  const created = (
    await f.call({
      action: 'create',
      objective: 'Prior research',
      time_limit_minutes: 180,
      time_mode: 'max',
      tasks: [{ text: 'Verified result with retained evidence', status: 'completed' }],
    })
  ).goal;
  f.advance(60_000);
  await f.call({ action: 'complete' });
  const completed = f.runtime.snapshot(f.sessionId);
  const next = (
    await f.call({
      action: 'create',
      objective: 'Additional research',
      time_limit_minutes: 300,
      tasks: [{ text: 'New research scope', status: 'in_progress' }],
    })
  ).goal;
  assert.notEqual(next.id, created.id);
  assert.equal(next.timeLimitMs, 300 * 60_000);
  assert.equal(next.timeUsedMs, 0);
  assert.equal(next.remainingMs, 300 * 60_000);
  assert.equal(next.tasksCompleted, 0);
  assert.equal(next.tasksTotal, 1);
  const archived = JSON.parse(
    readFileSync(join(f.dataDir, 'goals', 'history', f.sessionId, `${created.id}.json`), 'utf8')
  ).goal;
  assert.equal(archived.status, 'complete');
  assert.equal(archived.timeUsedMs, completed.timeUsedMs);
  assert.deepEqual(archived.tasks, completed.tasks);
});
