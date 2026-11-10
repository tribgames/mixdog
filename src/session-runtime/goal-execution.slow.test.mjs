import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGoalRuntime } from '../runtime/agent/orchestrator/runtime-core/goal-runtime.mjs';

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

test('a time cap allows early verified completion; --time sets it and --time-mode is not an option', async (t) => {
  const f = fixture(t);
  const created = await f.control({ command: 'Deliver a single verified result --time 1h' });
  assert.equal(created.goal.timeLimitMs, 3_600_000);
  assert.equal(created.goal.objective, 'Deliver a single verified result');
  f.advance(1_000);
  const complete = await f.call({ action: 'complete' });
  assert.equal(complete.goal.status, 'complete');
  assert.ok(complete.remaining_ms > 0);
});

test('continuation sends the rules once per Goal, names the goal tool and carries the todo list', async (t) => {
  const f = fixture(t);
  await f.control({ command: 'Deliver a single verified result --time 1h' });
  const todo = '<todo_state>\nTodo list\n1/2\nTasks\n  [x] Find cause\n  [>] Fix it\n</todo_state>';
  const first = f.runtime.continuation(f.sessionId, { todo });
  assert.equal(first.run, true);
  assert.match(first.prompt, /goal tool/);
  assert.match(first.prompt, /audit each user condition/);
  assert.match(first.prompt, /reached cap is not completion/);
  assert.match(first.prompt, /never redefine success around a smaller/);
  assert.match(first.prompt, /\[>\] Fix it/);
  const next = f.runtime.continuation(f.sessionId, { todo });
  assert.match(next.prompt, /\[>\] Fix it/);
  assert.match(next.prompt, /Time remaining:/);
  assert.doesNotMatch(next.prompt, /Decide choices within the objective/);
  assert.match(f.runtime.continuation(f.sessionId).prompt, /Todo list: empty/);
  f.runtime.resetContinuationRules(f.sessionId);
  assert.match(f.runtime.continuation(f.sessionId).prompt, /Decide choices within the objective/);
});

test('time exhaustion stops continuations and cannot silently become an unlimited resume', async (t) => {
  const f = fixture(t);
  await f.control({ command: 'Deliver work --time 1m' });
  await f.runtime.startTurn(f.sessionId);
  f.advance(60_000);
  await f.runtime.settleTurn(f.sessionId, { status: 'done' });
  assert.equal(f.runtime.continuation(f.sessionId).reason, 'duration_reached');
  await assert.rejects(f.control({ action: 'resume' }), /extend the time budget/);
  const edited = await f.control({ action: 'edit', objective: 'Deliver work', time_limit_minutes: 2 });
  assert.equal(edited.goal.timeUsedMs, 60_000);
  await f.control({ action: 'resume' });
  assert.equal(f.runtime.continuation(f.sessionId).run, true);
});

test('an automatic turn without a tool call waits for the user before continuing again', async (t) => {
  const f = fixture(t);
  await f.control({ command: 'Deliver work' });
  await f.runtime.startTurn(f.sessionId);
  await f.runtime.settleTurn(f.sessionId, { status: 'done', automatic: true, toolCalls: 0 });
  assert.equal(f.runtime.continuation(f.sessionId).reason, 'no-progress-wait');
  await f.runtime.startTurn(f.sessionId);
  await f.runtime.settleTurn(f.sessionId, { status: 'done' });
  assert.equal(f.runtime.continuation(f.sessionId).run, true);
});

test('block stops the Goal on the reporting turn and survives restart', async (t) => {
  const f = fixture(t);
  await f.control({ command: 'Deliver work' });
  await f.runtime.startTurn(f.sessionId);
  const reply = await f.call({ action: 'block', blocker: 'External credentials unavailable' });
  assert.equal(reply.goal.status, 'blocked');
  assert.equal(reply.goal.blocker, 'External credentials unavailable');
  await f.runtime.settleTurn(f.sessionId, { status: 'done' });
  assert.equal(f.runtime.continuation(f.sessionId).run, false);
  f.runtime.close();
  const restored = createGoalRuntime(f.options);
  t.after(() => restored.close());
  assert.equal(restored.snapshot(f.sessionId).status, 'blocked');
  assert.equal(restored.continuation(f.sessionId).run, false);
});

test('a model create while an unfinished Goal exists is refused until the user stops it', async (t) => {
  const f = fixture(t);
  await f.control({ command: 'First objective' });
  await f.control({ action: 'pause' });
  await assert.rejects(f.call({ action: 'create', objective: 'Second' }), /ask the user to stop it/);
});

test('stop preserves the record across restart and archives it before a replacement goal', async (t) => {
  const f = fixture(t);
  const created = (await f.call({ action: 'create', objective: 'Original objective' })).goal;
  const stopped = (await f.control({ action: 'stop', expectedGoalId: created.id })).goal;
  assert.equal(stopped.status, 'stopped');
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
});

test('a new round after completion archives the prior Goal and starts its own budget', async (t) => {
  const f = fixture(t);
  const created = (await f.call({ action: 'create', objective: 'Prior research', time_limit_minutes: 180 })).goal;
  f.advance(60_000);
  await f.call({ action: 'complete' });
  const completed = f.runtime.snapshot(f.sessionId);
  const next = (await f.call({ action: 'create', objective: 'Additional research', time_limit_minutes: 300 })).goal;
  assert.notEqual(next.id, created.id);
  assert.equal(next.timeUsedMs, 0);
  assert.equal(next.remainingMs, 300 * 60_000);
  const archived = JSON.parse(
    readFileSync(join(f.dataDir, 'goals', 'history', f.sessionId, `${created.id}.json`), 'utf8')
  ).goal;
  assert.equal(archived.status, 'complete');
  assert.equal(archived.timeUsedMs, completed.timeUsedMs);
});
