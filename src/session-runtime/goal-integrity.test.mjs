import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeJsonAtomicAsync } from '../runtime/shared/atomic-file.mjs';
import { createGoalRuntime, readStoredGoalSnapshot } from './goal-runtime.mjs';
import { goalStateReminder } from './goal-text.mjs';

function fixture(t, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-integrity-'));
  const runtime = createGoalRuntime({ dataDir, ...options });
  const sessionId = 'sess_goal_integrity';
  const call = async (args) => JSON.parse(await runtime.executeTool('goal', args, { callerSessionId: sessionId }));
  const snapshot = () => runtime.snapshot(sessionId);
  const create = (extra = {}) => call({
    action: 'create', objective: 'Deliver the requested work',
    tasks: [
      { text: 'Implement work', status: 'pending', kind: 'work' },
      { text: 'Verify work', status: 'pending', kind: 'verification' },
    ],
    ...extra,
  });
  t.after(() => { runtime.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { runtime, dataDir, sessionId, call, snapshot, create };
}

test('failed persistence exposes no speculative task or lifecycle state and can be retried safely', async (t) => {
  let fail = false;
  const f = fixture(t, {
    writeGoalRecord: async (...args) => {
      if (fail) throw new Error('injected disk failure');
      return writeJsonAtomicAsync(...args);
    },
  });
  const created = (await f.create()).goal;
  const events = [];
  f.runtime.subscribe((event) => events.push(event));
  const update = {
    action: 'update_tasks', revision: created.revision,
    updates: created.tasks.map(({ id }) => ({ id, status: 'completed' })),
  };
  fail = true;
  await assert.rejects(f.call(update), /injected disk failure/);
  assert.equal(events.length, 0);
  assert.equal(f.snapshot().revision, created.revision);
  assert.deepEqual(f.snapshot().tasks, created.tasks);
  assert.deepEqual(readStoredGoalSnapshot({ dataDir: f.dataDir, sessionId: f.sessionId }).tasks, created.tasks);
  fail = false;
  const updated = (await f.call(update)).goal;
  assert.equal(updated.tasksCompleted, 2);
  const eventCount = events.length;
  fail = true;
  await assert.rejects(f.call({ action: 'complete', revision: updated.revision }), /injected disk failure/);
  assert.equal(events.length, eventCount);
  assert.equal(f.snapshot().status, 'active');
  fail = false;
  assert.equal((await f.call({ action: 'complete', revision: updated.revision })).goal.status, 'complete');
});

test('corrupt Goal records are reported and preserved until explicit user clearing', async (t) => {
  const warnings = [];
  const f = fixture(t, { onStorageError: (error) => warnings.push(error.message) });
  mkdirSync(join(f.dataDir, 'goals'));
  const path = join(f.dataDir, 'goals', `${f.sessionId}.json`);
  const corrupt = '{broken existing Goal';
  writeFileSync(path, corrupt);
  assert.equal(f.snapshot(), null);
  assert.match(warnings[0], /original file preserved/);
  await assert.rejects(f.call({ action: 'status' }), /cannot read Goal record/);
  await assert.rejects(f.create(), /cannot read Goal record/);
  assert.equal(readFileSync(path, 'utf8'), corrupt);
  await f.runtime.control(f.sessionId, { action: 'clear' });
  assert.equal((await f.create()).goal.status, 'active');
});

test('same-Goal objective edits invalidate stale updates and require explicit task reconciliation', async (t) => {
  const f = fixture(t);
  const created = (await f.create()).goal;
  await f.runtime.startTurn(f.sessionId);
  await f.runtime.control(f.sessionId, { action: 'edit', objective: 'Deliver work AND security review' });
  await assert.rejects(f.call({
    action: 'set_tasks', revision: created.revision,
    tasks: created.tasks.map((task) => ({ ...task, status: 'completed' })),
  }), /stale Goal revision/);
  // Frozen schemas without a revision still use the last model-visible state.
  await assert.rejects(f.call({ action: 'complete' }), /stale Goal revision/);
  const current = (await f.call({ action: 'status' })).goal;
  assert.equal(current.needsTaskReview, true);
  assert.match(goalStateReminder(current, { reason: 'objective-updated' }), /Revision: \d+/);
  await assert.rejects(f.call({ action: 'complete', revision: current.revision }), /objective changed/);
  await assert.rejects(f.call({
    action: 'update_tasks', revision: current.revision,
    updates: [{ id: created.tasks[0].id, status: 'completed' }],
  }), /reconcile the full task list/);
  const aligned = (await f.call({
    action: 'set_tasks', revision: current.revision,
    tasks: [...created.tasks, { text: 'Security review', status: 'pending', kind: 'verification' }],
  })).goal;
  assert.equal(f.snapshot().needsTaskReview, false);
  assert.ok(aligned.revision > current.revision);
  const finished = (await f.call({
    action: 'update_tasks', revision: aligned.revision,
    updates: f.snapshot().tasks.map(({ id }) => ({ id, status: 'completed' })),
  })).goal;
  assert.equal((await f.call({ action: 'complete', revision: finished.revision })).goal.status, 'complete');
});

test('concurrent partial updates detect stale revisions instead of silently overwriting completed work', async (t) => {
  const f = fixture(t);
  const created = (await f.create()).goal;
  const results = await Promise.allSettled(created.tasks.map(({ id }) => f.call({
    action: 'update_tasks', revision: created.revision, updates: [{ id, status: 'completed' }],
  })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /stale Goal revision/);
  const current = (await f.call({ action: 'status' })).goal;
  assert.equal(current.tasksCompleted, 1);
  const remaining = current.tasks.find((task) => task.status === 'pending');
  await f.call({ action: 'update_tasks', revision: current.revision, updates: [{ id: remaining.id, status: 'completed' }] });
  assert.equal(f.snapshot().tasksCompleted, 2);
});

test('concurrent old-schema full snapshots also reject the stale writer', async (t) => {
  const f = fixture(t);
  const created = (await f.create()).goal;
  const results = await Promise.allSettled(created.tasks.map((_, index) => f.call({
    action: 'set_tasks',
    tasks: created.tasks.map((task, i) => ({ ...task, status: i === index ? 'completed' : task.status })),
  })));
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(f.snapshot().tasksCompleted, 1);
});

test('new ids stay unique after completed rows are omitted and partial additions report their assigned ids', async (t) => {
  const f = fixture(t);
  const created = (await f.create()).goal;
  await f.call({ action: 'update_tasks', updates: [{ id: created.tasks[0].id, status: 'completed' }] });
  const replaced = await f.call({
    action: 'set_tasks',
    tasks: [created.tasks[1], { text: 'Follow-up work', status: 'pending', kind: 'work' }],
  });
  assert.equal(replaced.assigned_tasks[0].id, 'task_3');
  const added = await f.call({
    action: 'update_tasks', revision: replaced.goal.revision,
    tasks: [{ text: 'Another follow-up', status: 'pending', kind: 'work' }],
  });
  assert.equal(added.assigned_tasks[0].id, 'task_4');
  assert.deepEqual(f.snapshot().tasks.map((task) => task.id), ['task_2', 'task_3', 'task_4']);
  await assert.rejects(f.call({
    action: 'update_tasks', updates: [{ id: 'missing', status: 'completed' }],
  }), /unknown Goal task id/);
  assert.equal(f.snapshot().revision, added.goal.revision);
});

test('dropping work during the creation turn cannot immediately complete a Goal, including after restart', async (t) => {
  const f = fixture(t);
  await f.runtime.startTurn(f.sessionId);
  const created = (await f.create()).goal;
  assert.equal(created.turnCount, 1);
  await f.call({
    action: 'update_tasks',
    updates: created.tasks.map((task) => ({ id: task.id, status: task.kind === 'work' ? 'dropped' : 'completed' })),
  });
  await f.call({ action: 'set_tasks', tasks: f.snapshot().tasks.filter((task) => task.status !== 'dropped') });
  await assert.rejects(f.call({ action: 'complete' }), /dropped this turn/);
  f.runtime.close();
  const restored = createGoalRuntime({ dataDir: f.dataDir });
  t.after(() => restored.close());
  await assert.rejects(restored.executeTool('goal', { action: 'complete' }, { callerSessionId: f.sessionId }), /dropped this turn/);
  await restored.startTurn(f.sessionId);
  const completed = JSON.parse(await restored.executeTool('goal', { action: 'complete' }, { callerSessionId: f.sessionId }));
  assert.equal(completed.goal.status, 'complete');
});

test('completed Goals cannot be resurrected through pause or block', async (t) => {
  const f = fixture(t);
  await f.create();
  await f.runtime.control(f.sessionId, { action: 'complete' });
  await f.call({ action: 'status' });
  for (const action of ['pause', 'block', 'resume']) {
    await assert.rejects(f.call({ action, blocker: 'irrelevant' }), /completed Goal cannot/);
    assert.equal(f.snapshot().status, 'complete');
  }
});

test('requested duration blocks early model completion but preserves explicit user authority', async (t) => {
  let clock = 2_000_000_000_000;
  const f = fixture(t, { now: () => clock });
  const created = (await f.create({ time_limit_minutes: 60 })).goal;
  await f.call({
    action: 'update_tasks',
    updates: created.tasks.map(({ id }) => ({ id, status: 'completed' })),
  });
  await assert.rejects(f.call({ action: 'complete' }), /before the requested duration ends/);
  assert.equal(f.snapshot().status, 'active');
  assert.equal((await f.runtime.control(f.sessionId, { action: 'complete' })).goal.status, 'complete');
  const next = (await f.create({ time_limit_minutes: 60 })).goal;
  await f.call({ action: 'update_tasks', updates: next.tasks.map(({ id }) => ({ id, status: 'completed' })) });
  clock += 60 * 60 * 1000;
  assert.equal((await f.call({ action: 'complete' })).goal.status, 'complete');
});

test('ordinary updates return bounded acknowledgements while reads and recovery retain full state', async (t) => {
  const f = fixture(t);
  const tasks = Array.from({ length: 20 }, (_, index) => ({
    text: `Task ${index + 1}`.padEnd(100, '.'),
    status: 'pending', kind: index === 19 ? 'verification' : 'work',
  }));
  const created = (await f.create({ tasks })).goal;
  const args = { action: 'update_tasks', revision: created.revision, updates: [{ id: created.tasks[0].id, status: 'in_progress' }] };
  const reply = await f.call(args);
  assert.equal(reply.goal.tasks, undefined);
  assert.equal(reply.goal.objective, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(args)) + Buffer.byteLength(JSON.stringify(reply)) < 600);
  assert.equal((await f.call({ action: 'status' })).goal.tasks.length, 20);
  await f.call({ action: 'pause' });
  assert.equal((await f.call({ action: 'resume' })).goal.tasks.length, 20);
});

test('clock checkpoints and title generation do not invalidate a task revision', async (t) => {
  let clock = 2_000_000_000_000;
  let releaseTitle;
  const title = new Promise((resolve) => { releaseTitle = resolve; });
  const f = fixture(t, { now: () => clock, generateTitle: () => title });
  const created = (await f.create()).goal;
  const savedTitle = new Promise((resolve) => {
    const unsubscribe = f.runtime.subscribe(({ goal }) => {
      if (goal?.title === 'Compact title') { unsubscribe(); resolve(); }
    });
  });
  releaseTitle('Compact title');
  await savedTitle;
  await f.runtime.startTurn(f.sessionId);
  clock += 1_000;
  await f.runtime.settleTurn(f.sessionId, { status: 'done' });
  assert.equal(f.snapshot().revision, created.revision);
  await f.call({ action: 'update_tasks', revision: created.revision, updates: [{ id: created.tasks[0].id, status: 'in_progress' }] });
  assert.equal(f.snapshot().tasks[0].status, 'in_progress');
});

test('resume commits task patches and additions together with activation in one revision', async (t) => {
  const writes = [];
  const f = fixture(t, {
    writeGoalRecord: async (path, record, options) => {
      await writeJsonAtomicAsync(path, record, options);
      writes.push(structuredClone(record.goal));
    },
  });
  const created = (await f.create()).goal;
  const paused = (await f.call({ action: 'pause', revision: created.revision })).goal;
  const events = [];
  f.runtime.subscribe(({ goal }) => events.push(goal));
  writes.length = 0;
  const resumed = (await f.call({
    action: 'resume', revision: paused.revision,
    updates: [
      { id: '', text: '', status: 'pending', kind: 'work' },
      { id: created.tasks[0].id, status: 'in_progress' },
    ],
    tasks: [
      { id: '', text: '', status: 'pending', kind: 'work' },
      { text: 'Approved follow-up', status: 'pending', kind: 'work' },
    ],
  })).goal;
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.revision, paused.revision + 1);
  assert.equal(resumed.tasks[0].status, 'in_progress');
  assert.equal(resumed.tasks[1].status, 'pending');
  assert.equal(resumed.tasks[2].text, 'Approved follow-up');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, 'active');
  assert.deepEqual(writes[0].tasks, resumed.tasks);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].tasks, resumed.tasks);
  assert.equal(f.runtime.continuation(f.sessionId).run, true);
});

test('invalid or unsaved resume task changes leave the entire paused state intact', async (t) => {
  let fail = false;
  const f = fixture(t, {
    writeGoalRecord: async (...args) => {
      if (fail) throw new Error('injected resume write failure');
      return writeJsonAtomicAsync(...args);
    },
  });
  const created = (await f.create()).goal;
  await f.call({ action: 'pause' });
  const paused = f.snapshot();
  const events = [];
  f.runtime.subscribe((event) => events.push(event));
  const args = {
    action: 'resume', revision: paused.revision,
    updates: [{ id: created.tasks[0].id, status: 'in_progress' }],
  };
  await assert.rejects(f.call({
    ...args, tasks: [{ text: 'Invalid follow-up', status: 'invalid', kind: 'work' }],
  }), /invalid status/);
  await assert.rejects(f.call({
    ...args, updates: [{ id: created.tasks[0].id, text: '' }],
  }), /task text is required/);
  await assert.rejects(f.call({
    ...args, updates: [{ id: '', text: '', unknown: true }],
  }), /unknown Goal task id/);
  await assert.rejects(f.call({ ...args, tasks: {} }), /must be arrays/);
  fail = true;
  await assert.rejects(f.call(args), /injected resume write failure/);
  const unchanged = f.snapshot();
  for (const key of ['status', 'revision', 'tasks', 'tasksUpdatedAt', 'lastStartedAt', 'timeUsedMs']) {
    assert.deepEqual(unchanged[key], paused[key], key);
  }
  assert.equal(events.length, 0);
  fail = false;
  const resumed = (await f.call(args)).goal;
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.tasks[0].status, 'in_progress');
});

test('plain resume tolerates empty frozen-schema task fields without bypassing objective review', async (t) => {
  const f = fixture(t);
  await f.create();
  await f.call({ action: 'pause' });
  await f.runtime.control(f.sessionId, { action: 'edit', objective: 'Changed work requiring review' });
  const current = (await f.call({ action: 'status' })).goal;
  await assert.rejects(f.call({
    action: 'resume', revision: current.revision,
    updates: [{ id: current.tasks[0].id, status: 'in_progress' }],
  }), /reconcile the full task list/);
  assert.equal(f.snapshot().status, 'paused');
  const resumed = (await f.call({
    action: 'resume', revision: current.revision, tasks: [], updates: [],
  })).goal;
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.needsTaskReview, true);
  assert.deepEqual(resumed.tasks, current.tasks);
});
