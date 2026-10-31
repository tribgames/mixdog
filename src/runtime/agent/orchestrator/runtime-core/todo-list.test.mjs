import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adoptLegacyGoalTasks,
  executeTodoTool,
  notDoneReport,
  onTodoChange,
  todoProgress,
  todoSnapshot,
} from './todo-list.mjs';
import { TODO_TOOL } from './todo-tool-defs.mjs';

const statuses = (session) => todoSnapshot(session).phases.flatMap((phase) => phase.tasks.map((task) => task.status));

test('a flat init gets one default phase and starts the first item', () => {
  const session = { id: 'sess_todo_init' };
  const reply = executeTodoTool(session, { op: 'init', items: ['Find the cause', 'Fix the bug', 'Verify the fix'] });
  assert.match(reply, /^0\/3\nTasks\n {2}\[>\] Find the cause/);
  assert.deepEqual(statuses(session), ['in_progress', 'pending', 'pending']);
  const phased = { id: 'sess_todo_phases' };
  executeTodoTool(phased, {
    op: 'init',
    phases: [
      { name: 'Investigate', items: ['Read the logs'] },
      { name: 'Ship', items: ['Write the fix'] },
    ],
  });
  assert.deepEqual(
    todoSnapshot(phased).phases.map((phase) => phase.name),
    ['Investigate', 'Ship']
  );
});

test('duplicate wordings and unknown items are refused without changing the list', () => {
  const session = { id: 'sess_todo_refuse' };
  assert.throws(() => executeTodoTool(session, { op: 'init', items: ['Same', 'Same'] }), /duplicate item/);
  executeTodoTool(session, { op: 'init', items: ['Only item'] });
  const before = todoSnapshot(session);
  assert.throws(() => executeTodoTool(session, { op: 'done', item: 'Guessed wording' }), /no item "Guessed wording"/);
  assert.throws(() => executeTodoTool(session, { op: 'append', items: ['Only item'] }), /already exists/);
  assert.equal(todoSnapshot(session), before);
});

test('every op keeps exactly one item in progress, blocked never starts and completed never reopens', () => {
  const session = { id: 'sess_todo_normalize' };
  executeTodoTool(session, { op: 'init', items: ['One', 'Two', 'Three'] });
  assert.equal(executeTodoTool(session, { op: 'done', item: 'One', note: 'root cause in parser' }), '1/3 · done: One · next: Two');
  executeTodoTool(session, { op: 'block', item: 'Two', reason: 'waiting on the review agent' });
  assert.deepEqual(statuses(session), ['completed', 'blocked', 'in_progress']);
  executeTodoTool(session, { op: 'start', item: 'Three' });
  assert.throws(() => executeTodoTool(session, { op: 'start', item: 'Two' }), /unblock it first/);
  assert.throws(() => executeTodoTool(session, { op: 'start', item: 'One' }), /stays closed/);
  assert.throws(() => executeTodoTool(session, { op: 'drop', item: 'One' }), /stays closed/);
  executeTodoTool(session, { op: 'done', item: 'Three' });
  // Only the blocked item is left: nothing starts by itself.
  assert.deepEqual(statuses(session), ['completed', 'blocked', 'completed']);
  executeTodoTool(session, { op: 'unblock', item: 'Two' });
  assert.deepEqual(statuses(session), ['completed', 'in_progress', 'completed']);
  executeTodoTool(session, { op: 'append', items: ['Four'], phase: 'Later' });
  executeTodoTool(session, { op: 'start', item: 'Four' });
  assert.deepEqual(statuses(session), ['completed', 'pending', 'completed', 'in_progress']);
  const snapshot = todoSnapshot(session);
  assert.equal(snapshot.phases[0].tasks[0].note, 'root cause in parser');
  assert.deepEqual(
    { completed: snapshot.completed, abandoned: snapshot.abandoned, total: snapshot.total },
    { completed: 2, abandoned: 0, total: 4 }
  );
  executeTodoTool(session, { op: 'rm', item: 'Four' });
  assert.equal(todoSnapshot(session).phases.length, 1);
});

test('the snapshot is identity-stable while unchanged, null when empty, and changes notify', () => {
  const session = { id: 'sess_todo_snapshot' };
  assert.equal(todoSnapshot(session), null);
  const events = [];
  const off = onTodoChange((event) => events.push(event));
  executeTodoTool(session, { op: 'init', items: ['Only'] });
  const first = todoSnapshot(session);
  assert.equal(todoSnapshot(session), first);
  executeTodoTool(session, { op: 'view' });
  assert.equal(todoSnapshot(session), first, 'view changes nothing');
  executeTodoTool(session, { op: 'drop', item: 'Only' });
  off();
  assert.notEqual(todoSnapshot(session), first);
  assert.deepEqual(
    events.map((event) => event.sessionId),
    ['sess_todo_snapshot', 'sess_todo_snapshot']
  );
  executeTodoTool(session, { op: 'rm', item: 'Only' });
  assert.equal(todoSnapshot(session), null);
});

test('agent rows show progress without dropped items; unfinished work becomes the Not done list', () => {
  const session = { id: 'sess_todo_agent' };
  executeTodoTool(session, { op: 'init', items: ['Read code', 'Change code', 'Skip docs', 'Run tests'] });
  executeTodoTool(session, { op: 'done', item: 'Read code' });
  executeTodoTool(session, { op: 'drop', item: 'Skip docs' });
  executeTodoTool(session, { op: 'block', item: 'Run tests', reason: 'shell busy' });
  assert.deepEqual(todoProgress(session), { completed: 1, total: 3, current: 'Change code' });
  assert.equal(notDoneReport(session), 'Not done:\n- Change code\n- Run tests (blocked: shell busy)');
  assert.equal(notDoneReport({ id: 'empty' }), '');
});

test('legacy Goal tasks move into the todo list with mapped statuses', () => {
  const session = { id: 'sess_todo_legacy' };
  assert.equal(
    adoptLegacyGoalTasks(session, [
      { text: 'Done part', status: 'completed' },
      { text: 'Dropped part', status: 'dropped' },
      { text: 'Approval part', status: 'awaiting_approval' },
      { text: 'Open part', status: 'pending' },
    ]),
    true
  );
  const tasks = todoSnapshot(session).phases[0].tasks;
  assert.deepEqual(
    tasks.map((task) => [task.content, task.status, task.blocker]),
    [
      ['Done part', 'completed', undefined],
      ['Dropped part', 'abandoned', undefined],
      ['Approval part', 'blocked', 'awaiting user approval'],
      ['Open part', 'in_progress', undefined],
    ]
  );
  // Adopting the same tasks again adds nothing.
  assert.equal(adoptLegacyGoalTasks(session, [{ text: 'Done part', status: 'completed' }]), false);
});

test('the tool definition stays near its drafted size', () => {
  assert.equal(TODO_TOOL.annotations.agentHidden, false);
  const size = JSON.stringify(TODO_TOOL).length;
  assert.ok(size < 2_300, `todo tool definition is ${size} chars`);
});

test('an agent report carries its Not done list whether it succeeded, failed or was cancelled', async () => {
  const { completeBackgroundTask, registerBackgroundTask, renderBackgroundTaskNotification } = await import(
    '../../../shared/background-tasks.mjs'
  );
  const worker = { id: 'sess_todo_report_worker' };
  executeTodoTool(worker, { op: 'init', items: ['Measure the build', 'Write the summary'] });
  executeTodoTool(worker, { op: 'done', item: 'Measure the build' });
  for (const status of ['completed', 'failed', 'cancelled']) {
    const task = registerBackgroundTask({ surface: 'agent', meta: { tag: `w-${status}` } });
    task.reportAppendix = () => notDoneReport(worker);
    completeBackgroundTask(task.taskId, {
      status,
      ...(status === 'completed' ? { result: { content: 'Build takes 4m.' } } : { error: 'stopped' }),
      notify: false,
    });
    const text = renderBackgroundTaskNotification(task);
    assert.match(text, /Not done:\n- Write the summary/, status);
    if (status === 'completed') assert.match(text, /Build takes 4m\./);
  }
});

test('a todo change pulses session activity so the Agents pool re-reads', async () => {
  const { onSessionActivityChange } = await import('../../../shared/session-activity-signal.mjs');
  const pulses = [];
  const off = onSessionActivityChange((sessionId) => pulses.push(sessionId));
  try {
    const session = { id: 'sess_todo_pulse' };
    executeTodoTool(session, { op: 'init', items: ['One', 'Two'] });
    executeTodoTool(session, { op: 'done', item: 'One' });
    assert.deepEqual(pulses, ['sess_todo_pulse', 'sess_todo_pulse']);
  } finally {
    off();
  }
});

test('pool rows take the live session todo over the stored one', async () => {
  const { withLiveTodo } = await import('../session/agent-pool-progress.mjs');
  const worker = { id: 'sess_pool_live' };
  executeTodoTool(worker, { op: 'init', items: ['A', 'B', 'C'] });
  executeTodoTool(worker, { op: 'done', item: 'A' });
  executeTodoTool(worker, { op: 'drop', item: 'C' });
  const rows = [
    { sessionId: worker.id, todo: { completed: 0, total: 3 } },
    { sessionId: 'sess_cold', todo: { completed: 3, total: 3 } },
    { sessionId: 'sess_none' },
  ];
  const out = withLiveTodo(rows, (id) => (id === worker.id ? worker : undefined));
  assert.deepEqual(out[0].todo, { completed: 1, total: 2, current: 'B' });
  assert.equal(out[1], rows[1]);
  assert.equal(out[2], rows[2]);
});

test('a live session whose list was cleared drops the stored pool todo', async () => {
  const { withLiveTodo } = await import('../session/agent-pool-progress.mjs');
  const { clearTodo } = await import('./todo-list.mjs');
  const worker = { id: 'sess_pool_cleared' };
  executeTodoTool(worker, { op: 'init', items: ['One', 'Two'] });
  clearTodo(worker);
  const stored = { sessionId: worker.id, status: 'running', todo: { completed: 0, total: 2, current: 'One' } };
  const [row] = withLiveTodo([stored], () => worker);
  assert.equal('todo' in row, false);
  assert.equal(row.status, 'running');
  assert.deepEqual(withLiveTodo([stored], () => undefined)[0], stored);
});

test('agent status rows carry the live agent session todo progress', async () => {
  const { liveAgentStatusRow } = await import(
    '../../../../session-runtime/services/agent-tool/job-views/session-progress.mjs'
  );
  const { _liveSessions } = await import('../session/store/live-state.mjs');
  const worker = { id: 'sess_todo_row_worker' };
  executeTodoTool(worker, { op: 'init', items: ['Step one', 'Step two'] });
  _liveSessions.set(worker.id, worker);
  try {
    const row = liveAgentStatusRow({ sessionId: worker.id, status: 'running', silent_for: 3 });
    assert.deepEqual(row.todo, { completed: 0, total: 2, current: 'Step one' });
    assert.equal(row.silent_for, undefined);
    assert.equal(liveAgentStatusRow({ sessionId: 'sess_unknown', status: 'idle' }).todo, undefined);
  } finally {
    _liveSessions.delete(worker.id);
  }
});
