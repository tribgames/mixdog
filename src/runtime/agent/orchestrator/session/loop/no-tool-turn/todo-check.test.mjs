import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createNoToolTurnResolver } from '../no-tool-turn.mjs';
import { executeTodoTool, onTodoChange, todoSnapshot } from '../../../runtime-core/todo-list.mjs';
import { createGoalRuntime } from '../../../runtime-core/goal-runtime.mjs';
import { completeBackgroundTask, registerBackgroundTask } from '../../../../../shared/background-tasks.mjs';
import { beginTodoTurn, noteTodoUserWait } from './todo-check.mjs';
import { stampShellJobCycle } from '../../../../../shared/background-wait.mjs';

let seq = 0;
function fixture({ items = ['Find the cause', 'Fix the bug'], agent = 'lead' } = {}) {
  seq += 1;
  const session = { id: `sess_todo_check_${seq}`, agent };
  if (items.length) executeTodoTool(session, { op: 'init', items });
  beginTodoTurn(session, { genuine: true });
  const messages = [];
  const resolver = createNoToolTurnResolver({
    messages,
    opts: { session },
    sessionId: session.id,
    sessionAgent: agent,
    drainSteering: () => false,
  });
  const end = () => resolver.resolve({ content: 'Here is where things stand.' }, 1);
  const reminders = () => messages.filter((message) => message.role === 'user');
  return { session, messages, resolver, end, reminders };
}

test('an ended turn with open items gets one hidden reminder listing them and continues', async () => {
  const f = fixture();
  assert.equal((await f.end()).action, 'continue');
  const [reminder] = f.reminders();
  assert.match(reminder.content, /^<system-reminder>/);
  assert.match(reminder.content, /2 open todo item\(s\):\n- Find the cause\n- Fix the bug/);
  assert.match(reminder.content, /Reminder 1\/3/);
  assert.equal(f.messages[0].role, 'assistant', 'the ended text is kept before the reminder');
});

test('the report a todo reminder or queued input followed still reaches the caller after the next tool batch', async () => {
  const f = fixture();
  assert.equal((await f.resolver.resolve({ content: 'Status: done\n\nFull report.' }, 1)).action, 'continue');
  // The agent closes its items, then says only that the work was reported.
  executeTodoTool(f.session, { op: 'done', item: 'Find the cause' });
  executeTodoTool(f.session, { op: 'done', item: 'Fix the bug' });
  f.resolver.noteToolBatchCompleted([], []);
  const closed = await f.resolver.resolve({ content: 'Closed the items; nothing new.' }, 2);
  assert.equal(closed.action, 'break');
  assert.equal(closed.response.content, 'Closed the items; nothing new.', 'the live aggregate is unchanged');
  assert.equal(closed.response.reportContent, 'Status: done\n\nFull report.\n\nClosed the items; nothing new.');

  // Lead input queued as the agent finished: the answer it goes on past.
  let queued = 1;
  const session = { id: 'sess_todo_check_steered', agent: 'worker' };
  const messages = [];
  const resolver = createNoToolTurnResolver({
    messages,
    opts: { session },
    sessionId: session.id,
    sessionAgent: 'worker',
    drainSteering: (_stage, { beforeAppend }) => {
      if (queued === 0) return false;
      queued -= 1;
      beforeAppend();
      messages.push({ role: 'user', content: 'One more thing from the Lead.' });
      return true;
    },
  });
  assert.equal((await resolver.resolve({ content: 'Full report.' }, 1)).action, 'continue');
  resolver.noteToolBatchCompleted([], []);
  const answered = await resolver.resolve({ content: 'Done with the extra.' }, 2);
  assert.equal(answered.response.reportContent, 'Full report.\n\nDone with the extra.');
  // An answer cut at the output limit and resumed is carried whole.
  let pending = 1;
  const cutSession = { id: 'sess_todo_check_cut', agent: 'worker' };
  const cutMessages = [];
  const cut = createNoToolTurnResolver({
    messages: cutMessages,
    opts: { session: cutSession },
    sessionId: cutSession.id,
    sessionAgent: 'worker',
    drainSteering: (_stage, { beforeAppend }) => {
      if (pending === 0) return false;
      pending -= 1;
      beforeAppend();
      cutMessages.push({ role: 'user', content: 'One more thing from the Lead.' });
      return true;
    },
  });
  assert.equal((await cut.resolve({ content: 'Critical findings: ', stopReason: 'max_tokens' }, 1)).action, 'continue');
  assert.equal((await cut.resolve({ content: 'details and conclusion.' }, 2)).action, 'continue');
  cut.noteToolBatchCompleted([{ name: 'todo' }], []);
  const closedCut = await cut.resolve({ content: 'Closed todo.' }, 3);
  assert.equal(closedCut.response.reportContent, 'Critical findings: details and conclusion.\n\nClosed todo.');
  assert.equal(
    cutMessages.filter((message) => message.role === 'assistant').length,
    2,
    'history keeps the cut and its resumption once each'
  );

  // No tool batch between: the aggregate already holds the answer, once.
  const kept = fixture();
  assert.equal((await kept.resolver.resolve({ content: 'Full report.' }, 1)).action, 'continue');
  const unchanged = await kept.resolver.resolve({ content: 'Still open.' }, 2);
  assert.equal(unchanged.response.content, 'Full report.\n\nStill open.');
  assert.equal(unchanged.response.reportContent, undefined);
});

test('a reminder that produced no progress stops the check; progress re-arms it up to 3 per cycle', async () => {
  const f = fixture();
  assert.equal((await f.end()).action, 'continue');
  assert.equal((await f.end()).action, 'break', 'no tool batch since the last reminder');
  for (const expected of ['continue', 'continue', 'break']) {
    f.resolver.noteToolBatchCompleted([], []);
    assert.equal((await f.end()).action, expected);
  }
  assert.equal(f.reminders().length, 3);
  // An automatic continuation is not a new cycle; a genuine user prompt is.
  beginTodoTurn(f.session, { genuine: false });
  f.resolver.noteToolBatchCompleted([], []);
  assert.equal((await f.end()).action, 'break');
  beginTodoTurn(f.session, { genuine: true });
  assert.equal((await f.end()).action, 'continue');
});

test('no reminder without open items, for hidden roles, or while the turn waits on the user', async () => {
  assert.equal((await fixture({ items: [] }).end()).action, 'break');
  const closed = fixture({ items: ['Only step'] });
  executeTodoTool(closed.session, { op: 'done', item: 'Only step' });
  assert.equal((await closed.end()).action, 'break');
  const blocked = fixture({ items: ['Only step'] });
  executeTodoTool(blocked.session, { op: 'block', item: 'Only step', reason: 'waiting on the user' });
  assert.equal((await blocked.end()).action, 'break', 'blocked items are not open');
  const denied = fixture();
  noteTodoUserWait(denied.session.id);
  assert.equal((await denied.end()).action, 'break');
  // The next turn no longer carries the last turn's wait.
  beginTodoTurn(denied.session, { genuine: false });
  assert.equal((await denied.end()).action, 'continue');
});

test('a running agent or a background shell started this cycle skips the reminder; an earlier server does not', async () => {
  const f = fixture();
  const context = { callerSessionId: f.session.id };
  const agentJob = registerBackgroundTask({ surface: 'agent', context });
  assert.equal((await f.end()).action, 'break');
  completeBackgroundTask(agentJob.taskId, { status: 'completed', notify: false });
  // A server started in an earlier user cycle keeps running across prompts.
  const server = stampShellJobCycle(registerBackgroundTask({ surface: 'shell', context }));
  beginTodoTurn(f.session, { genuine: true });
  try {
    assert.equal((await f.end()).action, 'continue', 'an earlier-cycle server is no wait');
    f.resolver.noteToolBatchCompleted([], []);
    // A build started this cycle (background: true or moved there) is.
    const build = stampShellJobCycle(registerBackgroundTask({ surface: 'shell', context }));
    assert.equal((await f.end()).action, 'break');
    // An automatic continuation stays in the same cycle.
    beginTodoTurn(f.session, { genuine: false });
    assert.equal((await f.end()).action, 'break');
    completeBackgroundTask(build.taskId, { status: 'completed', notify: false });
    assert.equal((await f.end()).action, 'continue');
  } finally {
    completeBackgroundTask(server.taskId, { status: 'completed', notify: false });
  }
});

test('an active Goal with every item closed asks once for the completion audit', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-todo-goal-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  const goals = createGoalRuntime({ dataDir });
  t.after(async () => {
    await goals.close();
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(dataDir, { recursive: true, force: true });
  });
  const f = fixture({ items: ['Only step'] });
  executeTodoTool(f.session, { op: 'done', item: 'Only step' });
  assert.equal((await f.end()).action, 'break', 'no Goal: nothing to audit');
  await goals.control(f.session.id, { action: 'create', objective: 'Ship it' });
  assert.equal((await f.end()).action, 'continue');
  assert.match(f.reminders().at(-1).content, /call goal with action complete; otherwise append the remaining work/);
  f.resolver.noteToolBatchCompleted([], []);
  assert.equal((await f.end()).action, 'break', 'asked once per cycle');
});

test('a new prompt lets go of a finished list; automatic turns, blocked items and an active Goal keep it', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-todo-retire-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  const goals = createGoalRuntime({ dataDir });
  const published = new Map();
  const unsubscribe = onTodoChange(({ sessionId, todo }) => published.set(sessionId, todo));
  t.after(async () => {
    unsubscribe();
    await goals.close();
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(dataDir, { recursive: true, force: true });
  });

  const done = fixture({ items: ['Only step'] });
  executeTodoTool(done.session, { op: 'done', item: 'Only step' });
  beginTodoTurn(done.session, { genuine: false });
  assert.equal(todoSnapshot(done.session)?.completed, 1, 'the finished list stays through automatic turns');
  beginTodoTurn(done.session, { genuine: true });
  assert.equal(todoSnapshot(done.session), null);
  assert.equal(published.get(done.session.id), null, 'the cleared list is published at once');

  const blocked = fixture({ items: ['Only step'] });
  executeTodoTool(blocked.session, { op: 'block', item: 'Only step', reason: 'waiting on the user' });
  beginTodoTurn(blocked.session, { genuine: true });
  assert.equal(todoSnapshot(blocked.session)?.total, 1, 'a blocked item is unfinished');

  const audited = fixture({ items: ['Only step'] });
  executeTodoTool(audited.session, { op: 'done', item: 'Only step' });
  await goals.control(audited.session.id, { action: 'create', objective: 'Ship it' });
  beginTodoTurn(audited.session, { genuine: true });
  assert.equal(todoSnapshot(audited.session)?.completed, 1, 'an active Goal keeps its list for the audit');
});
