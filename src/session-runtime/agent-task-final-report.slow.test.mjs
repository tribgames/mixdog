// A bot's task-session report is the task's FINAL answer: a Lead that hands
// work to agents ends its turn with an interim answer and gives the real one
// in the turn their results wake (notification-bus.mjs). The report waits for
// the turn after which no agent work is pending (the desktop notifier's rule,
// pending-agent-work.mjs) — across a restart too — and a relay turn that does
// not finish is owed again, bounded. Also: rows for an agent that can have no
// chat are dropped, a send that reports nothing says why, and a damaged queue
// file never costs a report.
import '../../scripts/test-data-dir.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  chainClosure,
  createAgentTaskSessions,
  latestTurnOutcome,
  pendingWorkOf,
  taskSessionPendingWork,
} from './agent-task-sessions.mjs';
import { completeBackgroundTask, registerBackgroundTask } from '../runtime/shared/background-tasks.mjs';
import { takeAgentTaskStarts } from '../runtime/shared/agent-task-starts.mjs';
import { createJobStarter } from './services/agent-tool/spawn-flow/job-start.mjs';
import { agentTaskIdOfExecution } from './services/agent-tool/restart-notify.mjs';
import { turnOptionsForBatch } from '../tui/session/session-flow/drain.mjs';
import { createSteeringDrain } from '../runtime/agent/orchestrator/session/loop/steering.mjs';
import { markCompletionEntry } from '../runtime/agent/orchestrator/session/manager/pending-message-entry.mjs';
import { createAskTranscriptMeta } from '../runtime/agent/orchestrator/session/manager/ask-session.mjs';
import { executionResumeKey } from '../tui/session/agent-job-feed/pending-resume.mjs';
import { createAgentHomeDelivery, createRoutineResultQueue, readHomeAgent } from './agent-home-delivery.mjs';
import { createSessionControl } from '../standalone/daemon-session-control.mjs';
import { hasPendingAgentWork, sessionsWithPendingWork } from '../runtime/shared/pending-agent-work.mjs';
import { restoreTranscriptItems } from '../runtime/agent/orchestrator/session/transcript-restore/restore.mjs';
import { STANDALONE_ROOT } from './runtime-paths.mjs';

const HOME = 'sess_home_bot1';
const TASK = 'sess_task_1';
const INTERIM =
  'Two agents are on it (Worker: parser, Reviewer: tests); I will integrate their results when they report.';
const FINAL = 'Done: the parser is refactored, 14 tests added, the suite passes.';

// Lets every report reach the queue file (locked writes) and the home thread.
const pump = async (delivery, n = 15) => {
  for (let i = 0; i < n; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await delivery.drain(HOME);
  }
};
// Drains until `done()` holds (reports cross locked file writes), at most `ms`.
const waitFor = async (delivery, done, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    await delivery.drain(HOME);
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'task-final-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** One data dir (queue file, home thread, task record, agent pool) across
 *  daemon starts; each boot() is a new process over it. */
function world(t, { settleMs = 0, wake = null } = {}) {
  const dir = tempDir(t);
  const file = join(dir, 'routine-results.json');
  const home = { id: HOME, messages: [], generation: 1 };
  const records = new Map();
  // The agent pool rows (listStoredAgentWorkersAsync shape).
  const pool = [];
  // This process's agent tasks (`{ taskId, sessionId, running }`).
  const agentTasks = [];
  const wakes = [];
  const logs = [];
  // Every report a process handed to the delivery, across boots.
  const sent = [];
  function boot(overrides = {}) {
    const { materialize, ...taskOverrides } = overrides;
    const calls = [];
    const state = {};
    const listeners = new Set();
    const runtime = {
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const service = {
      createSession: async (params) => {
        calls.push(['create', params]);
        records.set(TASK, { id: TASK, title: 'Parser', taskOrigin: params.sessionProfile.taskOrigin, messages: [] });
        return { sessionId: TASK };
      },
      configureSession: async () => ({ value: {} }),
      materializeSession: async () => (materialize ? materialize() : runtime),
      submitSession: async (params) => {
        calls.push(['submit', params]);
        return { accepted: true };
      },
    };
    const delivery = createAgentHomeDelivery({
      loadSession: (id) => (id === HOME ? home : null),
      saveSession: async () => {},
      turnInFlight: () => false,
      queue: createRoutineResultQueue(file),
      live: () => ({
        busy: () => false,
        notice: () => true,
        wake: async (id, prompt, options) => {
          wakes.push({ id, prompt, options });
          return wake ? wake(options) : true;
        },
      }),
      retryLater: () => {},
      wakeRetryDelaysMs: [0, 0, 0],
      wakeRefusalLimit: 3,
      log: (line) => logs.push(line),
    });
    const api = createAgentTaskSessions({
      getSessionService: () => service,
      deliver: (agentId, report) => {
        sent.push(report);
        return delivery.enqueueTask(agentId, report);
      },
      watches: {
        add: (watch) => delivery.watchTask(watch),
        list: () => delivery.taskWatches(),
        remove: (runId) => delivery.unwatchTask(runId),
      },
      queuedSubmissionIds: async () => [],
      loadSession: async (id) => records.get(id) || null,
      listProjects: async () => [],
      newTaskDefault: async () => 'branch',
      leadRoute: async () => ({ provider: 'p', model: 'm' }),
      turnArtifacts: async () => ({ files: [], omitted: 0 }),
      agentName: async () => 'Bot One',
      retryDelaysMs: [],
      // The desktop notifier's rule over this world's agent pool, narrowed to
      // the report's chain of agent tasks when it names one.
      pendingWork: async (sessionId, scope) => pendingWorkOf(sessionId, { pool, agentTasks, ...scope }),
      settleMs,
      pollMs: 60_000,
      owedResults: async () => [],
      log: (line) => logs.push(line),
      ...taskOverrides,
    });
    const emit = () => {
      for (const listener of [...listeners]) listener();
    };
    const submits = () => calls.filter(([name]) => name === 'submit').map(([, params]) => params);
    return { api, delivery, state, emit, submits, listeners };
  }
  const task = () => records.get(TASK);
  const reports = () => home.messages.filter((message) => message.meta?.routine?.kind === 'task');
  // A turn's end; progress updates (status 'working') are not one.
  const ended = () =>
    reports().filter((message) => !['started', 'blocked', 'working'].includes(message.meta.routine.status));
  const progress = () => reports().filter((message) => message.meta.routine.status === 'working');
  const watchIds = async () => (await createRoutineResultQueue(file).watches()).map((watch) => watch.runId);
  const watches = async () => createRoutineResultQueue(file).watches();
  return {
    file,
    home,
    records,
    pool,
    agentTasks,
    wakes,
    logs,
    sent,
    boot,
    task,
    reports,
    ended,
    progress,
    watchIds,
    watches,
  };
}

const worker = (status, extra = {}) => ({
  tag: 'worker',
  sessionId: 'sess_agent_worker',
  ownerSessionId: TASK,
  parentSessionId: TASK,
  taskId: 'task_agent_1',
  status,
  stage: status,
  ...extra,
});

/** A woken turn's prompt: the notifications of agent tasks `taskIds`, stored escaped. */
const notificationPrompt = (taskIds) =>
  taskIds
    .map(
      (taskId) =>
        `&lt;task-notification>\n&lt;task-id>${taskId}&lt;/task-id>\n&lt;status>completed&lt;/status>\n&lt;/task-notification>`
    )
    .join('\n\n');

/** The stored rows of turn `checkpointId`: its prompt (a woken turn records
 *  the execution ids it delivered, `consumed`), the `agent` spawn calls it made
 *  with the task ids their results recorded (`spawns`), then its answer. */
function turnRows(
  checkpointId,
  answer,
  { status = 'done', source = '', prompt = 'go', spawns = [], consumed = null } = {}
) {
  const transcript = { checkpointId, ...(consumed ? { consumedExecutionIds: consumed } : {}) };
  return [
    { role: 'user', content: prompt, meta: { ...(source ? { source } : {}), transcript } },
    ...spawns.flatMap((taskId) => [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `call_${taskId}`, name: 'agent', arguments: { type: 'spawn', tag: taskId } }],
      },
      { role: 'tool', toolCallId: `call_${taskId}`, content: 'started', agentTaskIds: [taskId] },
    ]),
    {
      role: 'assistant',
      content: answer,
      meta: {
        transcript: { completion: { status, ...(status === 'failed' ? { detail: answer } : {}), checkpointId } },
      },
    },
  ];
}

/** The agents' results wake the task session's Lead: one turn of its own. */
async function wokenTurn(w, process, answer, options = {}) {
  process.state.busy = true;
  process.emit();
  w.task().messages.push(
    ...turnRows(`it_wake_${w.task().messages.length}`, answer, {
      source: 'task-notification',
      prompt: notificationPrompt(options.reports || ['task_agent_1']),
      consumed: options.reports || ['task_agent_1'],
      ...options,
    })
  );
  process.state.busy = false;
  process.emit();
}

test('a Lead that ends its turn while its agents run reports the final answer of the woken turn, once', async (t) => {
  const w = world(t);
  const p = w.boot();
  await p.api.create(
    { brief: 'Refactor the parser and add tests', title: 'Parser' },
    { callerSessionId: HOME, callerAgentId: 'bot1' }
  );
  const [brief] = p.submits();
  w.task().messages.push(...turnRows(brief.options.id, INTERIM, { spawns: ['task_agent_1'] }));
  w.pool.push(worker('running'));
  brief.options.onSettled({ status: 'done', result: { content: INTERIM } });
  await pump(p.delivery);
  assert.deepEqual(w.ended(), [], 'the interim answer is not reported while an agent runs');
  assert.equal(w.wakes.length, 0);
  assert.deepEqual(await w.watchIds(), [brief.options.id], 'the watch stays open durably');
  // The agent finishes; its result wakes the Lead, which gives the real answer.
  w.pool[0] = worker('completed');
  await wokenTurn(w, p, FINAL);
  await waitFor(p.delivery, () => w.ended().length && w.wakes.length);
  assert.equal(w.ended().length, 1);
  assert.equal(w.ended()[0].meta.routine.status, 'completed');
  assert.match(w.ended()[0].content, new RegExp(FINAL));
  assert.equal(w.ended()[0].content.includes(INTERIM), false);
  assert.equal(w.wakes.length, 1, 'the bot is woken once, to relay the final answer');
  assert.deepEqual(await w.watchIds(), []);
  assert.equal(p.listeners.size, 0, 'the watch ends with the report');
  // Later state changes report nothing more.
  p.emit();
  await pump(p.delivery);
  assert.equal(w.ended().length, 1);
});

test('a Lead with no pending agent work reports its own answer at once', async (t) => {
  const w = world(t);
  const p = w.boot();
  await p.api.create({ brief: 'Read the README' }, { callerSessionId: HOME, callerAgentId: 'bot1' });
  const [brief] = p.submits();
  brief.options.onSettled({ status: 'done', result: { content: '# mixdog' } });
  await waitFor(p.delivery, () => w.ended().length);
  assert.equal(w.ended().length, 1);
  assert.match(w.ended()[0].content, /# mixdog/);
});

test('a restart while the agents run still reports the final answer once', async (t) => {
  const w = world(t);
  const first = w.boot();
  await first.api.create({ brief: 'Refactor', title: 'Parser' }, { callerSessionId: HOME, callerAgentId: 'bot1' });
  const [brief] = first.submits();
  w.task().messages.push(...turnRows(brief.options.id, INTERIM, { spawns: ['task_agent_1'] }));
  w.pool.push(worker('running'));
  brief.options.onSettled({ status: 'done', result: { content: INTERIM } });
  await pump(first.delivery);
  assert.deepEqual(w.ended(), []);
  // The daemon stops; the next start re-attaches the open watch.
  const second = w.boot();
  assert.equal(await second.api.recover(), 1);
  await pump(second.delivery);
  assert.deepEqual(w.ended(), [], 'still nothing while the agent runs');
  w.pool[0] = worker('failed', { failureReason: 'process-restart' });
  await wokenTurn(w, second, FINAL);
  await waitFor(second.delivery, () => w.ended().length && w.wakes.length);
  assert.equal(w.ended().length, 1);
  assert.match(w.ended()[0].content, new RegExp(FINAL));
  assert.equal(w.wakes.length, 1);
  assert.deepEqual(await w.watchIds(), []);
  assert.equal(await w.boot().api.recover(), 0, 'a later start has nothing to re-attach');
});

test('nested delegation: a grandchild still running holds the report; a cancel not yet proven does too', async (t) => {
  const w = world(t);
  const p = w.boot();
  await p.api.create({ brief: 'Refactor' }, { callerSessionId: HOME, callerAgentId: 'bot1' });
  const [brief] = p.submits();
  w.task().messages.push(...turnRows(brief.options.id, INTERIM, { spawns: ['task_agent_1'] }));
  // The child finished; the grandchild it spawned keeps the Lead as its owner.
  w.pool.push(worker('completed'), {
    tag: 'grandchild',
    sessionId: 'sess_agent_grand',
    ownerSessionId: TASK,
    parentSessionId: 'sess_agent_worker',
    status: 'running',
    stage: 'tool_running',
  });
  brief.options.onSettled({ status: 'done', result: { content: INTERIM } });
  await pump(p.delivery);
  assert.deepEqual(w.ended(), []);
  w.pool[1] = { ...w.pool[1], status: 'cancel-unconfirmed', stage: 'cancel-unconfirmed' };
  await wokenTurn(w, p, 'The reviewer was stopped; waiting for it to exit.');
  await pump(p.delivery);
  assert.deepEqual(w.ended(), [], 'an unconfirmed cancel is still pending work');
  w.pool[1] = { ...w.pool[1], status: 'cancelled', stage: 'cancelled' };
  await wokenTurn(w, p, FINAL);
  await waitFor(p.delivery, () => w.ended().length);
  assert.equal(w.ended().length, 1);
  assert.match(w.ended()[0].content, new RegExp(FINAL));
});

test('the pending-work rule matches the desktop notifier', () => {
  assert.equal(hasPendingAgentWork({ status: 'running', stage: 'streaming' }), true);
  assert.equal(hasPendingAgentWork({ status: 'queued' }), true);
  assert.equal(hasPendingAgentWork({ status: 'cancel-unconfirmed' }), true);
  assert.equal(hasPendingAgentWork({ status: 'cancelled', stage: 'running' }), false);
  assert.equal(hasPendingAgentWork({ status: 'completed' }), false);
  assert.equal(hasPendingAgentWork({ status: 'unknown' }), false);
  assert.equal(hasPendingAgentWork({ status: 'idle', stage: 'running' }), false, 'status decides over stage');
  const pending = sessionsWithPendingWork([
    { sessionId: 'lead', ownerSessionId: 'lead', status: 'running' },
    { sessionId: 'a', ownerSessionId: 'lead2', status: 'running' },
    { sessionId: 'b', ownerSessionId: 'lead3', status: 'completed' },
  ]);
  assert.deepEqual([...pending], ['lead2'], "a Lead's own row never holds it");
});

test('a failed or cancelled task reports its failure once, without waiting', async (t) => {
  const w = world(t);
  const p = w.boot();
  await p.api.create({ brief: 'Refactor' }, { callerSessionId: HOME, callerAgentId: 'bot1' });
  const [brief] = p.submits();
  w.pool.push(worker('running'));
  brief.options.onSettled({ status: 'failed', error: 'provider down' });
  await waitFor(p.delivery, () => w.ended().length);
  assert.deepEqual(
    w.ended().map((message) => message.meta.routine.status),
    ['failed']
  );
  assert.match(w.ended()[0].content, /provider down/);
  p.emit();
  await pump(p.delivery);
  assert.equal(w.ended().length, 1, 'reported once');

  // A woken turn that fails, once the agents are done, is the final outcome.
  const v = world(t);
  const q = v.boot();
  await q.api.create({ brief: 'Refactor' }, { callerSessionId: HOME, callerAgentId: 'bot1' });
  const [second] = q.submits();
  v.task().messages.push(...turnRows(second.options.id, INTERIM, { spawns: ['task_agent_1'] }));
  v.pool.push(worker('running'));
  second.options.onSettled({ status: 'done', result: { content: INTERIM } });
  await pump(q.delivery);
  v.pool[0] = worker('completed');
  await wokenTurn(v, q, 'quota exhausted', { status: 'failed' });
  await waitFor(q.delivery, () => v.ended().length);
  assert.deepEqual(
    v.ended().map((message) => message.meta.routine.status),
    ['failed']
  );
  assert.match(v.ended()[0].content, /quota exhausted/);
});

test('the answer is final only after a quiet period: a turn the agents wake right after replaces it', async (t) => {
  const w = world(t, { settleMs: 400 });
  const p = w.boot();
  await p.api.create({ brief: 'Refactor' }, { callerSessionId: HOME, callerAgentId: 'bot1' });
  const [brief] = p.submits();
  w.task().messages.push(...turnRows(brief.options.id, INTERIM, { spawns: ['task_agent_1'] }));
  // The agent finished just as the turn ended; its result has not woken the Lead yet.
  brief.options.onSettled({ status: 'done', result: { content: INTERIM } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(w.ended(), []);
  await wokenTurn(w, p, FINAL);
  await waitFor(p.delivery, () => w.ended().length);
  assert.equal(w.ended().length, 1);
  assert.match(w.ended()[0].content, new RegExp(FINAL));
});

test('a turn the user types during the quiet period never replaces the delegated answer', async (t) => {
  const w = world(t, { settleMs: 400 });
  const p = w.boot();
  await p.api.create({ brief: 'Refactor' }, { callerSessionId: HOME, callerAgentId: 'bot1' });
  const [brief] = p.submits();
  w.task().messages.push(...turnRows(brief.options.id, INTERIM, { spawns: ['task_agent_1'] }));
  w.pool.push(worker('running'));
  brief.options.onSettled({ status: 'done', result: { content: INTERIM } });
  await pump(p.delivery);
  w.pool[0] = worker('completed');
  await wokenTurn(w, p, FINAL);
  // The user writes in the task session right after the agents' answer.
  p.state.busy = true;
  p.emit();
  w.task().messages.push(...turnRows('desktop-submit-1', 'my own question, answered'));
  p.state.busy = false;
  p.emit();
  await waitFor(p.delivery, () => w.ended().length);
  await pump(p.delivery);
  assert.equal(w.ended().length, 1);
  assert.match(w.ended()[0].content, new RegExp(FINAL));
  assert.equal(w.ended()[0].content.includes('my own question'), false);
});

test('two watchers of one task session each report their own chain, once', async (t) => {
  const w = world(t);
  const p = w.boot();
  await p.api.create({ brief: 'Refactor' }, { callerSessionId: HOME, callerAgentId: 'bot1' });
  const [brief] = p.submits();
  w.task().messages.push(...turnRows(brief.options.id, INTERIM, { spawns: ['task_agent_1'] }));
  w.pool.push(worker('running'));
  brief.options.onSettled({ status: 'done', result: { content: INTERIM } });
  // The bot follows up while the agent still runs.
  const origin = await p.api.reportOrigin(TASK, 'bot1', HOME);
  await p.api.send(TASK, 'and the docs?', origin);
  const [, followUp] = p.submits();
  w.task().messages.push(...turnRows(followUp.options.id, 'Docs are next on the list.'));
  followUp.options.onSettled({ status: 'done', result: { content: 'Docs are next on the list.' } });
  await waitFor(p.delivery, () => w.ended().length);
  await pump(p.delivery);
  assert.deepEqual(
    w.ended().map((message) => message.content.includes('Docs are next')),
    [true],
    "the follow-up started no agent: the brief's running agent never holds it"
  );
  w.pool[0] = worker('completed');
  await wokenTurn(w, p, FINAL);
  await waitFor(p.delivery, () => w.ended().length === 2);
  await pump(p.delivery);
  const texts = w.ended().map((message) => message.content);
  assert.equal(texts.length, 2);
  assert.equal(
    texts.filter((text) => text.includes(FINAL)).length,
    1,
    'the woken answer is reported once, by its chain'
  );
  assert.equal(texts.filter((text) => text.includes('Docs are next')).length, 1);
});

// ---- every answer of a busy chain is a progress update that wakes nobody ----

/** The task-output text of a stored report row; '' when it carries none. */
const reportText = (message) => message.content.match(/<task-output[^>]*>\n([\s\S]*?)\n<\/task-output>/)?.[1] ?? '';

/** The answer `w`'s final report gives: its own text, or that of the
 *  progress update above it when it already carried the answer. */
const finalAnswer = (w) => {
  const [end] = w.ended();
  return /final answer is its latest progress update above/.test(end.content)
    ? reportText(w.progress().at(-1))
    : reportText(end);
};

/** Whether any report row of `w` (progress or end) carries `text`. */
const anyReportHas = (w, text) => w.reports().some((message) => message.content.includes(text));

test('a busy chain answering repeatedly posts each answer once as progress, waking nobody, then wakes once for the final', async (t) => {
  for (const kind of ['create', 'send']) {
    const w = world(t);
    const p = w.boot();
    let first;
    if (kind === 'create') {
      await p.api.create({ brief: 'Refactor' }, { callerSessionId: HOME, callerAgentId: 'bot1' });
      [first] = p.submits();
    } else {
      first = await sentRequest(w, p);
    }
    w.task().messages.push(...turnRows(first.options.id, INTERIM, { spawns: ['task_agent_1'] }));
    // Two agents: the first reports twice (a Reviewer re-run), the second stays busy.
    w.pool.push(worker('running'), { ...worker('running'), tag: 'reviewer', sessionId: 'sess_agent_rev' });
    first.options.onSettled({ status: 'done', result: { content: INTERIM } });
    await pump(p.delivery);
    const answers = ['Worker reported: parser done; Reviewer is checking.', 'Reviewer asked for a fix; Worker is on it.'];
    for (const answer of answers) {
      await wokenTurn(w, p, answer);
      await pump(p.delivery);
    }
    p.emit();
    // A completion barrier, not a guess: the rows cross locked file writes.
    // A dropped answer never reaches the count, so the exact check still fails.
    await waitFor(p.delivery, () => w.progress().length >= 3);
    await pump(p.delivery);
    assert.deepEqual(
      w.progress().map(reportText),
      [INTERIM, ...answers],
      `${kind}: every answer, once, in order (log: ${w.logs.join(' | ')})`
    );
    for (const row of w.progress()) {
      assert.match(row.content, /progress update — still working; this is NOT its final answer/);
      assert.equal(row.meta.transcript.posted, true, 'a posted row');
    }
    assert.deepEqual(w.ended(), [], `${kind}: no end while its agents work`);
    assert.equal(w.wakes.length, 0, `${kind}: the bot is never woken for progress`);
    assert.equal((await w.watchIds()).length, 1, `${kind}: the watch stays for the final report`);
    // Every agent is done: the woken turn's answer is final and wakes the bot once.
    w.pool.splice(0, 2, worker('completed'), { ...worker('completed'), tag: 'reviewer', sessionId: 'sess_agent_rev' });
    await wokenTurn(w, p, FINAL);
    await waitFor(p.delivery, () => w.ended().length && w.wakes.length);
    await pump(p.delivery);
    assert.deepEqual(
      w.ended().map((message) => message.meta.routine.status),
      ['completed']
    );
    assert.equal(reportText(w.ended()[0]), FINAL);
    assert.equal(w.progress().length, 3, `${kind}: the final answer is no progress update`);
    assert.equal(w.wakes.length, 1);
    assert.match(w.wakes[0].prompt, new RegExp(FINAL));
    assert.equal(w.wakes[0].prompt.includes(INTERIM), false, 'the wake carries the final report alone');
    assert.deepEqual(await w.watchIds(), []);
  }
});

test('answers that end inside one check window are each reported, in order, once — also across a restart', async (t) => {
  const woken = (n, answer) =>
    turnRows(`it_wake_${n}`, answer, {
      source: 'task-notification',
      prompt: notificationPrompt(['task_agent_1']),
      consumed: ['task_agent_1'],
    });
  const progressSent = (w, from = 0) =>
    w.sent
      .slice(from)
      .filter((report) => report.status === 'working')
      .map((report) => report.text);

  // One process: the brief's answer and three woken turns are all stored
  // before the follow-up's first check, which therefore sees them at once.
  const v = world(t);
  const p = v.boot();
  const request = await sentRequest(v, p);
  v.task().messages.push(
    ...turnRows(request.options.id, INTERIM, { spawns: ['task_agent_1'] }),
    ...woken(1, 'A1'),
    ...woken(2, 'A2'),
    ...woken(3, 'A3')
  );
  v.pool.push(worker('running'));
  request.options.onSettled({ status: 'done', result: { content: INTERIM } });
  await waitFor(p.delivery, () => v.progress().length >= 4);
  p.emit();
  await pump(p.delivery);
  assert.deepEqual(progressSent(v), [INTERIM, 'A1', 'A2', 'A3'], 'each handed over once, in chain order');
  assert.deepEqual(v.progress().map(reportText), [INTERIM, 'A1', 'A2', 'A3'], 'each posted once, in order');
  assert.equal(v.wakes.length, 0);
  assert.equal((await v.watches())[0].progressed, 'it_wake_3', 'the durable mark names the last one reported');

  // Across a restart: the first process reports up to A1; A2 and A3 end
  // together while the daemon is down.
  const w = world(t);
  const first = w.boot();
  const sent = await sentRequest(w, first);
  w.task().messages.push(...turnRows(sent.options.id, INTERIM, { spawns: ['task_agent_1'] }), ...woken(1, 'A1'));
  w.pool.push(worker('running'));
  sent.options.onSettled({ status: 'done', result: { content: INTERIM } });
  await waitFor(first.delivery, () => w.progress().length >= 2);
  await pump(first.delivery);
  assert.deepEqual(w.progress().map(reportText), [INTERIM, 'A1']);
  assert.equal((await w.watches())[0].progressed, 'it_wake_1');
  w.task().messages.push(...woken(2, 'A2'), ...woken(3, 'A3'));
  const before = w.sent.length;
  const second = w.boot();
  // Recovery's first check reports (and queues) before it resolves.
  assert.equal(await second.api.recover(), 1);
  assert.deepEqual(progressSent(w, before), ['A2', 'A3'], 'only the turns past the durable mark, in order');
  await waitFor(second.delivery, () => w.progress().length >= 4);
  await pump(second.delivery);
  assert.deepEqual(w.progress().map(reportText), [INTERIM, 'A1', 'A2', 'A3'], 'each posted once, in order');
  assert.equal((await w.watches())[0].progressed, 'it_wake_3');
  // The chain's last turn then ends with nothing pending: the final report.
  w.pool[0] = worker('completed');
  await wokenTurn(w, second, FINAL);
  await waitFor(second.delivery, () => w.ended().length && w.wakes.length);
  assert.equal(finalAnswer(w), FINAL);
  assert.equal(w.progress().length, 4, 'no update twice');
  assert.equal(w.wakes.length, 1);
});

test('a progress update that cannot be queued holds the later ones; a restart delivers them once, in order', async (t) => {
  const woken = (n, answer) =>
    turnRows(`it_wake_${n}`, answer, {
      source: 'task-notification',
      prompt: notificationPrompt(['task_agent_1']),
      consumed: ['task_agent_1'],
    });
  const w = world(t);
  let first = null;
  first = w.boot({
    // A1's update can never be queued in this process (every try fails).
    deliver: async (agentId, report) => {
      if (report.runId.endsWith('_progress_it_wake_1')) throw new Error('queue file locked');
      w.sent.push(report);
      return first.delivery.enqueueTask(agentId, report);
    },
  });
  const request = await sentRequest(w, first);
  w.task().messages.push(...turnRows(request.options.id, INTERIM, { spawns: ['task_agent_1'] }));
  w.pool.push(worker('running'));
  request.options.onSettled({ status: 'done', result: { content: INTERIM } });
  await waitFor(first.delivery, () => w.progress().length >= 1);
  const failures = () => w.logs.filter((line) => /progress update of sess_task_1 failed/.test(line)).length;
  // A1 ends: its update fails.
  w.task().messages.push(...woken(1, 'A1'));
  first.emit();
  await waitFor(first.delivery, () => failures() >= 1);
  // A2 ends: it waits behind A1, which is tried again and fails again.
  w.task().messages.push(...woken(2, 'A2'));
  first.emit();
  await waitFor(first.delivery, () => failures() >= 2);
  await pump(first.delivery);
  const progressTexts = (from = 0) =>
    w.sent
      .slice(from)
      .filter((report) => report.status === 'working')
      .map((report) => report.text);
  assert.deepEqual(progressTexts(), [INTERIM], 'nothing goes out past the failed update');
  assert.deepEqual(w.progress().map(reportText), [INTERIM]);
  assert.equal((await w.watches())[0].progressed, request.options.id, 'the mark stays on the last update queued');
  // The daemon restarts: recovery resumes right after the mark.
  const before = w.sent.length;
  const second = w.boot();
  assert.equal(await second.api.recover(), 1);
  assert.deepEqual(progressTexts(before), ['A1', 'A2'], 'A1, then A2, each once');
  await waitFor(second.delivery, () => w.progress().length >= 3);
  await pump(second.delivery);
  assert.deepEqual(w.progress().map(reportText), [INTERIM, 'A1', 'A2']);
  assert.equal((await w.watches())[0].progressed, 'it_wake_2');
  assert.equal(w.wakes.length, 0);
});

test('the chain walk is linear in the transcript: no turn rescans what came before', () => {
  const readsPerMessage = (turnCount) => {
    const rows = turnRows('a', 'interim', { spawns: ['task_agent_1'] });
    for (let n = 1; n <= turnCount; n += 1) {
      rows.push(
        ...turnRows(`it_${n}`, `answer ${n}`, {
          source: 'task-notification',
          prompt: notificationPrompt(['task_agent_1']),
          consumed: ['task_agent_1'],
        })
      );
    }
    let reads = 0;
    const counted = new Proxy(rows, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    assert.equal(latestTurnOutcome(counted, 'a').id, `it_${turnCount}`);
    return reads / rows.length;
  };
  const small = readsPerMessage(50);
  const large = readsPerMessage(1000);
  assert.ok(large <= 6, `${large.toFixed(2)} reads per message at 1000 turns`);
  assert.ok(large <= small + 0.5, `per-message reads stay flat (${small.toFixed(2)} → ${large.toFixed(2)})`);
});

test('a final answer that already went out as progress is not repeated by the final report', async (t) => {
  const w = world(t);
  const p = w.boot();
  await p.api.create({ brief: 'Refactor' }, { callerSessionId: HOME, callerAgentId: 'bot1' });
  const [brief] = p.submits();
  w.task().messages.push(...turnRows(brief.options.id, INTERIM, { spawns: ['task_agent_1'] }));
  w.pool.push(worker('running'));
  brief.options.onSettled({ status: 'done', result: { content: INTERIM } });
  await waitFor(p.delivery, () => w.progress().length >= 1);
  await pump(p.delivery);
  assert.deepEqual(w.progress().map(reportText), [INTERIM]);
  // The agent ends with no turn of the Lead after it: that answer is final.
  w.pool[0] = worker('completed');
  p.emit();
  await waitFor(p.delivery, () => w.ended().length && w.wakes.length);
  await pump(p.delivery);
  const [end] = w.ended();
  assert.equal(end.meta.routine.status, 'completed');
  assert.equal(end.content.includes(INTERIM), false, 'the answer is not repeated');
  assert.match(end.content, /final answer is its latest progress update above/);
  assert.equal(end.meta.routine.summary, INTERIM, 'the row keeps its one-line summary');
  assert.equal(w.wakes.length, 1, 'the end still wakes the bot');
  assert.deepEqual(w.progress().map(reportText), [INTERIM], 'posted once');
  assert.ok(w.home.messages.indexOf(w.progress()[0]) < w.home.messages.indexOf(end), 'the update comes first');
});

test('a restart between progress updates posts each one once', async (t) => {
  const w = world(t);
  const first = w.boot();
  await first.api.create({ brief: 'Refactor', title: 'Parser' }, { callerSessionId: HOME, callerAgentId: 'bot1' });
  const [brief] = first.submits();
  w.task().messages.push(...turnRows(brief.options.id, INTERIM, { spawns: ['task_agent_1'] }));
  w.pool.push(worker('running'));
  brief.options.onSettled({ status: 'done', result: { content: INTERIM } });
  await pump(first.delivery);
  await wokenTurn(w, first, 'Halfway there.');
  await waitFor(first.delivery, () => w.progress().length >= 2);
  await pump(first.delivery);
  assert.deepEqual(w.progress().map(reportText), [INTERIM, 'Halfway there.']);
  // The daemon stops; the next start re-attaches the watch and sees the same latest answer.
  const second = w.boot();
  assert.equal(await second.api.recover(), 1);
  await pump(second.delivery);
  second.emit();
  await pump(second.delivery);
  assert.deepEqual(w.progress().map(reportText), [INTERIM, 'Halfway there.'], 'nothing posts twice');
  assert.equal(w.wakes.length, 0);
  w.pool[0] = worker('completed');
  await wokenTurn(w, second, FINAL);
  await waitFor(second.delivery, () => w.ended().length && w.wakes.length);
  assert.equal(reportText(w.ended()[0]), FINAL);
  assert.equal(w.progress().length, 2);
  assert.equal(w.wakes.length, 1);
});

test('a send whose turn reports nothing posts no progress either', async (t) => {
  const w = world(t);
  const p = w.boot();
  await p.api.create({ brief: 'quiet', notify: false }, { callerSessionId: HOME, callerAgentId: 'bot1' });
  const [brief] = p.submits();
  w.task().messages.push(...turnRows(brief.options.id, INTERIM, { spawns: ['task_agent_1'] }));
  w.pool.push(worker('running'));
  brief.options.onSettled?.({ status: 'done', result: { content: INTERIM } });
  await wokenTurn(w, p, 'Halfway there.');
  await pump(p.delivery);
  assert.deepEqual(w.reports(), []);
  assert.equal(w.wakes.length, 0);
});

// ---- the report waits on its own chain, never on other work in the session ----

/** The user's own agent in the task session: work outside any bot's chain. */
const userAgent = (status) => ({
  tag: 'user-agent',
  sessionId: 'sess_agent_user',
  ownerSessionId: TASK,
  parentSessionId: TASK,
  taskId: 'task_agent_user',
  status,
  stage: status,
});

/** A bot's send to the plain coding session TASK (not one it created). */
async function sentRequest(w, p, prompt = 'check the scheduler', agentId = 'bot1', home = HOME) {
  if (!w.task()) w.records.set(TASK, { id: TASK, title: 'Coding', messages: [] });
  const before = p.submits().length;
  const sent = await p.api.send(TASK, prompt, await p.api.reportOrigin(TASK, agentId, home));
  assert.equal(sent.reportsBack, true);
  return p.submits()[before];
}

test("a request answered while the user's own later turns keep agents working reports at once, with only its own answers", async (t) => {
  const w = world(t);
  const p = w.boot();
  const request = await sentRequest(w, p);
  w.task().messages.push(...turnRows(request.options.id, INTERIM, { spawns: ['task_agent_1'] }));
  w.pool.push(worker('running'));
  request.options.onSettled({ status: 'done', result: { content: INTERIM } });
  await pump(p.delivery);
  assert.deepEqual(w.ended(), [], "the request's own agent holds it");
  // The user goes on in the same session: their turn starts an agent of its own.
  w.task().messages.push(
    ...turnRows('desktop-submit-1', 'My agent is on the other thing.', { spawns: ['task_agent_user'] })
  );
  w.pool.push(userAgent('running'));
  // The request's agent finishes; its woken turn answers.
  w.pool[0] = worker('completed');
  await wokenTurn(w, p, FINAL);
  await waitFor(p.delivery, () => w.ended().length);
  // With the user's agent still running, nothing more.
  await new Promise((resolve) => setTimeout(resolve, 80));
  p.emit();
  await pump(p.delivery);
  assert.deepEqual(
    w.ended().map((message) => message.meta.routine.status),
    ['completed']
  );
  assert.match(w.ended()[0].content, new RegExp(FINAL));
  assert.equal(w.ended()[0].content.includes('My agent'), false);
  assert.deepEqual(w.progress().map(reportText), [INTERIM], "the user's own turn is never the request's progress");
  assert.deepEqual(await w.watchIds(), [], 'the watch closes');
  assert.equal(p.listeners.size, 0);
});

test("a chain that ends while the user's own turn runs reports at once, with the chain's answer", async (t) => {
  // The request's own turn answered with no agent, the user's turn already running.
  const v = world(t);
  const q = v.boot();
  const request = await sentRequest(v, q);
  v.task().messages.push(
    ...turnRows(request.options.id, 'The scheduler runs hourly.'),
    ...turnRows('desktop-submit-1', 'not yet', { spawns: ['task_agent_user'] }).slice(0, -1)
  );
  v.pool.push(userAgent('running'));
  q.state.busy = true;
  request.options.onSettled({ status: 'done', result: { content: 'The scheduler runs hourly.' } });
  await waitFor(q.delivery, () => v.ended().length);
  assert.deepEqual(
    v.ended().map((message) => message.meta.routine.status),
    ['completed']
  );
  assert.match(v.ended()[0].content, /The scheduler runs hourly\./);
  assert.deepEqual(await v.watchIds(), []);

  // The chain's woken turn ended just as the user's next turn started.
  const w = world(t);
  const p = w.boot();
  const sent = await sentRequest(w, p);
  w.task().messages.push(...turnRows(sent.options.id, INTERIM, { spawns: ['task_agent_1'] }));
  w.pool.push(worker('running'));
  sent.options.onSettled({ status: 'done', result: { content: INTERIM } });
  await pump(p.delivery);
  assert.deepEqual(w.ended(), []);
  p.state.busy = true;
  w.pool[0] = worker('completed');
  w.task().messages.push(
    ...turnRows('it_wake_1', FINAL, {
      source: 'task-notification',
      prompt: notificationPrompt(['task_agent_1']),
      consumed: ['task_agent_1'],
    }),
    ...turnRows('desktop-submit-2', 'the user answer', { spawns: ['task_agent_user'] }).slice(0, -1)
  );
  w.pool.push(userAgent('running'));
  p.emit();
  await waitFor(p.delivery, () => w.ended().length);
  assert.equal(p.state.busy, true, "reported while the user's turn still runs");
  assert.equal(w.ended().length, 1);
  assert.match(w.ended()[0].content, new RegExp(FINAL));
  assert.equal(w.ended()[0].content.includes('the user answer'), false);
  assert.deepEqual(await w.watchIds(), []);
});

test('a turn the chain woke whose prompt is not stored yet holds the report until it ends', async (t) => {
  for (const stale of [false, true]) {
    const w = world(t, { settleMs: 30 });
    const p = w.boot();
    const request = await sentRequest(w, p);
    w.task().messages.push(...turnRows(request.options.id, INTERIM, { spawns: ['task_agent_1'] }));
    w.pool.push(worker('running'));
    request.options.onSettled({ status: 'done', result: { content: INTERIM } });
    await pump(p.delivery);
    // `stale`: a turn of the user's ran meanwhile, its end not stored yet either.
    const user = turnRows('desktop-submit-1', 'mine');
    if (stale) w.task().messages.push(...user.slice(0, -1));
    // The agent finishes; its result wakes the Lead, whose prompt save lags
    // well past the quiet period.
    w.pool[0] = worker('completed');
    p.state.busy = true;
    p.emit();
    await new Promise((resolve) => setTimeout(resolve, 150));
    p.emit();
    await pump(p.delivery);
    assert.deepEqual(w.ended(), [], `${stale ? 'stale' : 'plain'}: nothing while that turn runs unsaved`);
    if (stale) w.task().messages.push(...user.slice(-1));
    w.task().messages.push(
      ...turnRows('it_wake_1', FINAL, {
        source: 'task-notification',
        prompt: notificationPrompt(['task_agent_1']),
        consumed: ['task_agent_1'],
      })
    );
    p.state.busy = false;
    p.emit();
    await waitFor(p.delivery, () => w.ended().length);
    await pump(p.delivery);
    assert.deepEqual(
      w.ended().map((message) => message.meta.routine.status),
      ['completed']
    );
    assert.match(w.ended()[0].content, new RegExp(FINAL));
  }
});

test("a chain result steered into the user's running turn, not stored yet, holds the report until it ends", async (t) => {
  const w = world(t, { settleMs: 30 });
  const p = w.boot();
  const request = await sentRequest(w, p);
  w.task().messages.push(...turnRows(request.options.id, INTERIM, { spawns: ['task_agent_1'] }));
  w.pool.push(worker('running'));
  request.options.onSettled({ status: 'done', result: { content: INTERIM } });
  await pump(p.delivery);
  // The user's own turn runs, its prompt stored, when the agent finishes.
  const [prompt, ...rest] = turnRows('desktop-submit-1', FINAL);
  w.task().messages.push(prompt);
  p.state.busy = true;
  p.emit();
  // The result is steered into that turn; the steer is not stored yet.
  w.pool[0] = worker('completed');
  p.emit();
  await new Promise((resolve) => setTimeout(resolve, 150));
  p.emit();
  await pump(p.delivery);
  assert.deepEqual(w.ended(), [], 'nothing while the steered result is unsaved');
  w.task().messages.push(...steeredCompletion('task_agent_1'), ...rest);
  p.state.busy = false;
  p.emit();
  await waitFor(p.delivery, () => w.ended().length);
  await pump(p.delivery);
  assert.equal(w.ended().length, 1);
  assert.match(w.ended()[0].content, new RegExp(FINAL));
  assert.equal(w.ended()[0].content.includes(INTERIM), false);
});

test('two bots sending to one session each report when their own chain ends', async (t) => {
  const w = world(t);
  const sent = [];
  const p = w.boot({
    deliver: async (agentId, report) => {
      sent.push([agentId, report]);
    },
  });
  const first = await sentRequest(w, p, 'refactor the parser', 'bot1', HOME);
  const second = await sentRequest(w, p, 'what time is it there?', 'bot2', 'sess_home_bot2');
  w.task().messages.push(
    ...turnRows(first.options.id, INTERIM, { spawns: ['task_agent_1'] }),
    ...turnRows(second.options.id, 'It is noon.')
  );
  w.pool.push(worker('running'));
  first.options.onSettled({ status: 'done', result: { content: INTERIM } });
  second.options.onSettled({ status: 'done', result: { content: 'It is noon.' } });
  const ends = () => sent.filter(([, report]) => report.runId.endsWith('_end'));
  for (let i = 0; i < 50 && !ends().length; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(
    ends().map(([agentId, report]) => [agentId, report.text]),
    [['bot2', 'It is noon.']],
    "bot2's chain started no agent: bot1's running agent never holds it"
  );
  w.pool[0] = worker('completed');
  await wokenTurn(w, p, FINAL);
  for (let i = 0; i < 50 && ends().length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(
    ends().map(([agentId, report]) => [agentId, report.text]),
    [
      ['bot2', 'It is noon.'],
      ['bot1', FINAL],
    ]
  );
});

test("a chain agent's sub-agents hold the report; the user's agents never do", async (t) => {
  const w = world(t, { settleMs: 0 });
  const p = w.boot();
  const request = await sentRequest(w, p);
  w.task().messages.push(
    ...turnRows(request.options.id, INTERIM, { spawns: ['task_agent_1'] }),
    ...turnRows('desktop-submit-1', 'mine', { spawns: ['task_agent_user'] })
  );
  // The chain's agent finished, the sub-agent it spawned still runs (its row
  // names the Lead as owner, the chain agent as parent).
  const sub = (status) => ({
    tag: 'sub',
    sessionId: 'sess_agent_sub',
    ownerSessionId: TASK,
    parentSessionId: 'sess_agent_worker',
    taskId: 'task_agent_sub',
    status,
    stage: status,
  });
  w.pool.push(worker('completed'), sub('running'), userAgent('running'));
  request.options.onSettled({ status: 'done', result: { content: INTERIM } });
  await pump(p.delivery);
  assert.deepEqual(w.ended(), [], 'a sub-agent of the chain is chain work');
  w.pool[1] = sub('completed');
  await wokenTurn(w, p, FINAL);
  await waitFor(p.delivery, () => w.ended().length);
  assert.equal(w.ended().length, 1);
  assert.match(w.ended()[0].content, new RegExp(FINAL));
});

/** A child agent the chain's agent spawned: the Lead owns it, the agent is its parent. */
const child = (status) => ({
  tag: 'child',
  sessionId: 'sess_agent_child',
  ownerSessionId: TASK,
  parentSessionId: 'sess_agent_worker',
  taskId: 'task_agent_child',
  status,
  stage: status,
  ...(status === 'failed' ? { failureReason: 'process-restart' } : {}),
});

test("pendingWorkOf narrowed to a chain counts only the chain's tasks, sessions and results", () => {
  const chain = new Set(['task_agent_1']);
  const pool = [worker('completed'), userAgent('running')];
  const of = (state) => pendingWorkOf(TASK, { pool, taskIds: chain, ...state });
  assert.equal(of({}), false, "the user's running agent is not the chain's");
  assert.equal(pendingWorkOf(TASK, { pool }), true, 'the whole session still waits on it');
  assert.equal(of({ agentTasks: [{ taskId: 'task_agent_1', sessionId: null, running: true }] }), true, 'queued');
  assert.equal(of({ agentTasks: [{ taskId: 'task_agent_user', sessionId: null, running: true }] }), false);
  assert.equal(of({ working: new Set(['sess_agent_worker']) }), true, "the chain agent's turn in flight");
  assert.equal(of({ working: new Set([TASK, 'sess_agent_user']) }), false, "the Lead's or the user's turn");
  assert.equal(of({ agentTaskOwners: new Set(['sess_agent_worker']) }), true, 'a sub-agent queued by it');
  assert.equal(of({ agentTaskOwners: new Set([TASK, 'sess_agent_user']) }), false);
  const owed = (executionId) => [{ text: '', meta: { execution_id: executionId } }];
  assert.equal(of({ owed: owed('restart:task_agent_1') }), true);
  assert.equal(of({ owed: owed('task_agent_user') }), false);
  assert.equal(of({ owed: owed('restart:sess_x:123') }), true, 'a result naming no task may be the chain’s');
  // A finished chain agent's child, failed by a restart: its result, owed
  // to the Lead, may be the chain's, so it holds the report — but no record
  // proves which task spawned the child, so the chain never owns it.
  const family = [worker('completed'), child('failed'), userAgent('failed')];
  const ofFamily = (executionId) => pendingWorkOf(TASK, { pool: family, taskIds: chain, owed: owed(executionId) });
  assert.equal(ofFamily('restart:task_agent_child'), true, "the chain agent's child result holds it");
  assert.equal(ofFamily('restart:task_agent_user'), false);
  const closure = chainClosure(TASK, chain, { pool: family });
  assert.deepEqual([...closure.taskIds], ['task_agent_1'], 'only the tasks chain turns started are owned');
  assert.deepEqual([...closure.sessions], ['sess_agent_worker', 'sess_agent_child']);
});

test("after a restart, a chain agent's child result owed to the Lead holds the report until a turn takes it", async (t) => {
  const w = await heldAcrossRestart(t);
  // Before the stop the chain's agent finished and its woken turn answered.
  w.task().messages.push(
    ...turnRows('it_wake_1', FINAL, {
      source: 'task-notification',
      prompt: notificationPrompt(['task_agent_1']),
      consumed: ['task_agent_1'],
    })
  );
  const owed = [];
  const delivered = [];
  const second = w.boot({
    // The task session's pending work counts its owed results (taskSessionPendingWork).
    pendingWork: async (sessionId, scope) => pendingWorkOf(sessionId, { pool: w.pool, owed: [...owed], ...scope }),
    // The chain's agent finished before the stop; the child it spawned was
    // killed, and its failure is owed to the Lead (restart-notify).
    settleAgentResults: async () => {
      w.pool[0] = worker('completed');
      w.pool.push(child('failed'));
      owed.push({ text: 'child failed', meta: { execution_id: 'restart:task_agent_child', status: 'failed' } });
    },
    owedResults: async () => [...owed],
    deliverCompletion: (_sessionId, _text, meta) => {
      delivered.push(meta.execution_id);
      return true;
    },
  });
  assert.equal(await second.api.recover(), 1);
  await pump(second.delivery);
  assert.deepEqual(delivered, ['restart:task_agent_child']);
  assert.deepEqual(w.ended(), [], 'nothing while the child result is owed');
  assert.equal((await w.watchIds()).length, 1);
  // A turn takes it and answers; no record proves the child the chain's, so
  // that turn never becomes the report — it only held it.
  owed.length = 0;
  await wokenTurn(w, second, 'CHILD ANSWER', { reports: ['restart:task_agent_child'] });
  await waitFor(second.delivery, () => w.ended().length);
  await pump(second.delivery);
  assert.deepEqual(
    w.ended().map((message) => message.meta.routine.status),
    ['completed']
  );
  assert.equal(finalAnswer(w), FINAL, "the chain's proven answer");
  assert.equal(anyReportHas(w, 'CHILD ANSWER'), false);
  assert.deepEqual(await w.watchIds(), []);
});

test("a child spawned by a user task in the chain's reused agent session is never the chain's", async (t) => {
  const w = world(t);
  const p = w.boot();
  const request = await sentRequest(w, p);
  // The bot's request starts task A in the worker session; A answers.
  w.task().messages.push(...turnRows(request.options.id, INTERIM, { spawns: ['task_agent_1'] }));
  w.pool.push(worker('running'));
  w.agentTasks.push({ taskId: 'task_agent_1', sessionId: 'sess_agent_worker', running: true });
  request.options.onSettled({ status: 'done', result: { content: INTERIM } });
  await pump(p.delivery);
  // The user sends task B to that worker; B spawns child C, still running.
  w.agentTasks[0].running = false;
  w.agentTasks.push({ taskId: 'task_agent_b', sessionId: 'sess_agent_worker', running: false });
  const c = (status) => ({ ...child(status), sessionId: 'sess_agent_c', taskId: 'task_agent_c' });
  w.pool[0] = worker('completed', { taskId: 'task_agent_b' });
  w.pool.push(c('running'));
  w.task().messages.push(
    ...turnRows('it_wake_1', FINAL, {
      source: 'task-notification',
      prompt: notificationPrompt(['task_agent_1']),
      consumed: ['task_agent_1'],
    }),
    ...turnRows('desktop-submit-1', 'B went to the worker.', { spawns: ['task_agent_b'] })
  );
  p.emit();
  await pump(p.delivery);
  assert.deepEqual(w.ended(), [], 'a child under the chain agent’s session may be the chain’s: it waits');
  // C's result reaches the Lead (a restart failure) and wakes a turn.
  w.pool[1] = c('failed');
  await wokenTurn(w, p, 'C ANSWER', { reports: ['restart:task_agent_c'] });
  await waitFor(p.delivery, () => w.ended().length);
  await pump(p.delivery);
  assert.equal(w.ended().length, 1);
  assert.equal(finalAnswer(w), FINAL, "the chain's own answer");
  assert.equal(anyReportHas(w, 'C ANSWER'), false);
  const closure = chainClosure(TASK, ['task_agent_1'], { pool: w.pool, agentTasks: w.agentTasks });
  assert.deepEqual([...closure.taskIds], ['task_agent_1'], 'C is not owned');
  assert.equal(closure.sessions.has('sess_agent_c'), true, 'C only holds the report');
});

test("a task the user sends to the chain's agent is never the chain's: its woken turn never answers the report", async (t) => {
  const w = world(t);
  const p = w.boot();
  const request = await sentRequest(w, p);
  // The bot's request starts task A in the worker session.
  w.task().messages.push(...turnRows(request.options.id, INTERIM, { spawns: ['task_agent_1'] }));
  w.pool.push(worker('running'));
  w.agentTasks.push({ taskId: 'task_agent_1', sessionId: 'sess_agent_worker', running: true });
  request.options.onSettled({ status: 'done', result: { content: INTERIM } });
  await pump(p.delivery);
  // A finishes and its woken turn answers; meanwhile the user's own turn sent
  // task B to that same worker session, which now runs B.
  w.agentTasks[0].running = false;
  w.agentTasks.push({ taskId: 'task_agent_b', sessionId: 'sess_agent_worker', running: true });
  w.pool[0] = worker('running', { taskId: 'task_agent_b' });
  w.task().messages.push(
    ...turnRows('it_wake_1', FINAL, {
      source: 'task-notification',
      prompt: notificationPrompt(['task_agent_1']),
      consumed: ['task_agent_1'],
    }),
    { role: 'user', content: 'ask the worker about B', meta: { transcript: { checkpointId: 'desktop-submit-1' } } },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_b', name: 'agent', arguments: { type: 'send', tag: 'worker' } }],
    },
    { role: 'tool', toolCallId: 'call_b', content: 'sent', agentTaskIds: ['task_agent_b'] },
    ...turnRows('desktop-submit-1', 'B is with the worker.').slice(-1)
  );
  p.emit();
  await pump(p.delivery);
  assert.deepEqual(w.ended(), [], 'work running in the chain agent’s session may be the chain’s: it waits');
  // B finishes; its result wakes a turn of the user's.
  w.agentTasks[1].running = false;
  w.pool[0] = worker('completed', { taskId: 'task_agent_b' });
  await wokenTurn(w, p, 'USER B ANSWER', { reports: ['task_agent_b'] });
  await waitFor(p.delivery, () => w.ended().length);
  await pump(p.delivery);
  assert.equal(w.ended().length, 1);
  assert.equal(finalAnswer(w), FINAL, "the chain's own answer");
  assert.equal(anyReportHas(w, 'USER B ANSWER'), false);
  assert.deepEqual(
    [...chainClosure(TASK, ['task_agent_1'], { pool: w.pool, agentTasks: w.agentTasks }).taskIds],
    ['task_agent_1'],
    'B ran in the chain agent’s session, but no chain turn started it'
  );
});

test("after a restart, owed results of the user's agents are delivered but neither hold nor fail the chain's report", async (t) => {
  for (const mode of ['refused', 'throws']) {
    const w = await heldAcrossRestart(t);
    // Before the stop the chain's agent finished and its woken turn answered;
    // the restart killed only the user's own agent, whose failure is owed.
    w.pool[0] = worker('completed');
    w.task().messages.push(
      ...turnRows('it_wake_1', FINAL, {
        source: 'task-notification',
        prompt: notificationPrompt(['task_agent_1']),
        consumed: ['task_agent_1'],
      }),
      ...turnRows('desktop-submit-1', 'mine', { spawns: ['task_agent_user'] })
    );
    w.pool.push(userAgent('failed'));
    const delivered = [];
    const second = w.boot({
      owedResults: async () => [
        { text: 'user agent failed', meta: { execution_id: 'restart:task_agent_user', status: 'failed' } },
      ],
      // No session runtime takes it: the delivery is refused, or throws.
      deliverCompletion: (_sessionId, _text, meta) => {
        delivered.push(meta.execution_id);
        if (mode === 'throws') throw new Error('bus closed');
        return false;
      },
    });
    assert.equal(await second.api.recover(), 1);
    await waitFor(second.delivery, () => w.ended().length);
    await pump(second.delivery);
    assert.deepEqual(delivered, ['restart:task_agent_user'], `${mode}: the user's result is still delivered`);
    assert.deepEqual(
      w.ended().map((message) => message.meta.routine.status),
      ['completed'],
      `${mode}: its failed delivery never fails the chain's report`
    );
    assert.match(w.ended()[0].content, new RegExp(FINAL));
    assert.deepEqual(await w.watchIds(), []);
  }
});

test('latestTurnOutcome follows only the turns its own agents woke', () => {
  const woken = (id, answer, taskIds) =>
    turnRows(id, answer, { source: 'task-notification', prompt: notificationPrompt(taskIds), consumed: taskIds });
  const brief = turnRows('a', 'interim', { spawns: ['task_agent_1'] });
  const final = { status: 'completed', text: 'final' };
  assert.deepEqual(latestTurnOutcome([...brief, ...woken('it_1', 'final', ['task_agent_1'])], 'a'), {
    id: 'it_1',
    outcome: final,
    at: 0,
    ambiguous: false,
  });
  assert.deepEqual(latestTurnOutcome(brief, 'a'), {
    id: 'a',
    outcome: { status: 'completed', text: 'interim' },
    at: 0,
    ambiguous: false,
  });
  // A typed turn, and a turn woken by another chain's agent, never join it;
  // the chain goes on past them, and agents its woken turns start join it.
  const rows = [
    ...brief,
    ...turnRows('desktop-submit-1', 'typed answer'),
    ...woken('it_2', 'other chain', ['task_agent_9']),
    ...turnRows('it_3', 'nested start', {
      source: 'task-notification',
      prompt: notificationPrompt(['task_agent_1']),
      consumed: ['restart:task_agent_1'],
      spawns: ['task_agent_2'],
    }),
    ...woken('it_4', 'final', ['task_agent_2']),
  ];
  assert.deepEqual(latestTurnOutcome(rows, 'a'), { id: 'it_4', outcome: final, at: 0, ambiguous: false });
  assert.deepEqual(latestTurnOutcome(rows, 'desktop-submit-1'), {
    id: 'desktop-submit-1',
    outcome: { status: 'completed', text: 'typed answer' },
    at: 0,
    ambiguous: false,
  });
  assert.equal(latestTurnOutcome(rows, 'missing'), null);
});

// ---- the chain follows structured provenance only ----

/** An `agent` call of `type` in a turn and its result, recording `agentTaskIds` when given. */
const agentCall = (callId, type, content, agentTaskIds) => [
  { role: 'assistant', content: '', toolCalls: [{ id: callId, name: 'agent', arguments: JSON.stringify({ type }) }] },
  { role: 'tool', toolCallId: callId, content, ...(agentTaskIds ? { agentTaskIds } : {}) },
];

test('an agent status or read result naming another task never joins the chain', () => {
  const brief = [
    ...turnRows('a', 'interim', { spawns: ['task_agent_1'] }).slice(0, -1),
    // The Lead looked at another chain's task: its output names it, it started nothing.
    ...agentCall('call_status', 'status', 'agent task: task_agent_9\nstatus: running', []),
    ...agentCall('call_read', 'read', 'agent task: task_agent_9\nstatus: completed'),
    ...turnRows('a', 'interim').slice(-1),
  ];
  const other = turnRows('it_9', 'the other task is done', {
    source: 'task-notification',
    prompt: notificationPrompt(['task_agent_9']),
    consumed: ['task_agent_9'],
  });
  const latest = latestTurnOutcome([...brief, ...other], 'a');
  assert.equal(latest.id, 'a', "another task's result is not this chain's answer");
  assert.equal(latest.ambiguous, false, 'a read/status call starts nothing, so nothing is missing');
});

test("an unrelated task's woken answer in the quiet period never replaces the report", async (t) => {
  const w = world(t, { settleMs: 400 });
  const p = w.boot();
  await p.api.create({ brief: 'Refactor' }, { callerSessionId: HOME, callerAgentId: 'bot1' });
  const [brief] = p.submits();
  w.task().messages.push(
    { role: 'user', content: 'go', meta: { transcript: { checkpointId: brief.options.id } } },
    ...agentCall('call_spawn', 'spawn', 'agent task: task_agent_1\nstatus: running', ['task_agent_1']),
    ...agentCall('call_status', 'status', 'agent task: task_agent_9\nstatus: running', []),
    { role: 'assistant', content: INTERIM, meta: { transcript: { completion: { status: 'done' } } } }
  );
  w.pool.push(worker('running'));
  brief.options.onSettled({ status: 'done', result: { content: INTERIM } });
  await pump(p.delivery);
  w.pool[0] = worker('completed');
  await wokenTurn(w, p, FINAL);
  // Another chain's agent finishes right after: its turn is not this one's.
  await wokenTurn(w, p, 'Unrelated: the other refactor landed.', { reports: ['task_agent_9'] });
  await waitFor(p.delivery, () => w.ended().length);
  await pump(p.delivery);
  assert.equal(w.ended().length, 1);
  assert.match(w.ended()[0].content, new RegExp(FINAL));
  assert.equal(w.ended()[0].content.includes('Unrelated'), false);
});

test('missing provenance never reports success: the report waits, its answer posted as progress', async (t) => {
  for (const missing of ['woken turn names no task', 'agent call recorded no task ids']) {
    const w = world(t);
    const p = w.boot();
    await p.api.create({ brief: 'Refactor' }, { callerSessionId: HOME, callerAgentId: 'bot1' });
    const [brief] = p.submits();
    if (missing === 'woken turn names no task') {
      w.task().messages.push(...turnRows(brief.options.id, INTERIM, { spawns: ['task_agent_1'] }));
    } else {
      w.task().messages.push(
        { role: 'user', content: 'go', meta: { transcript: { checkpointId: brief.options.id } } },
        ...agentCall('call_spawn', 'spawn', 'started'),
        { role: 'assistant', content: INTERIM, meta: { transcript: { completion: { status: 'done' } } } }
      );
    }
    brief.options.onSettled({ status: 'done', result: { content: INTERIM } });
    // Its agent's result woke a turn whose prompt carries no structured ids.
    p.state.busy = true;
    p.emit();
    w.task().messages.push(
      ...turnRows('it_wake_x', FINAL, {
        source: 'task-notification',
        prompt: 'something else entirely',
        ...(missing === 'woken turn names no task' ? { consumed: [null] } : {}),
      })
    );
    p.state.busy = false;
    p.emit();
    await pump(p.delivery);
    assert.deepEqual(w.ended(), [], `${missing}: nothing is reported as completed`);
    assert.equal((await w.watchIds()).length, 1, `${missing}: the watch is kept`);
    p.emit();
    await waitFor(p.delivery, () => w.progress().length);
    await pump(p.delivery);
    assert.deepEqual(w.progress().map(reportText), [INTERIM], `${missing}: the chain's answer, as progress`);
    assert.deepEqual(w.ended(), [], `${missing}: never completed`);
    assert.equal(w.wakes.length, 0, `${missing}: nobody is woken`);
    assert.equal((await w.watchIds()).length, 1);
  }
});

test('the agent tool records the jobs a tool call starts; a woken batch records what it delivers', async () => {
  const startJob = createJobStarter({ mgr: {}, notifyStatusChange: () => {}, notifySessionCompletion: null });
  const job = startJob('spawn', { tag: 'w1' }, async () => ({ content: 'ok' }), {
    callerSessionId: 'sess_lead_prov',
    toolCallId: 'call_prov_1',
  });
  assert.deepEqual(takeAgentTaskStarts('call_prov_1'), [job.taskId]);
  assert.deepEqual(takeAgentTaskStarts('call_prov_1'), [], 'taken once');
  startJob('spawn', { tag: 'w2' }, async () => null, { callerSessionId: 'sess_lead_prov' });
  assert.deepEqual(takeAgentTaskStarts(''), [], 'a job no tool call started is recorded under none');
  await job.promise;
  const options = turnOptionsForBatch(
    [
      { id: 'q1', text: 'a', mode: 'task-notification', execution: { id: 'task_agent_1', surface: 'agent' } },
      {
        id: 'q2',
        text: 'b',
        mode: 'pending-resume',
        resumeCompletionKeys: ['execution:restart:task_agent_2', 'body:abc'],
      },
    ],
    { commitSteeringQueueEntries: () => {}, releaseSteeringQueueEntries: () => {} }
  );
  assert.equal(options.promptSource, 'task-notification');
  assert.deepEqual(options.transcriptMeta.consumedExecutionIds, ['task_agent_1', 'restart:task_agent_2', null]);
  assert.equal(agentTaskIdOfExecution('restart:task_agent_2'), 'task_agent_2');
  assert.equal(agentTaskIdOfExecution('restart:sess_x:123'), null, 'a restart row with no task id names none');
});

// ---- a result steered into a running turn is consumed by that turn ----

/** The user message the real loop stores when agent task `taskId`'s
 *  completion (tagged as the notification bus tags it) is steered into a turn
 *  already running (loop/steering.mjs): no checkpoint of its own. */
function steeredCompletion(taskId) {
  const messages = [];
  const entry = markCompletionEntry(notificationPrompt([taskId]).replaceAll('&lt;', '<'), {
    executionId: taskId,
    meta: { type: 'agent_task_result', execution_surface: 'agent', execution_id: taskId, status: 'completed' },
  });
  const drain = createSteeringDrain({
    messages,
    opts: { drainSteering: () => [entry] },
    sessionId: '',
    onSkillPrompt: () => {},
  });
  assert.equal(drain('mid-turn'), true);
  return messages;
}

/** A turn the user typed that took `steered` rows mid-turn, then answered. */
function userTurnWithSteered(checkpointId, answer, steered) {
  const [prompt, ...rest] = turnRows(checkpointId, answer);
  return [prompt, ...steered, ...rest];
}

test("a chain's result steered into the user's running turn makes that turn's answer the report", () => {
  const steered = steeredCompletion('task_agent_1');
  assert.equal(steered.length, 1);
  assert.equal(steered[0].meta.transcript.checkpointId, undefined, 'a steered result has no checkpoint');
  const rows = [
    ...turnRows('a', 'interim', { spawns: ['task_agent_1'] }),
    ...userTurnWithSteered('desktop-submit-1', FINAL, steered),
  ];
  assert.deepEqual(latestTurnOutcome(rows, 'a'), {
    id: 'desktop-submit-1',
    outcome: { status: 'completed', text: FINAL },
    at: 0,
    ambiguous: false,
  });
  // A result of another chain's task steered into the user's turn never joins it.
  const other = [
    ...turnRows('a', 'interim', { spawns: ['task_agent_1'] }),
    ...userTurnWithSteered('desktop-submit-1', 'their answer', steeredCompletion('task_agent_9')),
  ];
  assert.equal(latestTurnOutcome(other, 'a').id, 'a');
  assert.equal(latestTurnOutcome(other, 'a').ambiguous, false);
  // A steered result naming no task is missing provenance.
  const unnamed = steeredCompletion('task_agent_1').map((message) => ({
    ...message,
    meta: { ...message.meta, execution: { surface: 'agent' } },
  }));
  const missing = [
    ...turnRows('a', 'interim', { spawns: ['task_agent_1'] }),
    ...userTurnWithSteered('desktop-submit-1', 'answer', unnamed),
  ];
  assert.equal(latestTurnOutcome(missing, 'a').ambiguous, true);
});

test('a result steered into a user turn running when the agent finished: one report, its answer, never the interim', async (t) => {
  const w = world(t);
  const p = w.boot();
  await p.api.create({ brief: 'Refactor' }, { callerSessionId: HOME, callerAgentId: 'bot1' });
  const [brief] = p.submits();
  w.task().messages.push(...turnRows(brief.options.id, INTERIM, { spawns: ['task_agent_1'] }));
  w.pool.push(worker('running'));
  brief.options.onSettled({ status: 'done', result: { content: INTERIM } });
  await pump(p.delivery);
  // The user's own turn runs when the agent finishes; its result is steered in.
  p.state.busy = true;
  p.emit();
  w.pool[0] = worker('completed');
  w.task().messages.push(...userTurnWithSteered('desktop-submit-1', FINAL, steeredCompletion('task_agent_1')));
  p.state.busy = false;
  p.emit();
  await waitFor(p.delivery, () => w.ended().length);
  await pump(p.delivery);
  assert.equal(w.ended().length, 1);
  assert.equal(w.ended()[0].meta.routine.status, 'completed');
  assert.match(w.ended()[0].content, new RegExp(FINAL));
  assert.equal(w.ended()[0].content.includes(INTERIM), false);
  assert.deepEqual(await w.watchIds(), []);
});

test('queue and bus paths: a completion delivered as a turn prompt records the task it consumed', () => {
  // Bus path: the notification bus tags the completion (markCompletionEntry)
  // and queues it; the queue drain starts a woken turn from it.
  const entry = markCompletionEntry('done', {
    executionId: 'task_agent_1',
    meta: { type: 'agent_task_result', execution_surface: 'agent', execution_id: 'task_agent_1', status: 'completed' },
  });
  const options = turnOptionsForBatch([entry], {
    commitSteeringQueueEntries: () => {},
    releaseSteeringQueueEntries: () => {},
  });
  assert.deepEqual(options.transcriptMeta.consumedExecutionIds, ['task_agent_1']);
  const rows = [
    ...turnRows('a', 'interim', { spawns: ['task_agent_1'] }),
    ...turnRows('it_1', FINAL, { source: options.promptSource, consumed: options.transcriptMeta.consumedExecutionIds }),
  ];
  assert.equal(latestTurnOutcome(rows, 'a').id, 'it_1');
  // A queue-fed turn that recorded only its single execution.
  const single = [
    ...turnRows('a', 'interim', { spawns: ['task_agent_1'] }),
    {
      role: 'user',
      content: 'done',
      meta: { source: 'task-notification', execution: { id: 'task_agent_1' }, transcript: { checkpointId: 'it_2' } },
    },
    ...turnRows('it_2', FINAL).slice(-1),
  ];
  assert.equal(latestTurnOutcome(single, 'a').id, 'it_2');
});

// ---- a queued (not yet running) agent is pending work ----

test('an agent task still queued for admission keeps the task session pending', async () => {
  const lead = 'sess_task_queued_1';
  // The agent tool registers its job before resource admission: no turn in
  // flight yet, and its pool row would read `unknown`.
  const task = registerBackgroundTask({ surface: 'agent', label: 'worker', context: { callerSessionId: lead } });
  assert.equal(await taskSessionPendingWork(lead), true, 'a queued agent is pending work');
  completeBackgroundTask(task.taskId, { status: 'completed', result: { content: 'ok' }, notify: false });
  assert.equal(await taskSessionPendingWork(lead), false);
});

test('a queued agent owned by an Agent session under the Lead counts, at any depth', () => {
  const pool = [
    { sessionId: 'sess_agent_child', ownerSessionId: TASK, parentSessionId: TASK, status: 'completed' },
    { sessionId: 'sess_agent_grand', ownerSessionId: TASK, parentSessionId: 'sess_agent_child', status: 'unknown' },
    { sessionId: 'sess_agent_other', ownerSessionId: 'sess_task_other', status: 'completed' },
  ];
  assert.equal(pendingWorkOf(TASK, { pool }), false);
  assert.equal(pendingWorkOf(TASK, { pool, agentTaskOwners: new Set(['sess_agent_child']) }), true);
  assert.equal(pendingWorkOf(TASK, { pool, agentTaskOwners: new Set(['sess_agent_grand']) }), true);
  assert.equal(pendingWorkOf(TASK, { pool, agentTaskOwners: new Set(['sess_agent_other']) }), false);
});

test('a Lead whose only agent is still queued does not report its interim answer', async (t) => {
  const w = world(t);
  const owners = new Set();
  const p = w.boot({ pendingWork: async (id) => pendingWorkOf(id, { pool: w.pool, agentTaskOwners: owners }) });
  await p.api.create({ brief: 'Refactor' }, { callerSessionId: HOME, callerAgentId: 'bot1' });
  const [brief] = p.submits();
  w.task().messages.push(...turnRows(brief.options.id, INTERIM, { spawns: ['task_agent_1'] }));
  // Spawned but waiting for a slot: its row reads `unknown`, its job is queued.
  w.pool.push(worker('unknown'));
  owners.add(TASK);
  brief.options.onSettled({ status: 'done', result: { content: INTERIM } });
  await pump(p.delivery);
  assert.deepEqual(w.ended(), []);
  owners.delete(TASK);
  w.pool[0] = worker('completed');
  await wokenTurn(w, p, FINAL);
  await waitFor(p.delivery, () => w.ended().length);
  assert.equal(w.ended().length, 1);
  assert.match(w.ended()[0].content, new RegExp(FINAL));
});

// ---- after a restart the task session is woken to take its agents' results ----

const RESTART_FAILURE =
  '<task-notification>\n<task-id>task_agent_1</task-id>\n<status>failed</status>\n</task-notification>';

/** First process: the brief ended with an agent running; the daemon stops. */
async function heldAcrossRestart(t) {
  const w = world(t);
  const first = w.boot();
  await first.api.create({ brief: 'Refactor', title: 'Parser' }, { callerSessionId: HOME, callerAgentId: 'bot1' });
  const [brief] = first.submits();
  w.task().messages.push(...turnRows(brief.options.id, INTERIM, { spawns: ['task_agent_1'] }));
  w.pool.push(worker('running'));
  brief.options.onSettled({ status: 'done', result: { content: INTERIM } });
  await pump(first.delivery);
  assert.deepEqual(w.ended(), []);
  return w;
}

test('a restart that killed the agents wakes the task session to take their failure results, then reports', async (t) => {
  const w = await heldAcrossRestart(t);
  const owed = [];
  const delivered = [];
  let second = null;
  second = w.boot({
    // The restart settles the killed agent: its row fails, its result is queued.
    settleAgentResults: async () => {
      w.pool[0] = worker('failed', { failureReason: 'process-restart' });
      owed.push({ text: RESTART_FAILURE, meta: { execution_id: 'restart:task_agent_1', status: 'failed' } });
    },
    owedResults: async () => [...owed],
    // The notification bus hands it to the session, whose turn takes it.
    deliverCompletion: (sessionId, text, meta) => {
      delivered.push([sessionId, text, meta.execution_id]);
      owed.length = 0;
      setImmediate(() => void wokenTurn(w, second, FINAL));
      return true;
    },
  });
  assert.equal(await second.api.recover(), 1);
  await waitFor(second.delivery, () => w.ended().length && w.wakes.length);
  assert.deepEqual(delivered, [[TASK, RESTART_FAILURE, 'restart:task_agent_1']]);
  assert.equal(w.ended().length, 1);
  assert.match(w.ended()[0].content, new RegExp(FINAL));
  assert.deepEqual(await w.watchIds(), []);
});

test('a restarted task session that cannot take its results reports the failure once instead of waiting', async (t) => {
  for (const mode of ['undeliverable', 'unloadable']) {
    const w = await heldAcrossRestart(t);
    const owed = [{ text: RESTART_FAILURE, meta: { execution_id: 'restart:task_agent_1', status: 'failed' } }];
    const second = w.boot({
      owedResults: async () => [...owed],
      deliverCompletion: () => false,
      ...(mode === 'unloadable'
        ? {
            materialize: () => {
              throw new Error('session record unreadable');
            },
          }
        : {}),
    });
    await second.api.recover();
    await waitFor(second.delivery, () => w.ended().length);
    assert.deepEqual(
      w.ended().map((message) => message.meta.routine.status),
      ['failed'],
      mode
    );
    assert.match(w.ended()[0].content, /could not continue after the app restarted/);
    assert.deepEqual(await w.watchIds(), [], `${mode}: nothing is left waiting`);
    second.emit();
    await pump(second.delivery);
    assert.equal(w.ended().length, 1, `${mode}: reported once`);
  }
});

test('a restarted task session that never takes its delivered results is given up after three deliveries', async (t) => {
  const w = await heldAcrossRestart(t);
  const owed = [{ text: RESTART_FAILURE, meta: { execution_id: 'restart:task_agent_1', status: 'failed' } }];
  const delivered = [];
  // The bus accepts every delivery, but no turn ever takes the result.
  const second = w.boot({
    pollMs: 20,
    owedResults: async () => [...owed],
    deliverCompletion: (_sessionId, _text, meta) => {
      delivered.push(meta.execution_id);
      return true;
    },
  });
  await second.api.recover();
  await waitFor(second.delivery, () => w.ended().length);
  assert.deepEqual(delivered, ['restart:task_agent_1', 'restart:task_agent_1', 'restart:task_agent_1']);
  assert.deepEqual(
    w.ended().map((message) => message.meta.routine.status),
    ['failed']
  );
  assert.match(w.ended()[0].content, /could not continue after the app restarted/);
  assert.deepEqual(await w.watchIds(), []);
  await new Promise((resolve) => setTimeout(resolve, 60));
  second.emit();
  await pump(second.delivery);
  assert.equal(delivered.length, 3, 'no delivery after giving up');
  assert.equal(w.ended().length, 1, 'reported once');
});

// ---- a woken turn as the runtime stores it (QA B-20/B-21/B-22) ----

/** The queue entry an agent's result becomes on the task session's surface
 *  (agent-job-feed/execution-delivery.mjs). */
function surfaceCompletion(executionId, status = 'completed') {
  const taskId = agentTaskIdOfExecution(executionId);
  const text = `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n</task-notification>`;
  const { execution } = markCompletionEntry(text, {
    executionId,
    meta: { type: 'agent_task_result', execution_surface: 'agent', execution_id: executionId, status },
  });
  return {
    id: `q_${executionId}`,
    text,
    mode: 'task-notification',
    execution,
    resumeCompletionKeys: [executionResumeKey(text, executionId)],
    suppressDisplay: true,
  };
}

/** Turn `checkpointId` that the queue drain (session-flow/drain.mjs) starts
 *  from `entries`, stored as the runtime stores it: its prompt carries the
 *  transcript metadata askSession persists (createAskTranscriptMeta). */
function storedWokenTurn(checkpointId, answer, entries) {
  const options = turnOptionsForBatch(entries, {
    commitSteeringQueueEntries: () => {},
    releaseSteeringQueueEntries: () => {},
  });
  const [, ...answerRows] = turnRows(checkpointId, answer);
  const transcript = createAskTranscriptMeta({ ...options.transcriptMeta, checkpointId }).user;
  return [
    { role: 'user', content: options.displayText, meta: { source: options.promptSource, transcript } },
    ...answerRows,
  ];
}

test('the woken turn the runtime stores names what it consumed: its answer is the final report, never progress', async (t) => {
  const w = world(t);
  const p = w.boot();
  await p.api.create({ brief: 'Refactor' }, { callerSessionId: HOME, callerAgentId: 'bot1' });
  const [brief] = p.submits();
  w.task().messages.push(...turnRows(brief.options.id, INTERIM, { spawns: ['task_agent_1'] }));
  w.pool.push(worker('running'));
  brief.options.onSettled({ status: 'done', result: { content: INTERIM } });
  await pump(p.delivery);
  assert.deepEqual(w.ended(), []);
  // The agent finishes; its result wakes the Lead, which answers "Done.".
  w.pool[0] = worker('completed');
  p.state.busy = true;
  p.emit();
  const woken = storedWokenTurn('it_wake_1', 'Done.', [surfaceCompletion('task_agent_1')]);
  assert.deepEqual(woken[0].meta.transcript.consumedExecutionIds, ['task_agent_1']);
  w.task().messages.push(...woken);
  p.state.busy = false;
  p.emit();
  await waitFor(p.delivery, () => w.ended().length);
  // Nothing more is said later.
  await new Promise((resolve) => setTimeout(resolve, 80));
  p.emit();
  await pump(p.delivery);
  assert.deepEqual(
    w.ended().map((message) => message.meta.routine.status),
    ['completed']
  );
  assert.match(w.ended()[0].content, /Done\./);
  assert.deepEqual(w.progress().map(reportText), [INTERIM], 'only the answer given while the agent ran');
  assert.deepEqual(await w.watchIds(), []);
});

test("after a graceful quit the Lead takes its killed agent's failure, and its answer is the one report", async (t) => {
  const w = await heldAcrossRestart(t);
  const owed = [];
  let second = null;
  second = w.boot({
    // The quit left the agent's row a restart failure; its result is queued.
    settleAgentResults: async () => {
      w.pool[0] = worker('failed', { failureReason: 'process-restart' });
      owed.push({ text: RESTART_FAILURE, meta: { execution_id: 'restart:task_agent_1', status: 'failed' } });
    },
    owedResults: async () => [...owed],
    // The bus hands it to the session's surface; the drain wakes the Lead.
    deliverCompletion: (_sessionId, _text, meta) => {
      owed.length = 0;
      setImmediate(() => {
        second.state.busy = true;
        second.emit();
        w.task().messages.push(
          ...storedWokenTurn('it_restart', FINAL, [surfaceCompletion(meta.execution_id, 'failed')])
        );
        second.state.busy = false;
        second.emit();
      });
      return true;
    },
  });
  assert.equal(await second.api.recover(), 1);
  await waitFor(second.delivery, () => w.ended().length);
  await pump(second.delivery);
  assert.deepEqual(
    w.ended().map((message) => message.meta.routine.status),
    ['completed']
  );
  assert.match(w.ended()[0].content, new RegExp(FINAL));
  assert.equal(w.ended()[0].content.includes(INTERIM), false);
  assert.deepEqual(await w.watchIds(), []);
});

// ---- #6: the relay turn is done only when it settles done ----

test('a wake refused every time is given up after its bound, with the note', async (t) => {
  const w = world(t, {
    wake: () => {
      throw new Error('the session is closing');
    },
  });
  const p = w.boot();
  await p.delivery.enqueueTask('bot1', {
    runId: 'r1_end',
    taskSessionId: TASK,
    title: 'Parser',
    status: 'completed',
    text: FINAL,
  });
  await waitFor(p.delivery, () => w.home.messages.some((message) => message.meta?.routine?.relayFailed));
  for (let i = 0; i < 3; i += 1) await p.delivery.drain(HOME);
  assert.equal(w.wakes.length, 3, 'three refusals, then no more tries');
  assert.deepEqual(await owed(w.file), []);
  assert.match(w.logs.join('\n'), /could not start \(3 refusals\)/);
});

/** A wake surface whose relay turns settle as `outcomes` says, in order. */
function relayWorld(t, outcomes) {
  const settles = [];
  const w = world(t, {
    wake: () => {
      const status = outcomes.shift() ?? 'done';
      settles.push(status);
      return { settled: Promise.resolve(status) };
    },
  });
  return { w, settles };
}

const owed = async (file) => {
  const { owed: list, batches } = await createRoutineResultQueue(file).wakes(HOME);
  return [...list, ...batches.map((batch) => batch.id)];
};

test('a relay turn that fails is owed again under a fresh id; one that finishes retires it', async (t) => {
  const { w, settles } = relayWorld(t, ['failed', 'cancelled', 'done']);
  const p = w.boot();
  await p.delivery.enqueueTask('bot1', {
    runId: 'r1_end',
    taskSessionId: TASK,
    title: 'Parser',
    status: 'completed',
    text: FINAL,
  });
  await waitFor(p.delivery, async () => settles.length === 3 && !(await owed(w.file)).length);
  assert.deepEqual(settles, ['failed', 'cancelled', 'done']);
  assert.equal(w.wakes.length, 3);
  assert.equal(new Set(w.wakes.map((wake) => wake.options.id)).size, 3, 'each try is a new submission');
  for (const wake of w.wakes) assert.match(wake.prompt, new RegExp(FINAL));
  assert.deepEqual(await owed(w.file), [], 'retired once a relay turn finished');
  assert.equal(w.home.messages.filter((message) => message.meta?.routine?.kind === 'task').length, 1, 'one row');
});

test('a relay turn that never finishes is tried four times, then left as a visible note', async (t) => {
  const { w } = relayWorld(t, ['failed', 'failed', 'failed', 'failed', 'failed', 'failed']);
  const p = w.boot();
  await p.delivery.enqueueTask('bot1', {
    runId: 'r1_end',
    taskSessionId: TASK,
    title: 'Parser',
    status: 'completed',
    text: FINAL,
  });
  await waitFor(p.delivery, () => w.home.messages.some((message) => message.meta?.routine?.relayFailed));
  await pump(p.delivery);
  assert.equal(w.wakes.length, 4, 'one try and three retries, no more');
  assert.deepEqual(await owed(w.file), []);
  const note = w.home.messages.at(-1);
  assert.equal(note.meta.routine.relayFailed, 1);
  assert.match(note.content, /did not finish after 4 tries/);
  const [, item] = restoreTranscriptItems(w.home.messages, { sessionId: HOME });
  assert.equal(item.tone, 'warn');
  assert.match(item.text, /not relayed/);
  await pump(p.delivery);
  assert.equal(w.wakes.length, 4);
  assert.equal(w.home.messages.length, 2, 'the note posts once');
});

test('a relay turn cut off by a restart is woken again; one that finished before it is not', async (t) => {
  for (const finished of [false, true]) {
    // The first process's relay turn never settles: the daemon stops under it.
    let hang = true;
    const w = world(t, { wake: () => ({ settled: hang ? new Promise(() => {}) : Promise.resolve('done') }) });
    const first = w.boot();
    await first.delivery.enqueueTask('bot1', {
      runId: 'r1_end',
      taskSessionId: TASK,
      title: 'P',
      status: 'completed',
      text: 'one',
    });
    await waitFor(first.delivery, () => w.wakes.length);
    assert.equal(w.wakes.length, 1);
    const [batchId] = await owed(w.file);
    assert.equal(batchId, w.wakes[0].options.id, 'owed until its relay turn settles');
    w.home.messages.push(
      ...(finished
        ? turnRows(batchId, 'relayed')
        : [{ role: 'user', content: 'relay', meta: { transcript: { checkpointId: batchId } } }])
    );
    hang = false;
    const second = w.boot();
    await second.delivery.recover();
    await waitFor(second.delivery, async () => !(await owed(w.file)).length);
    await pump(second.delivery);
    assert.equal(w.wakes.length, finished ? 1 : 2, finished ? 'never relayed twice' : 'the cut-off relay runs again');
    if (!finished) assert.notEqual(w.wakes[1].options.id, batchId, 'under a fresh submission id');
    assert.deepEqual(await owed(w.file), []);
  }
});

// ---- the stuck queue: rows for an agent that can have no chat ----

test("a workflow agent's rows for its missing home are dropped; a bot's keep waiting", async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'routine-results.json');
  const logs = [];
  const delivery = createAgentHomeDelivery({
    loadSession: () => null,
    saveSession: async () => {},
    turnInFlight: () => false,
    queue: createRoutineResultQueue(file),
    live: () => null,
    retryLater: () => {},
    homeAgent: (agentId) => (agentId === 'reviewer' ? 'none' : agentId === 'helper' ? 'bot' : 'unknown'),
    log: (line) => logs.push(line),
  });
  const queue = createRoutineResultQueue(file);
  const held = (n) => ({ id: `held_${n}`, status: 'pending', agentId: 'reviewer', kind: 'outbound', tool: 'github' });
  // Left by an earlier process: the next start self-heals the file.
  for (const n of [1, 2, 3])
    await queue.add('sess_home_reviewer', { runId: `held_${n}_pending`, kind: 'held-request', held: held(n), at: 1 });
  await queue.add('sess_home_helper', {
    runId: 'h1',
    kind: 'held-request',
    held: { ...held(9), agentId: 'helper' },
    at: 1,
  });
  await queue.add('sess_home_ghost', {
    runId: 'g1',
    kind: 'held-request',
    held: { ...held(8), agentId: 'ghost' },
    at: 1,
  });
  for (const homeId of await delivery.recover()) await delivery.drain(homeId);
  assert.deepEqual(await queue.items('sess_home_reviewer'), []);
  assert.match(logs.join('\n'), /3 result\(s\) for sess_home_reviewer are dropped: reviewer is not a bot/);
  assert.equal((await queue.items('sess_home_helper')).length, 1, "a bot's rows wait for its chat");
  assert.equal((await queue.items('sess_home_ghost')).length, 1, 'an unknown agent proves nothing');
  // A new row for it is dropped by its first drain, never left waiting.
  await delivery.drain(await delivery.enqueueHeld('reviewer', held(4)));
  assert.deepEqual(await queue.items('sess_home_reviewer'), []);
  assert.deepEqual((await queue.pendingHomes()).sort(), ['sess_home_ghost', 'sess_home_helper']);
});

test('only a definition read successfully proves an agent can have no chat', (t) => {
  const dataDir = tempDir(t);
  const agent = (id, text) => {
    mkdirSync(join(dataDir, 'agents', id), { recursive: true });
    if (text !== null) writeFileSync(join(dataDir, 'agents', id, 'AGENT.md'), text);
  };
  const of = (id, read) => readHomeAgent({ dataDir, shippedRoot: STANDALONE_ROOT, id, ...(read ? { read } : {}) });
  assert.equal(of('reviewer'), 'none', 'the shipped Reviewer is a workflow role');
  agent('flow', '---\nname: Flow\nkind: agent\n---\nA workflow agent.');
  assert.equal(of('flow'), 'none');
  agent('marked', '---\nname: Marked\nkind: bot\n---\nA bot.');
  assert.equal(of('marked'), 'bot');
  // A real bot whose definition cannot be read right now: never 'none'.
  agent('helper', null);
  mkdirSync(join(dataDir, 'agents', 'helper', 'AGENT.md'));
  assert.equal(of('helper'), 'unknown', 'an unreadable AGENT.md (EISDIR) proves nothing');
  const eio = () => {
    throw Object.assign(new Error('i/o error'), { code: 'EIO' });
  };
  assert.equal(of('flow', eio), 'unknown', 'a read fault proves nothing');
  // An unmarked agent of the user's without bot evidence is not proven either way.
  agent('plain', '---\nname: Plain\n---\nSomething.');
  assert.equal(of('plain'), 'unknown');
  assert.equal(of('ghost'), 'unknown', 'no definition at all proves nothing');
});

test("a bot whose definition is unreadable keeps its rows, logged once; a workflow agent's are dropped", async (t) => {
  const dataDir = tempDir(t);
  mkdirSync(join(dataDir, 'agents', 'helper', 'AGENT.md'), { recursive: true });
  const file = join(dataDir, 'routine-results.json');
  const logs = [];
  const delivery = createAgentHomeDelivery({
    loadSession: () => null,
    saveSession: async () => {},
    turnInFlight: () => false,
    queue: createRoutineResultQueue(file),
    live: () => null,
    retryLater: () => {},
    homeAgent: (id) => readHomeAgent({ dataDir, shippedRoot: STANDALONE_ROOT, id }),
    log: (line) => logs.push(line),
  });
  const queue = createRoutineResultQueue(file);
  await queue.add('sess_home_helper', {
    runId: 'h1',
    kind: 'held-request',
    held: { id: 'h1', agentId: 'helper' },
    at: 1,
  });
  await queue.add('sess_home_reviewer', {
    runId: 'r1',
    kind: 'held-request',
    held: { id: 'r1', agentId: 'reviewer' },
    at: 1,
  });
  for (let i = 0; i < 3; i += 1) for (const homeId of await delivery.recover()) await delivery.drain(homeId);
  assert.equal((await queue.items('sess_home_helper')).length, 1, "the bot's result is kept");
  assert.deepEqual(await queue.items('sess_home_reviewer'), []);
  assert.equal(logs.filter((line) => /wait for the home thread sess_home_helper/.test(line)).length, 1, 'logged once');
});

// ---- a send that reports nothing says why ----

test('a send or create that reports nothing back names its reason', async (t) => {
  const w = world(t);
  const p = w.boot();
  const execute = createSessionControl({
    getSessionService: () => ({ submitSession: async () => ({ accepted: true }) }),
    agentTasks: p.api,
  });
  // Not a bot conversation.
  const plain = await execute(
    { action: 'send', session_id: 'sess_user_1', prompt: 'x' },
    { callerSessionId: 'sess_coding_1' }
  );
  assert.equal(plain.reportsBack, false);
  assert.match(plain.reportsBackReason, /only a bot conversation/);
  // A task session created with notify: false.
  await p.api.create({ brief: 'quiet', notify: false }, { callerSessionId: HOME, callerAgentId: 'bot1' });
  const quiet = await execute(
    { action: 'send', session_id: TASK, prompt: 'more' },
    { callerSessionId: HOME, callerAgentId: 'bot1' }
  );
  assert.equal(quiet.reportsBack, false);
  assert.match(quiet.reportsBackReason, /notify: false/);
  // The chat waits on as many reports as it can track.
  const queue = createRoutineResultQueue(w.file);
  for (let i = 0; i < 200; i += 1) {
    await queue.watch({ runId: `old_${i}`, agentId: 'bot1', homeSessionId: HOME, taskSessionId: `sess_old_${i}` });
  }
  const capped = await execute(
    { action: 'send', session_id: 'sess_user_2', prompt: 'next' },
    { callerSessionId: HOME, callerAgentId: 'bot1' }
  );
  assert.equal(capped.reportsBack, false);
  assert.match(capped.reportsBackReason, /as many unreported session results as it can track/);
  const created = await p.api.create({ brief: 'one more' }, { callerSessionId: HOME, callerAgentId: 'bot1' });
  assert.equal(created.reportsBack, false);
  assert.match(created.reportsBackReason, /as many unreported session results/);
});

// ---- #3 regression: a damaged queue file never costs a report ----

test('a NUL-filled routine-results.json still reports a send back and delivers it', async (t) => {
  const w = world(t);
  writeFileSync(w.file, Buffer.alloc(2048));
  const p = w.boot();
  const execute = createSessionControl({ getSessionService: () => ({}), agentTasks: p.api });
  const sent = await execute(
    { action: 'send', session_id: TASK, prompt: 'run the tests' },
    { callerSessionId: HOME, callerAgentId: 'bot1' }
  );
  assert.equal(sent.reportsBack, true);
  assert.equal(sent.reportsBackReason, undefined);
  const [submit] = p.submits();
  submit.options.onSettled({ status: 'done', result: { content: 'tests pass' } });
  await waitFor(p.delivery, () => w.ended().length && w.wakes.length);
  assert.equal(w.ended().length, 1);
  assert.match(w.ended()[0].content, /tests pass/);
  assert.equal(w.wakes.length, 1);
  assert.equal(typeof JSON.parse(readFileSync(w.file, 'utf8')), 'object', 'the file is valid JSON again');
});
