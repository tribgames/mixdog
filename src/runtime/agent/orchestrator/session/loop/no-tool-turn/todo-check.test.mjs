import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createNoToolTurnResolver } from '../no-tool-turn.mjs';
import { executeTodoTool, onTodoChange, todoSnapshot } from '../../../runtime-core/todo-list.mjs';
import { createGoalRuntime } from '../../../runtime-core/goal-runtime.mjs';
import { completeBackgroundTask, registerBackgroundTask } from '../../../../../shared/background-tasks.mjs';
import { beginTodoTurn, noteTodoUserWait, todoStartReminder } from './todo-check.mjs';
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

test('no reminder without unfinished items, for hidden roles, or while the turn waits on the user', async () => {
  assert.equal((await fixture({ items: [] }).end()).action, 'break');
  const closed = fixture({ items: ['Only step'] });
  executeTodoTool(closed.session, { op: 'done', item: 'Only step' });
  assert.equal((await closed.end()).action, 'break');
  const waiting = fixture({ items: ['Only step'] });
  noteTodoUserWait(waiting.session.id);
  assert.equal((await waiting.end()).action, 'break', 'a turn waiting on the user is not asked about its open items');
  const denied = fixture();
  noteTodoUserWait(denied.session.id);
  assert.equal((await denied.end()).action, 'break');
  // The next turn no longer carries the last turn's wait.
  beginTodoTurn(denied.session, { genuine: false });
  assert.equal((await denied.end()).action, 'continue');
});

test('the reminder offers continue, done or drop; an item waiting on the user stays open without looping', async () => {
  const f = fixture({ items: ['Measure', 'Ask the user'] });
  executeTodoTool(f.session, { op: 'done', item: 'Measure' });
  assert.equal((await f.end()).action, 'continue');
  const [reminder] = f.reminders();
  assert.match(reminder.content, /- Ask the user/);
  assert.match(reminder.content, /\(done or drop\)/);
  assert.doesNotMatch(reminder.content, /block/i);
  // The agent only asks the user: no tool batch since, so the turn ends.
  assert.equal((await f.end()).action, 'break');
  assert.equal(f.reminders().length, 1);
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

  const open = fixture({ items: ['Only step'] });
  beginTodoTurn(open.session, { genuine: true });
  assert.equal(todoSnapshot(open.session)?.total, 1, 'an open item is unfinished');

  const audited = fixture({ items: ['Only step'] });
  executeTodoTool(audited.session, { op: 'done', item: 'Only step' });
  await goals.control(audited.session.id, { action: 'create', objective: 'Ship it' });
  beginTodoTurn(audited.session, { genuine: true });
  assert.equal(todoSnapshot(audited.session)?.completed, 1, 'an active Goal keeps its list for the audit');
});

let callSeq = 0;
const edit = () => ({ id: `c${++callSeq}`, name: 'edit', arguments: {} });
const staleBatch = (f, calls = [edit()], results = []) => {
  f.resolver.noteToolBatchCompleted(calls, results);
  return f.messages.filter((m) => m.role === 'user' && /todo/i.test(m.content));
};

test('ten mutating calls with no todo call append one hidden reminder, then ten more are needed', () => {
  const f = fixture();
  for (let i = 0; i < 9; i += 1) assert.equal(staleBatch(f).length, 0);
  const [nudge] = staleBatch(f);
  assert.match(nudge.content, /^<system-reminder>/);
  assert.match(nudge.content, /- \[in_progress\] Find the cause\n- \[pending\] Fix the bug/);
  assert.equal(nudge.meta, 'hook');
  for (let i = 0; i < 9; i += 1) assert.equal(staleBatch(f).length, 1, 'no repeat before ten more');
  assert.equal(staleBatch(f).length, 2);
  assert.equal(f.session.todoCheck.reminders, 0, 'the end-of-turn budget is untouched');
});

test('read-only calls never age the list; a failed mutation and a read-only git do not count', () => {
  const f = fixture();
  const readOnly = ['read', 'grep', 'glob', 'find', 'list', 'code_graph', 'explore', 'web_search'];
  for (let i = 0; i < 40; i += 1) {
    assert.equal(staleBatch(f, [{ id: `r${i}`, name: readOnly[i % readOnly.length], arguments: {} }]).length, 0);
  }
  for (let i = 0; i < 20; i += 1) {
    assert.equal(staleBatch(f, [{ id: `g${i}`, name: 'git', arguments: { command: 'git status' } }]).length, 0);
  }
  for (let i = 0; i < 20; i += 1) {
    const call = edit();
    const failed = [{ role: 'tool', toolCallId: call.id, toolKind: 'error', content: 'Error: no match' }];
    assert.equal(staleBatch(f, [call], failed).length, 0);
  }
  for (let i = 0; i < 20; i += 1) {
    const call = { id: `s${i}`, name: 'shell', arguments: { command: 'npm test' } };
    const skipped = [
      { role: 'tool', toolCallId: call.id, toolKind: 'skipped', content: 'Skipped: an earlier edit failed' },
    ];
    assert.equal(staleBatch(f, [call], skipped).length, 0, 'a skipped call never ran');
  }
});

test('parallel mutating calls each count; shell and git mutations count', () => {
  const f = fixture();
  assert.equal(staleBatch(f, [edit(), edit(), edit(), edit()]).length, 0);
  assert.equal(
    staleBatch(f, [{ id: 's', name: 'shell', arguments: { command: 'npm test' } }, edit(), edit()]).length,
    0
  );
  assert.equal(
    staleBatch(f, [{ id: 'g', name: 'git', arguments: { command: 'git add -A' } }, edit(), edit()]).length,
    1,
    'a batch crossing ten fires once, after it'
  );
});

test('a todo call resets the count (calls read in order); a closed list or a hidden agent is never nudged', () => {
  const f = fixture();
  for (let i = 0; i < 9; i += 1) staleBatch(f);
  assert.equal(staleBatch(f, [{ id: 't', name: 'todo', arguments: {} }]).length, 0);
  for (let i = 0; i < 9; i += 1) assert.equal(staleBatch(f).length, 0, 'counting restarted at the todo call');
  assert.equal(staleBatch(f).length, 1);
  const g = fixture();
  assert.equal(
    staleBatch(g, Array.from({ length: 12 }, edit).concat([{ id: 't2', name: 'todo', arguments: {} }])).length,
    0
  );

  const closed = fixture({ items: ['Only step'] });
  executeTodoTool(closed.session, { op: 'done', item: 'Only step' });
  for (let i = 0; i < 12; i += 1) assert.equal(staleBatch(closed).length, 0);

  const hidden = fixture({ agent: 'title-agent' });
  for (let i = 0; i < 12; i += 1) assert.equal(staleBatch(hidden).length, 0);
});

test("an agent's brief or follow-up with no open list carries one hidden ask to make one", async () => {
  const { buildUserTurn } = await import('../../manager/ask-turn-prepare.mjs');
  seq += 1;
  const agentSession = {
    id: `sess_todo_start_${seq}`,
    model: 'claude-x',
    owner: 'agent',
    agent: 'worker',
    tools: [{ name: 'read' }, { name: 'todo' }],
    messages: [{ role: 'system', content: 'rules' }],
  };
  const ask = /init the todo list with every ask/;
  const brief = await buildUserTurn({ session: agentSession, prompt: 'Answer three questions.' });
  assert.match(brief.userTurnMessage.content, ask);
  assert.equal(brief.userTurnMessage.content.match(/<system-reminder>/g).length, 1, 'once per prompt');

  const notification = await buildUserTurn({
    session: agentSession,
    prompt: 'A task finished.',
    turnPromptSource: { source: 'task-notification' },
  });
  assert.doesNotMatch(notification.userTurnMessage.content, ask, 'automatic turns carry no ask');

  executeTodoTool(agentSession, { op: 'init', items: ['One', 'Two', 'Three'] });
  const followUp = await buildUserTurn({ session: agentSession, prompt: 'Also check a fourth.' });
  assert.doesNotMatch(followUp.userTurnMessage.content, ask, 'an open list is kept, not re-asked');

  for (const task of ['One', 'Two', 'Three']) executeTodoTool(agentSession, { op: 'done', item: task });
  const next = await buildUserTurn({ session: agentSession, prompt: 'Now a new brief.' });
  assert.match(next.userTurnMessage.content, ask, 'a finished list is let go and the new brief asks again');

  const blocked = { ...agentSession, id: `${agentSession.id}_blocked`, todo: null };
  executeTodoTool(blocked, { op: 'init', items: ['Wait for review'] });
  assert.equal(todoStartReminder(blocked), null, 'an open list is not told to init');
  assert.throws(() => executeTodoTool(blocked, { op: 'init', items: ['New ask'] }), /unfinished items/);

  assert.equal(todoStartReminder({ ...agentSession, todo: null, owner: 'user' }), null, 'the Lead is not asked');
  assert.equal(todoStartReminder({ ...agentSession, todo: null, agent: 'title-agent' }), null);
  assert.equal(todoStartReminder({ ...agentSession, todo: null, tools: [{ name: 'read' }] }), null);
});

test('work with no list at all counts the same mutations and is asked once per cycle to make one', () => {
  const f = fixture({ items: [] });
  for (let i = 0; i < 9; i += 1) staleBatch(f);
  const [nudge] = staleBatch(f);
  assert.match(nudge.content, /No todo list exists/);
  for (let i = 0; i < 25; i += 1) staleBatch(f);
  assert.equal(f.messages.filter((m) => /No todo list exists/.test(m.content ?? '')).length, 1);
});
