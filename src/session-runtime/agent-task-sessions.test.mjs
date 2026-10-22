import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAgentTaskSessions, resolveTaskProject, submissionOutcome } from './agent-task-sessions.mjs';
import { agentTaskMessage, routineResultNotice } from '../runtime/agent/orchestrator/session/routine-result.mjs';
import { createAgentHomeDelivery, createRoutineResultQueue } from './agent-home-delivery.mjs';
import { createSessionControl } from '../standalone/daemon-session-control.mjs';
import { isUserTurn } from '../standalone/session-service/session-calls/session-turns.mjs';
import { createWorkspaceToolHandlers } from './internal-tool-executor/workspace-tools.mjs';
import { sessionOptions } from './session-create/session-options.mjs';
import { sessionOriginFields } from '../runtime/agent/orchestrator/session/manager/session-record.mjs';
import { restoreTranscriptItems } from '../runtime/agent/orchestrator/session/transcript-restore/restore.mjs';
import {
  roomMemberSessionId,
  roomRowMessage,
  roomSessionId,
} from '../runtime/agent/orchestrator/session/agent-room.mjs';

const settle = () => new Promise((resolve) => setImmediate(resolve));

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-task-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return realpathSync(dir);
}

/** A session service over one fake task-session runtime. */
function fakeService() {
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
      return { sessionId: 'sess_task_1' };
    },
    configureSession: async (params, ctx) => {
      calls.push(['configure', params, ctx]);
      return { value: {} };
    },
    materializeSession: async () => runtime,
    submitSession: async (params) => {
      calls.push(['submit', params]);
      return { accepted: true };
    },
  };
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  return { service, calls, state, listeners, emit };
}

function tasks(h, overrides = {}) {
  const delivered = [];
  const stored = new Map();
  const watched = [];
  const api = createAgentTaskSessions({
    getSessionService: () => h.service,
    deliver: async (agentId, report) => delivered.push([agentId, report]),
    watches: { add: async (watch) => watched.push(watch), list: async () => [], remove: async () => {} },
    queuedSubmissionIds: async () => [],
    loadSession: async (id) => stored.get(id) || null,
    listProjects: async () => [{ name: 'mixdog', alias: null, path: '/repo/mixdog' }],
    newTaskDefault: async () => 'branch',
    modelRoute: async (ref) => ({ provider: 'test', model: ref }),
    leadRoute: async () => ({ provider: 'lead-provider', model: 'lead-model' }),
    lastUsedRoute: async () => null,
    // A task turn's end is its final answer at once here (no agent work, no quiet period).
    pendingWork: async () => false,
    settleMs: 0,
    log: () => {},
    ...overrides,
  });
  return { api, delivered, stored, watched };
}

const submitted = (h) => h.calls.filter(([name]) => name === 'submit').map(([, params]) => params);

test('create is allowed from agent homes and refused from workers, coding sessions and routine runs', async () => {
  const seen = [];
  const handlerFor = (session) =>
    createWorkspaceToolHandlers({
      rt: { session, config: {} },
      executeSessionControl: async (args, context) => {
        seen.push([args.action, context.callerAgentId]);
        return { ok: true };
      },
    }).session;
  const run = (session, args = { action: 'create', brief: 'do it' }) =>
    handlerFor(session)(args, { callerCtx: { callerSessionId: session.id }, callerCwd: '/home' });
  await run({ id: 'sess_home_lead', owner: 'cli', agent: 'lead', sourceType: 'lead' });
  await run({ id: 'sess_home_reviewer', owner: 'cli', agent: 'reviewer', sourceType: 'lead' });
  assert.deepEqual(seen, [
    ['create', 'lead'],
    ['create', 'reviewer'],
  ]);
  const refused = [
    { id: 'sess_worker', owner: 'agent', agent: 'worker', parentSessionId: 'sess_home_lead' },
    { id: 'sess_coding', owner: 'cli', agent: 'lead', sourceType: 'lead' },
    { id: 'sess_run', owner: 'user', sourceType: 'schedule', sourceName: 'daily', ownerAgentId: 'reviewer' },
    { id: 'sess_hook', owner: 'user', sourceType: 'webhook', sourceName: 'push', ownerAgentId: 'lead' },
  ];
  for (const session of refused) await assert.rejects(run(session), /create belongs to a bot conversation/);
  assert.equal(seen.length, 2, 'a refused create never reaches the service');
  // A task session reaches its agent only through its reported result.
  const task = {
    id: 'sess_task_1',
    owner: 'cli',
    sourceType: 'lead',
    taskOrigin: { agentId: 'lead', sessionId: 'sess_home_lead' },
  };
  await assert.rejects(run(task, { action: 'send', session_id: 'sess_home_lead', prompt: 'hi' }), /only through/);
  await run(task, { action: 'send', session_id: 'sess_other', prompt: 'hi' });
  assert.deepEqual(seen.at(-1), ['send', '']);
});

test('the Project resolves by name or alias, by an existing directory, and is refused otherwise', (t) => {
  const dir = tempDir(t);
  const projects = [
    { name: 'mixdog', alias: 'md', path: '/repo/mixdog' },
    { name: 'twin', path: '/a/twin' },
    { name: 'twin', path: '/b/twin' },
  ];
  assert.deepEqual(resolveTaskProject('Mixdog', { projects, cwd: dir }), {
    cwd: '/repo/mixdog',
    desktopSession: { classification: 'project', projectPath: '/repo/mixdog' },
    project: { name: 'mixdog', path: '/repo/mixdog' },
  });
  assert.equal(resolveTaskProject('md', { projects, cwd: dir }).cwd, '/repo/mixdog');
  assert.equal(resolveTaskProject(dir, { projects }).desktopSession.projectPath, dir);
  assert.throws(() => resolveTaskProject(join(dir, 'missing'), { projects }), /neither a registered Project/);
  assert.throws(() => resolveTaskProject('twin', { projects }), /ambiguous; ask the user/);
  assert.deepEqual(resolveTaskProject('', { projects, cwd: dir }), {
    cwd: dir,
    desktopSession: { classification: 'task', projectPath: null },
    project: null,
  });
});

test('create records the origin, follows the worktree default and returns at once', async () => {
  const h = fakeService();
  const { api, delivered } = tasks(h, { newTaskDefault: async () => 'worktree' });
  const result = await api.create(
    { brief: 'Read README.md\nand report its first line', project: 'mixdog', model: 'test/fast' },
    { callerSessionId: 'sess_home_lead', callerAgentId: 'lead', callerCwd: '/home' }
  );
  assert.deepEqual(result, {
    session_id: 'sess_task_1',
    status: 'started',
    title: 'Read README.md',
    project: '/repo/mixdog',
  });
  const [, created] = h.calls[0];
  assert.equal(created.cwd, '/repo/mixdog');
  assert.deepEqual(created.desktopSession, { classification: 'project', projectPath: '/repo/mixdog' });
  assert.equal(created.model, 'test/fast');
  const origin = created.sessionProfile.taskOrigin;
  assert.equal(origin.agentId, 'lead');
  assert.equal(origin.sessionId, 'sess_home_lead');
  assert.match(origin.requestId, /^atask_/);
  assert.equal(origin.title, 'Read README.md');
  assert.equal(origin.notify, true);
  const [, worktree, ctx] = h.calls[1];
  assert.equal(worktree.action, 'requestWorktree');
  assert.deepEqual(worktree.args[0], {
    provision: true,
    carryChanges: 'leave',
    prompt: 'Read README.md',
    txId: origin.requestId,
  });
  assert.deepEqual(ctx, { revision: 1 });
  const [brief] = submitted(h);
  assert.equal(brief.prompt, 'Read README.md\nand report its first line');
  assert.equal(brief.options.id, origin.requestId);
  assert.equal(typeof brief.options.onSettled, 'function');
  assert.deepEqual(delivered, [
    [
      'lead',
      {
        runId: `${origin.requestId}_started`,
        taskSessionId: 'sess_task_1',
        title: 'Read README.md',
        status: 'started',
      },
    ],
  ]);
  // The task session record carries the origin and its title.
  const opts = sessionOptions(
    {
      rt: {
        route: { provider: 'openai-oauth', model: 'gpt-test' },
        config: {},
        mode: 'full',
        sessionProfile: created.sessionProfile,
        currentCwd: '/repo/mixdog',
      },
      cfgMod: { getPluginData: () => process.cwd() },
      activeWorkflowContext: () => ({ summary: null, packContext: '', leadPromptParts: () => ({}) }),
      featureDisallowedTools: () => [],
    },
    null
  );
  assert.equal(opts.owner, 'cli');
  assert.equal(opts.sessionMode, 'coding');
  assert.equal(opts.sourceName, 'agent:lead@home');
  assert.deepEqual(opts.taskOrigin, origin);
  const record = sessionOriginFields(opts, {
    profile: null,
    presetObj: null,
    providerCacheOpts: null,
    surface: { toolPermission: null, hasCallerAllow: false },
  });
  assert.deepEqual(record.taskOrigin, origin);
  assert.equal(record.title, 'Read README.md');
  assert.equal(record.titleSource, 'ai');
});

const CALLER = { callerSessionId: 'sess_home_lead', callerAgentId: 'lead' };

test('a created task session starts on the Lead route; an explicit model wins', async () => {
  const h = fakeService();
  const { api } = tasks(h, {
    lastUsedRoute: async () => assert.fail('the Lead route needs no fallback'),
  });
  await api.create({ brief: 'x' }, CALLER);
  const [, created] = h.calls[0];
  assert.equal(created.provider, 'lead-provider');
  assert.equal(created.model, 'lead-model');
  await api.create({ brief: 'y', model: 'test/fast' }, CALLER);
  const [, explicit] = h.calls.filter(([name]) => name === 'create')[1];
  assert.deepEqual([explicit.provider, explicit.model], ['test', 'test/fast']);
});

test('without a Lead route the last-used model starts the task session', async () => {
  const h = fakeService();
  const { api } = tasks(h, {
    leadRoute: async () => null,
    lastUsedRoute: async () => ({ provider: 'used-provider', model: 'used-model' }),
  });
  await api.create({ brief: 'x' }, CALLER);
  const [, created] = h.calls[0];
  assert.deepEqual([created.provider, created.model], ['used-provider', 'used-model']);
});

test('with no Lead route and no last-used model create fails and creates no session', async () => {
  const h = fakeService();
  const { api, delivered } = tasks(h, { leadRoute: async () => null });
  await assert.rejects(api.create({ brief: 'x' }, CALLER), /Choose a Lead model first/);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(delivered, []);
});

function lastUsedApi(h) {
  return createAgentTaskSessions({
    getSessionService: () => h.service,
    deliver: async () => {},
    watches: { add: async () => {}, list: async () => [] },
    listProjects: async () => [],
    newTaskDefault: async () => 'branch',
    leadRoute: async () => null,
    // A task turn's end is its final answer at once here (no agent work, no quiet period).
    pendingWork: async () => false,
    settleMs: 0,
    log: () => {},
  });
}

test('the last-used model is the first coding session row in catalog order that has one', async () => {
  const h = fakeService();
  h.service.listSessionCatalog = async () => ({
    sessions: [
      { id: 'a', provider: 'mixy', model: 'mixy-model', sessionMode: 'agent' },
      { id: 'b', provider: '', model: '' },
      { id: 'c', provider: 'new', model: 'new-model' },
      { id: 'd', provider: 'old', model: 'old-model' },
    ],
  });
  await lastUsedApi(h).create({ brief: 'x' }, CALLER);
  const [, created] = h.calls[0];
  assert.deepEqual([created.provider, created.model], ['new', 'new-model']);
});

test('the last-used model search follows nextCursor past the first page and stops at the first match', async () => {
  const h = fakeService();
  const requests = [];
  const pages = {
    start: { sessions: [{ id: 'a', provider: '', model: '' }], nextCursor: 'p2' },
    p2: { sessions: [{ id: 'b', provider: 'mixy', model: 'm', sessionMode: 'agent' }], nextCursor: 'p3' },
    p3: { sessions: [{ id: 'c', provider: 'deep', model: 'deep-model' }], nextCursor: 'p4' },
    p4: { sessions: [{ id: 'd', provider: 'older', model: 'older-model' }], nextCursor: null },
  };
  h.service.listSessionCatalog = async ({ page }) => {
    requests.push(page.cursor);
    return pages[page.cursor || 'start'];
  };
  await lastUsedApi(h).create({ brief: 'x' }, CALLER);
  const [, created] = h.calls[0];
  assert.deepEqual([created.provider, created.model], ['deep', 'deep-model']);
  assert.deepEqual(requests, [null, 'p2', 'p3'], 'paging stops at the first match');
});

test('the last-used model search is bounded and ends at the last page', async () => {
  const h = fakeService();
  let reads = 0;
  h.service.listSessionCatalog = async () => {
    reads += 1;
    return { sessions: [{ id: `s${reads}`, provider: '', model: '' }], nextCursor: `c${reads}` };
  };
  await assert.rejects(lastUsedApi(h).create({ brief: 'x' }, CALLER), /Choose a Lead model first/);
  assert.equal(reads, 20);
  assert.deepEqual(h.calls, []);
});

test('a Project task without the worktree default stays in the Project folder', async () => {
  const h = fakeService();
  const { api } = tasks(h);
  await api.create(
    { brief: 'x', title: 'Check', project: 'mixdog' },
    { callerSessionId: 'sess_home_lead', callerAgentId: 'lead' }
  );
  assert.deepEqual(
    h.calls.map(([name]) => name),
    ['create', 'submit']
  );
  await assert.rejects(
    api.create({ brief: ' ' }, { callerSessionId: 'sess_home_lead', callerAgentId: 'lead' }),
    /brief/
  );
  await assert.rejects(
    api.create({ brief: 'x', project: '/no/such/dir' }, { callerSessionId: 'sess_home_lead', callerAgentId: 'lead' }),
    /neither a registered Project/
  );
});

test('only turns the origin agent starts report back, ended or waiting for the user', async () => {
  const h = fakeService();
  const { api, delivered, stored, watched } = tasks(h);
  const { session_id: taskId } = await api.create(
    { brief: 'Read README', title: 'README' },
    { callerSessionId: 'sess_home_lead', callerAgentId: 'lead', callerCwd: '/home' }
  );
  stored.set(taskId, { id: taskId, taskOrigin: h.calls[0][1].sessionProfile.taskOrigin });
  const [brief] = submitted(h);
  // Waiting for the user's approval: one faint line, however often state changes.
  h.state.toolApproval = { id: 'approval_1' };
  h.emit();
  h.emit();
  brief.options.onSettled({ status: 'done', result: { content: '# mixdog' } });
  await settle();
  assert.deepEqual(
    delivered.map(([, report]) => [report.status, report.text ?? null]),
    [
      ['started', null],
      ['blocked', ''],
      ['completed', '# mixdog'],
    ]
  );
  assert.equal(h.listeners.size, 0, 'the watch ends with the turn');

  // The agent's follow-up reports to it; another agent's send reports to that
  // agent alone; a coding session's send reports to nobody.
  const execute = createSessionControl({ getSessionService: () => h.service, agentTasks: api });
  const storedOrigin = structuredClone(stored.get(taskId).taskOrigin);
  assert.deepEqual(
    await execute(
      { action: 'send', session_id: taskId, prompt: 'and the second line?' },
      { callerSessionId: 'sess_home_lead', callerAgentId: 'lead' }
    ),
    { sessionId: taskId, accepted: true, reportsBack: true }
  );
  assert.equal(
    (
      await execute(
        { action: 'send', session_id: taskId, prompt: 'from another agent' },
        { callerSessionId: 'sess_home_reviewer', callerAgentId: 'reviewer' }
      )
    ).reportsBack,
    true
  );
  assert.deepEqual(
    await execute(
      { action: 'send', session_id: taskId, prompt: 'from a coding session' },
      { callerSessionId: 'sess_c' }
    ),
    {
      sessionId: taskId,
      accepted: true,
      reportsBack: false,
      reportsBackReason:
        'only a bot conversation gets session results reported back; check that session for the result',
    }
  );
  const [, followUp, foreign, coding] = submitted(h);
  assert.equal(followUp.options.id.startsWith('atask_'), true);
  assert.equal(typeof followUp.options.onSettled, 'function');
  assert.equal(typeof foreign.options.onSettled, 'function');
  assert.equal(coding.options.onSettled, undefined);
  followUp.options.onSettled({ status: 'failed', error: 'provider down' });
  await settle();
  assert.deepEqual(delivered.at(-1), [
    'lead',
    {
      runId: `${followUp.options.id}_end`,
      taskSessionId: taskId,
      title: 'README',
      status: 'failed',
      text: 'provider down',
      watchId: followUp.options.id,
    },
  ]);
  foreign.options.onSettled({ status: 'done', result: { content: 'done' } });
  await settle();
  assert.deepEqual(delivered.at(-1), [
    'reviewer',
    {
      runId: `${foreign.options.id}_end`,
      taskSessionId: taskId,
      title: taskId,
      status: 'completed',
      text: 'done',
      target: 'session',
      hop: 1,
      watchId: foreign.options.id,
    },
  ]);
  // Every reporting turn was watched durably; a coding session's send was not.
  assert.deepEqual(
    watched.map((watch) => [watch.runId, watch.agentId, watch.homeSessionId, watch.target ?? 'task']),
    [
      [brief.options.id, 'lead', 'sess_home_lead', 'task'],
      [followUp.options.id, 'lead', 'sess_home_lead', 'task'],
      [foreign.options.id, 'reviewer', 'sess_home_reviewer', 'session'],
    ]
  );
  assert.equal(delivered.length, 5, "a user's own turns never report");
  assert.deepEqual(stored.get(taskId).taskOrigin, storedOrigin, 'a send never rewrites the stored origin');
});

function homeDelivery(t) {
  const dir = tempDir(t);
  const queue = createRoutineResultQueue(join(dir, 'routine-results.json'));
  const sessions = new Map([['sess_home_lead', { id: 'sess_home_lead', messages: [], generation: 1 }]]);
  const wakes = [];
  const retries = [];
  const failSaves = { count: 0 };
  const delivery = createAgentHomeDelivery({
    loadSession: (id) => sessions.get(id) || null,
    saveSession: async () => {
      if (failSaves.count > 0) {
        failSaves.count -= 1;
        throw new Error('disk busy');
      }
    },
    turnInFlight: () => false,
    queue,
    live: () => ({ busy: () => false, notice: () => {}, wake: async (id, prompt) => wakes.push([id, prompt]) }),
    retryLater: (fn, ms) => retries.push({ fn, ms }),
    log: () => {},
  });
  const thread = () => sessions.get('sess_home_lead').messages;
  return { queue, delivery, wakes, retries, failSaves, thread };
}

const report = (n, status = 'completed') => ({
  runId: `turn_${n}_end`,
  taskSessionId: 'sess_task_1',
  title: 'README',
  status,
  text: `answer ${n}`,
});

test('a task result is persisted before delivery, retried on failure, and wakes the agent once', async (t) => {
  const h = homeDelivery(t);
  await h.delivery.drain(
    await h.delivery.enqueueTask('lead', {
      runId: 'r_started',
      taskSessionId: 'sess_task_1',
      title: 'README',
      status: 'started',
    })
  );
  assert.equal(h.wakes.length, 0, 'the start line wakes nobody');
  h.failSaves.count = 1;
  const homeId = await h.delivery.enqueueTask('lead', report(1));
  await h.delivery.drain(homeId);
  assert.equal((await h.queue.items(homeId)).length, 1, 'queued durably while delivery fails');
  assert.equal(h.wakes.length, 0);
  // The retry delivers the stored result; the turn never runs again.
  for (const retry of h.retries.splice(0)) retry.fn();
  await h.delivery.drain(homeId);
  assert.deepEqual(await h.queue.items(homeId), []);
  assert.equal(h.wakes.length, 1);
  assert.equal(h.wakes[0][0], 'sess_home_lead');
  assert.match(h.wakes[0][1], /<task-output session="sess_task_1" status="completed">\nanswer 1\n<\/task-output>/);
  assert.match(
    h.wakes[0][1],
    /Relay the report above to the user now, briefly and in your own words; a report marked \(working\) is still in progress, not done\./
  );
  // A replayed enqueue posts nothing and wakes nobody.
  await h.delivery.drain(await h.delivery.enqueueTask('lead', report(1)));
  assert.equal(h.wakes.length, 1);
  const items = restoreTranscriptItems(h.thread(), { sessionId: 'sess_home_lead' });
  assert.deepEqual(
    items.map((item) => [item.kind, item.routine?.kind, item.routine?.status, item.routine?.sessionId]),
    [
      ['notice', 'task', 'started', 'sess_task_1'],
      ['notice', 'task', 'completed', 'sess_task_1'],
    ]
  );
});

test('after three round trips the report asks the agent to check with the user', async (t) => {
  const h = homeDelivery(t);
  for (const n of [1, 2, 3, 4]) await h.delivery.drain(await h.delivery.enqueueTask('lead', report(n)));
  const capped = h.thread().map((message) => /check with the user before sending it more work/.test(message.content));
  assert.deepEqual(capped, [false, false, true, true]);
  assert.match(h.thread()[2].content, /round trip 3/);
  assert.equal(h.wakes.length, 4, 'one wake per reported turn');
});

test('a turn waiting for the user posts one faint line and wakes nobody', async (t) => {
  const h = homeDelivery(t);
  await h.delivery.drain(await h.delivery.enqueueTask('lead', report(1, 'blocked')));
  const [message] = h.thread();
  assert.match(message.content, /waiting for the user's answer or approval in that session. Do not answer it yourself/);
  assert.equal(message.meta.routine.status, 'blocked');
  assert.equal(h.wakes.length, 0);
  // Waiting is not a round trip.
  await h.delivery.drain(await h.delivery.enqueueTask('lead', report(2)));
  assert.equal(h.thread()[1].content.includes('round trip'), false);
});

test("an ordinary session reports as a session, and another agent's thread stops waking past the cap", async (t) => {
  const h = homeDelivery(t);
  const botReport = (n) => ({
    runId: `bot_${n}_end`,
    taskSessionId: 'sess_home_reviewer',
    title: 'Reviewer',
    status: 'completed',
    text: `answer ${n}`,
    target: 'session',
  });
  for (const n of [1, 2, 3, 4, 5]) await h.delivery.drain(await h.delivery.enqueueTask('lead', botReport(n)));
  const thread = h.thread();
  assert.match(
    thread[0].content,
    /^\[mixdog-runtime\] Session "Reviewer" \(sess_home_reviewer\) reported \(completed\)/
  );
  assert.deepEqual(
    thread.map((message) => /did not wake you/.test(message.content)),
    [false, false, false, true, true]
  );
  assert.equal(h.wakes.length, 3, 'past the cap the rows post without waking the agent');
  assert.equal(routineResultNotice(thread[0]).text, '🛠 Session completed · Reviewer — answer 1');
  const [item] = restoreTranscriptItems(thread, { sessionId: 'sess_home_lead' });
  assert.equal(item.routine.target, 'session');
  // A task session the agent created keeps its wording.
  const task = agentTaskMessage({ title: 'README', status: 'completed', taskSessionId: 'sess_task_1' });
  assert.match(task.content, /^\[mixdog-runtime\] Agent task session "README" \(sess_task_1\) reported/);
  assert.equal(task.meta.routine.target, undefined);
});

test("the user's own message in the home thread restarts its round trips, so a capped thread wakes again", async (t) => {
  const h = homeDelivery(t);
  const botReport = (n) => ({
    runId: `bot_${n}_end`,
    taskSessionId: 'sess_home_reviewer',
    title: 'Reviewer',
    status: 'completed',
    text: `answer ${n}`,
    target: 'session',
  });
  for (const n of [1, 2, 3, 4]) await h.delivery.drain(await h.delivery.enqueueTask('lead', botReport(n)));
  assert.equal(h.wakes.length, 3);
  await h.delivery.resetRounds('sess_home_lead');
  await h.delivery.drain(await h.delivery.enqueueTask('lead', botReport(5)));
  assert.equal(h.wakes.length, 4, 'the first report after the reset wakes the agent');
  assert.equal(h.thread()[4].content.includes('round trip'), false, 'and counts as round trip 1');
  // Only a typed prompt resets: an agent's send, a wake or a routine fire does not.
  assert.equal(isUserTurn({ mode: 'prompt' }), true);
  assert.equal(isUserTurn({}), true);
  assert.equal(isUserTurn({ mode: 'prompt', transcriptMeta: { sender: 'lead' } }), false);
  assert.equal(isUserTurn({ mode: 'prompt', kickoff: true }), false);
  assert.equal(isUserTurn({ mode: 'routine' }), false);
});

const HOME = 'sess_home_lead';
const TARGET = 'sess_user_1';
const promptRow = (runId) => ({
  role: 'user',
  content: 'run the simulation',
  meta: { transcript: { checkpointId: runId } },
});
const replyRow = (runId, text) => ({
  role: 'assistant',
  content: text,
  meta: { transcript: { completion: { status: 'done', checkpointId: runId } } },
});

/** One data dir across daemon starts: each `boot()` is a new process over the
 *  same routine-results.json, home thread and target session record. */
function restartWorld(t) {
  const file = join(tempDir(t), 'routine-results.json');
  const home = { id: HOME, messages: [], generation: 1 };
  const records = new Map([[TARGET, { id: TARGET, title: 'AA sim', messages: [] }]]);
  const wakes = [];
  const persisted = [];
  // How the next wake goes: taken (undefined), refused (false) or a throw.
  const wakeOutcome = { next: undefined, attempts: [] };
  function boot() {
    const h = fakeService();
    const delivery = createAgentHomeDelivery({
      loadSession: (id) => (id === HOME ? home : null),
      saveSession: async () => {},
      turnInFlight: () => false,
      queue: createRoutineResultQueue(file),
      live: () => ({
        busy: () => false,
        notice: () => {},
        wake: async (id, prompt, options) => {
          wakeOutcome.attempts.push(options?.id);
          const outcome = wakeOutcome.next;
          if (outcome instanceof Error) throw outcome;
          if (outcome === false) return false;
          wakes.push([id, prompt, options]);
        },
      }),
      retryLater: () => {},
      log: () => {},
    });
    let reported = Promise.resolve(null);
    const api = createAgentTaskSessions({
      getSessionService: () => h.service,
      deliver: (agentId, report) => {
        reported = delivery.enqueueTask(agentId, report);
        return reported;
      },
      watches: {
        add: (watch) => (world.failWatch ? Promise.reject(new Error('disk full')) : delivery.watchTask(watch)),
        list: () => delivery.taskWatches(),
        remove: (runId) => delivery.unwatchTask(runId),
        follow: (runId, submissionId) => delivery.followTask(runId, submissionId),
      },
      queuedSubmissionIds: async () => [...persisted],
      loadSession: async (id) => records.get(id) || null,
      // A task turn's end is its final answer at once here (no agent work, no quiet period).
      pendingWork: async () => false,
      settleMs: 0,
      log: () => {},
    });
    const posted = async () => {
      await settle();
      const homeId = await reported;
      if (homeId) await delivery.drain(homeId);
    };
    return { h, api, delivery, posted };
  }
  const watchIds = async () => (await createRoutineResultQueue(file).watches()).map((watch) => watch.runId);
  const owedWakes = async () => {
    const { owed, batches } = await createRoutineResultQueue(file).wakes(HOME);
    return [...owed, ...batches.flatMap((batch) => batch.runIds)];
  };
  const world = {
    home,
    records,
    wakes,
    wakeOutcome,
    persisted,
    boot,
    watchIds,
    owedWakes,
    failWatch: false,
    target: () => records.get(TARGET),
  };
  return world;
}

test('a restart while the target turn runs reports it once that turn ends', async (t) => {
  const w = restartWorld(t);
  const first = w.boot();
  const origin = await first.api.reportOrigin(TARGET, 'lead', HOME);
  // The watch is durable before the target can take the turn.
  first.h.service.submitSession = async (params) => {
    first.h.calls.push(['submit', params]);
    assert.deepEqual(await w.watchIds(), [params.options.id]);
    return { accepted: true };
  };
  assert.deepEqual(await first.api.send(TARGET, 'run the simulation', origin), { accepted: true, reportsBack: true });
  const [{ options }] = submitted(first.h);
  const runId = options.id;
  assert.deepEqual(await w.watchIds(), [runId], 'the watch is stored when the send is accepted');
  // The daemon stops mid-turn: this process's onSettled never runs.
  const second = w.boot();
  w.target().messages.push(promptRow(runId));
  second.h.state.busy = true;
  assert.equal(await second.api.recover(), 1);
  await second.posted();
  assert.equal(w.home.messages.length, 0, 'nothing reports while the turn runs');
  w.target().messages.push(replyRow(runId, 'simulation finished'));
  second.h.state.busy = false;
  second.h.emit();
  await second.posted();
  assert.equal(w.home.messages.length, 1);
  assert.match(w.home.messages[0].content, /Session "AA sim" \(sess_user_1\) reported \(completed\)/);
  assert.match(w.home.messages[0].content, /simulation finished/);
  assert.equal(w.wakes.length, 1);
  assert.deepEqual(await w.watchIds(), []);
  assert.equal(second.h.listeners.size, 0, 'the re-attached watch ends with the report');
  assert.equal(await w.boot().api.recover(), 0, 'a later start has nothing to re-attach');
  assert.equal(Object.hasOwn(w.target(), 'taskOrigin'), false, 'the target never gets an origin stored');
});

test("sends a room answered under another turn's submission id recover that turn's answer after a restart", async (t) => {
  const w = restartWorld(t);
  const first = w.boot();
  const origin = await first.api.reportOrigin(TARGET, 'lead', HOME);
  // The room host takes each send's turn; it submits nothing here.
  const taken = [];
  const room = async (options) => {
    taken.push(options);
    return { accepted: true };
  };
  for (const question of ['a', 'b', 'c', 'd']) await first.api.send(TARGET, question, origin, room);
  const [a, , c] = taken.map((options) => options.id);
  // b was answered by a's turn (coalesced); c's own turn was cut short and a
  // fresh turn answered c and d (superseded): each watch follows its turn,
  // recorded before that turn ran.
  await taken[1].follow(a);
  await taken[2].follow('rturn_1');
  await taken[3].follow('rturn_1');
  // The daemon stops before any of this process's onSettled ran.
  w.target().messages.push(
    promptRow(a),
    replyRow(a, 'answer A'),
    promptRow(c),
    promptRow('rturn_1'),
    replyRow('rturn_1', 'answer F')
  );
  const second = w.boot();
  assert.equal(await second.api.recover(), 4);
  for (let i = 0; i < 20 && w.home.messages.length < 4; i += 1) {
    await settle();
    await second.delivery.drain(HOME);
  }
  const reports = w.home.messages.map((message) => message.content);
  assert.equal(reports.length, 4);
  assert.equal(reports.filter((text) => /reported \(completed\)[\s\S]*answer A/.test(text)).length, 2, 'a and b');
  assert.equal(reports.filter((text) => /reported \(completed\)[\s\S]*answer F/.test(text)).length, 2, 'c and d');
  assert.deepEqual(await w.watchIds(), []);
});

test("coalesced then cut short: after a restart both sends recover the replacement turn's answer", async (t) => {
  const w = restartWorld(t);
  const first = w.boot();
  const origin = await first.api.reportOrigin(TARGET, 'lead', HOME);
  const taken = [];
  const room = async (options) => {
    taken.push(options);
    return { accepted: true };
  };
  for (const question of ['a', 'b']) await first.api.send(TARGET, question, origin, room);
  const [a, b] = taken.map((options) => options.id);
  // a's turn answers both (b follows a); it is cut short, and the
  // replacement takes b's own id: a follows b, and b's alias returns to itself.
  await taken[1].follow(a);
  await taken[0].follow(b);
  await taken[1].follow(b);
  w.target().messages.push(promptRow(a), promptRow(b), replyRow(b, 'answer B'));
  const second = w.boot();
  assert.equal(await second.api.recover(), 2);
  for (let i = 0; i < 20 && w.home.messages.length < 2; i += 1) {
    await settle();
    await second.delivery.drain(HOME);
  }
  const reports = w.home.messages.map((message) => message.content);
  assert.equal(reports.length, 2);
  assert.ok(reports.every((text) => /reported \(completed\)[\s\S]*answer B/.test(text)));
  assert.deepEqual(await w.watchIds(), []);
});

test('a turn that ended while no report was queued reports once on recovery, never twice', async (t) => {
  const w = restartWorld(t);
  const first = w.boot();
  await first.api.send(TARGET, 'run the simulation', await first.api.reportOrigin(TARGET, 'lead', HOME));
  const [{ options }] = submitted(first.h);
  w.target().messages.push(promptRow(options.id), replyRow(options.id, 'finished before the restart'));
  const second = w.boot();
  await second.api.recover();
  await second.posted();
  assert.equal(w.home.messages.length, 1);
  assert.match(w.home.messages[0].content, /reported \(completed\)[\s\S]*finished before the restart/);
  assert.equal(w.wakes.length, 1);
  assert.deepEqual(await w.watchIds(), []);
  // A watch replayed for the already posted run posts nothing and is dropped.
  const third = w.boot();
  await third.delivery.watchTask({
    runId: options.id,
    agentId: 'lead',
    homeSessionId: HOME,
    taskSessionId: TARGET,
    title: 'AA sim',
    target: 'session',
  });
  await third.api.recover();
  await third.posted();
  assert.equal(w.home.messages.length, 1);
  assert.equal(w.wakes.length, 1);
  assert.deepEqual(await w.watchIds(), []);
});

test('a message still queued durably is watched to its end; one lost in the restart reports so', async (t) => {
  const w = restartWorld(t);
  const first = w.boot();
  const watch = (runId) => ({
    runId,
    agentId: 'lead',
    homeSessionId: HOME,
    taskSessionId: TARGET,
    title: 'AA sim',
    target: 'session',
  });
  await first.delivery.watchTask(watch('atask_lost'));
  await first.delivery.watchTask(watch('atask_queued'));
  w.persisted.push('atask_queued');
  const second = w.boot();
  await second.api.recover();
  await second.posted();
  assert.equal(w.home.messages.length, 1);
  assert.match(w.home.messages[0].content, /reported \(cancelled\)[\s\S]*never ran/);
  assert.deepEqual(await w.watchIds(), ['atask_queued']);
  // The restored queue runs the message.
  w.persisted.length = 0;
  second.h.state.busy = true;
  w.target().messages.push(promptRow('atask_queued'));
  second.h.emit();
  await second.posted();
  assert.equal(w.home.messages.length, 1);
  w.target().messages.push(replyRow('atask_queued', 'ran after the restart'));
  second.h.state.busy = false;
  second.h.emit();
  await second.posted();
  assert.equal(w.home.messages.length, 2);
  assert.match(w.home.messages[1].content, /reported \(completed\)[\s\S]*ran after the restart/);
  assert.deepEqual(await w.watchIds(), []);
});

test('a send whose watch cannot be stored claims no report; a refused or failed submit drops its watch', async (t) => {
  const w = restartWorld(t);
  const first = w.boot();
  const origin = await first.api.reportOrigin(TARGET, 'lead', HOME);
  w.failWatch = true;
  assert.deepEqual(await first.api.send(TARGET, 'run the simulation', origin), {
    accepted: true,
    reportsBack: false,
    reportsBackReason: 'its report could not be recorded (disk full); check that session for the result',
  });
  const [plain] = submitted(first.h);
  assert.equal(plain.options.onSettled, undefined, 'no report hook it could not keep');
  assert.equal(first.h.listeners.size, 0);
  w.failWatch = false;
  first.h.service.submitSession = async () => ({ accepted: false });
  assert.deepEqual(await first.api.send(TARGET, 'refused', origin), { accepted: false, reportsBack: false });
  assert.deepEqual(await w.watchIds(), [], 'a refused submit drops its watch');
  first.h.service.submitSession = async () => {
    throw new Error('runtime gone');
  };
  await assert.rejects(first.api.send(TARGET, 'failed', origin), /runtime gone/);
  assert.deepEqual(await w.watchIds(), [], 'a failed submit drops its watch');
  assert.equal(first.h.listeners.size, 0);
  assert.equal(await w.boot().api.recover(), 0);
  assert.equal(w.home.messages.length, 0);
});

test('a wake that fails before a restart is owed durably and taken once after it, without a second row', async (t) => {
  const w = restartWorld(t);
  const first = w.boot();
  await first.api.send(TARGET, 'run the simulation', await first.api.reportOrigin(TARGET, 'lead', HOME));
  const [{ options }] = submitted(first.h);
  w.wakeOutcome.next = new Error('submit failed');
  options.onSettled({ status: 'done', result: { content: 'simulation finished' } });
  await first.posted();
  assert.equal(w.home.messages.length, 1, 'the row is posted');
  assert.equal(w.wakes.length, 0);
  assert.deepEqual(await w.owedWakes(), [`${options.id}_end`], 'the wake stays owed');
  // The daemon stops before any retry: the next start wakes, posting nothing.
  w.wakeOutcome.next = undefined;
  const second = w.boot();
  for (const homeId of await second.delivery.recover()) await second.delivery.drain(homeId);
  assert.equal(w.home.messages.length, 1);
  assert.equal(w.wakes.length, 1);
  assert.match(w.wakes[0][1], /simulation finished/);
  assert.match(w.wakes[0][2].id, /^awake_/);
  assert.deepEqual(await w.owedWakes(), []);
  assert.deepEqual(await w.boot().delivery.recover(), [], 'a later start owes nothing');
  assert.equal(w.wakes.length, 1);
});

test('a refused wake stays owed; a wake taken just before a restart is not taken again', async (t) => {
  const w = restartWorld(t);
  const first = w.boot();
  const origin = await first.api.reportOrigin(TARGET, 'lead', HOME);
  await first.api.send(TARGET, 'one', origin);
  await first.api.send(TARGET, 'two', origin);
  const [one, two] = submitted(first.h);
  w.wakeOutcome.next = false;
  one.options.onSettled({ status: 'done', result: { content: 'first' } });
  await first.posted();
  assert.equal(w.wakes.length, 0);
  assert.equal((await w.owedWakes()).length, 1, 'a refused wake stays owed');
  w.wakeOutcome.next = undefined;
  await first.delivery.drain(HOME);
  assert.equal(w.wakes.length, 1, 'the retry takes it');
  assert.deepEqual(await w.owedWakes(), []);
  // The wake turn of the second result reached the thread and finished, but
  // the process stopped before it was marked taken.
  w.wakeOutcome.next = new Error('stopped');
  two.options.onSettled({ status: 'done', result: { content: 'second' } });
  await first.posted();
  const wakeId = w.wakeOutcome.attempts.at(-1);
  w.home.messages.push(
    { role: 'user', content: 'wake', meta: { transcript: { checkpointId: wakeId } } },
    replyRow(wakeId, 'relayed')
  );
  w.wakeOutcome.next = undefined;
  const second = w.boot();
  for (const homeId of await second.delivery.recover()) await second.delivery.drain(homeId);
  assert.equal(w.wakes.length, 1, 'never woken twice');
  assert.deepEqual(await w.owedWakes(), []);
});

test('a wake taken before a restart is not taken again when a later result is owed too', async (t) => {
  const w = restartWorld(t);
  const first = w.boot();
  const origin = await first.api.reportOrigin(TARGET, 'lead', HOME);
  await first.api.send(TARGET, 'A', origin);
  await first.api.send(TARGET, 'B', origin);
  const [a, b] = submitted(first.h);
  // A's wake turn reached the thread and finished, then the process stopped
  // before the obligation was cleared.
  w.wakeOutcome.next = new Error('stopped');
  a.options.onSettled({ status: 'done', result: { content: 'result A' } });
  await first.posted();
  const wakeA = w.wakeOutcome.attempts.at(-1);
  w.home.messages.push(
    { role: 'user', content: 'wake', meta: { transcript: { checkpointId: wakeA } } },
    replyRow(wakeA, 'relayed A')
  );
  // B's turn ended while the daemon was down.
  w.target().messages.push(promptRow(b.options.id), replyRow(b.options.id, 'result B'));
  w.wakeOutcome.next = undefined;
  const second = w.boot();
  await second.api.recover();
  await second.posted();
  for (const homeId of await second.delivery.recover()) await second.delivery.drain(homeId);
  assert.equal(w.wakes.length, 1, 'only B wakes');
  assert.match(w.wakes[0][1], /result B/);
  assert.equal(w.wakes[0][1].includes('result A'), false, 'A is never relayed twice');
  assert.notEqual(w.wakes[0][2].id, wakeA, 'B wakes under a batch of its own');
  assert.deepEqual(await w.owedWakes(), []);
  assert.equal(w.home.messages.filter((message) => message.meta?.routine).length, 2, 'one row each');
});

const DAY = 24 * 60 * 60 * 1000;
const roundItem = (runId, target) => ({ runId, kind: 'agent-task', taskSessionId: target, roundTrip: true });

function capWorld(
  t,
  { caps, deleted = [], threads = {}, agentPresence = () => 'present', roomPresence = () => 'present' } = {}
) {
  const file = join(tempDir(t), 'routine-results.json');
  const clock = { now: Date.parse('2026-01-01T00:00:00Z') };
  const queue = createRoutineResultQueue(file, { now: () => clock.now, ...(caps ? { caps } : {}) });
  const logs = [];
  const wakes = [];
  // While busy no thread is posted to; while `failWake` every wake throws.
  const state = { busy: true, failWake: false };
  const delivery = createAgentHomeDelivery({
    // Every record but the given threads reads as null, as an unreadable one does.
    loadSession: (id) => threads[id] || null,
    saveSession: async () => {},
    turnInFlight: () => state.busy,
    queue,
    live: () => ({
      busy: () => false,
      notice: () => {},
      wake: async (id, prompt, options) => {
        if (state.failWake) throw new Error('submit failed');
        wakes.push([id, prompt, options]);
      },
    }),
    retryLater: () => {},
    agentPresence,
    roomPresence,
    sessionDeleted: (id) => deleted.includes(id),
    log: (line) => logs.push(line),
  });
  const doc = () => JSON.parse(readFileSync(file, 'utf8'));
  return { queue, delivery, clock, logs, doc, wakes, state };
}

test('start retires only proven-deleted homes: Mixy, threadless bots and live rooms keep their watches', async (t) => {
  const mixy = 'sess_home_lead';
  const threadless = 'sess_home_kept';
  const deleted = 'sess_home_gone';
  const room = 'sess_room_abcdef12';
  const member = 'sess_rmem_abcdef12_kept';
  const deletedRoom = 'sess_room_zzzzzz99';
  const homes = [mixy, threadless, deleted, room, member, deletedRoom];
  // No thread record exists for any of them.
  const w = capWorld(t, {
    agentPresence: (agentId) => (agentId === 'gone' || agentId === 'lead' ? 'deleted' : 'present'),
    roomPresence: (roomId) => (roomId === 'zzzzzz99' ? 'deleted' : 'present'),
  });
  for (const homeId of homes) {
    await w.queue.add(homeId, roundItem(`${homeId}_end`, 'sess_t'));
    await w.queue.remove(homeId, [`${homeId}_end`], null, { wake: [`${homeId}_end`] });
    await w.queue.watch({ runId: `w_${homeId}`, agentId: 'x', homeSessionId: homeId, taskSessionId: 'sess_t' });
  }
  await w.delivery.recover();
  const kept = [mixy, threadless, room, member].sort();
  const doc = w.doc();
  assert.deepEqual(Object.keys(doc.rounds).sort(), kept);
  assert.deepEqual(Object.keys(doc.wakes).sort(), kept);
  assert.deepEqual(Object.keys(doc.delivered).sort(), kept);
  assert.deepEqual(
    Object.values(doc.watches)
      .map((watch) => watch.homeSessionId)
      .sort(),
    kept,
    "Mixy's watch survives with no home record, even if a probe calls Mixy deleted"
  );
});

test('every write retires idle round counts and keeps the most recent targets per home', async (t) => {
  const w = capWorld(t, { caps: { roundTargets: 2, watches: 200, wakeRunIds: 100 } });
  const home = 'sess_home_lead';
  for (const target of ['sess_a', 'sess_b', 'sess_c']) {
    w.clock.now += 1000;
    await w.queue.add(home, roundItem(`${target}_end`, target));
  }
  assert.deepEqual(Object.keys(w.doc().rounds[home]).sort(), ['sess_b', 'sess_c'], 'least recently counted drops');
  w.clock.now += 31 * DAY;
  // Any write, not only a start, retires the idle counts.
  await w.queue.watch({ runId: 'w1', agentId: 'lead', homeSessionId: home, taskSessionId: 'sess_a' });
  assert.deepEqual(w.doc().rounds, {});
  await w.queue.add(home, roundItem('again_end', 'sess_c'));
  assert.equal((await w.queue.items(home)).at(-1).round, 1, 'an idle count starts over');
});

test('a home keeps at most its cap of watches and owed wakes', async (t) => {
  const home = 'sess_home_lead';
  // sess_unreadable has no readable record but no deletion evidence either.
  const w = capWorld(t, { caps: { roundTargets: 100, watches: 2, wakeRunIds: 3 }, deleted: ['sess_dead'] });
  const watch = (runId, taskSessionId, homeSessionId = home) => ({
    runId,
    agentId: 'lead',
    homeSessionId,
    taskSessionId,
  });
  await w.delivery.watchTask(watch('w1', 'sess_dead'));
  await w.delivery.watchTask(watch('w2', 'sess_unreadable'));
  await w.delivery.watchTask(watch('w_other', 'sess_alive', 'sess_home_reviewer'));
  // At the cap the oldest watch whose session is proven deleted makes room, logged.
  await w.delivery.watchTask(watch('w3', 'sess_alive'));
  assert.deepEqual(Object.keys(w.doc().watches).sort(), ['w2', 'w3', 'w_other']);
  assert.match(w.logs.join('\n'), /watch cap: dropped 1 watch/);
  // An unreadable target is not evicted: the watch is refused, so the send claims no report.
  await assert.rejects(w.delivery.watchTask(watch('w4', 'sess_alive')), /already waits on 2 session reports/);
  assert.deepEqual(Object.keys(w.doc().watches).sort(), ['w2', 'w3', 'w_other']);
  // Owed wakes: past the cap the oldest collapse into one marker; none is lost.
  assert.equal((await w.queue.remove(home, [], null, { wake: ['a', 'b'] })).overflowed, 0);
  assert.equal((await w.queue.remove(home, [], null, { wake: ['c', 'd'] })).overflowed, 1);
  assert.deepEqual(await w.queue.wakes(home), {
    owed: ['b', 'c', 'd'],
    batches: [],
    overflow: { count: 1, oldest: 'a', newest: 'a' },
  });
  const batch = await w.queue.batchWake(home);
  assert.deepEqual(batch.overflow, { count: 1, oldest: 'a', newest: 'a' }, 'the next batch takes the marker over');
  // A stored batch fills the cap: later results collapse, the batch is unchanged.
  assert.equal((await w.queue.remove(home, [], null, { wake: ['e', 'f'] })).overflowed, 2);
  const state = await w.queue.wakes(home);
  assert.deepEqual(state.batches, [batch]);
  assert.deepEqual(state.overflow, { count: 2, oldest: 'e', newest: 'f' });
});

test('past the wake cap no report is lost: the next wake relays the overflow once, even after a failed try', async (t) => {
  const home = 'sess_home_lead';
  const thread = { id: home, messages: [], generation: 1 };
  const w = capWorld(t, { caps: { roundTargets: 100, watches: 200, wakeRunIds: 2 }, threads: { [home]: thread } });
  // Five results arrive while the thread is busy, then post in one pass.
  for (const n of [1, 2, 3, 4, 5]) await w.delivery.enqueueTask('lead', report(n));
  w.state.busy = false;
  w.state.failWake = true;
  await w.delivery.drain(home);
  assert.equal(thread.messages.length, 5, 'every result is posted');
  assert.equal(w.wakes.length, 0);
  assert.match(w.logs.join('\n'), /wake cap: 3 result\(s\) ride the next wake/);
  const [stored] = (await w.queue.wakes(home)).batches;
  assert.deepEqual(stored.runIds, ['turn_4_end', 'turn_5_end']);
  assert.deepEqual(stored.overflow, { count: 3, oldest: 'turn_1_end', newest: 'turn_3_end' });
  // The retry wakes once under the same batch, carrying the overflow.
  w.state.failWake = false;
  await w.delivery.drain(home);
  assert.equal(w.wakes.length, 1);
  assert.equal(w.wakes[0][2].id, stored.id);
  assert.match(w.wakes[0][1], /answer 4[\s\S]*answer 5/);
  assert.match(w.wakes[0][1], /3 more reports arrived; read the rows above\./);
  assert.deepEqual(await w.queue.wakes(home), { owed: [], batches: [], overflow: null }, 'cleared once taken');
  await w.delivery.drain(home);
  assert.equal(w.wakes.length, 1, 'never relayed twice');
});

test('the end of a stored turn is read from its completion, interruption or the next prompt', () => {
  assert.equal(submissionOutcome([], 'a'), null);
  assert.equal(submissionOutcome([promptRow('a')], 'a'), 'open');
  assert.deepEqual(submissionOutcome([promptRow('a'), replyRow('a', 'ok')], 'a'), { status: 'completed', text: 'ok' });
  const failed = {
    ...promptRow('a'),
    meta: { transcript: { checkpointId: 'a', completion: { status: 'failed', detail: 'provider down' } } },
  };
  assert.deepEqual(submissionOutcome([failed], 'a'), { status: 'failed', text: 'provider down' });
  const interrupted = { role: 'user', content: '[Request interrupted by process restart]' };
  assert.deepEqual(submissionOutcome([promptRow('a'), interrupted], 'a'), { status: 'cancelled', text: '' });
  assert.deepEqual(submissionOutcome([promptRow('a'), promptRow('b')], 'a'), { status: 'cancelled', text: '' });
  // A merged batch names every submission it delivered.
  const merged = { role: 'user', content: 'x', meta: { transcript: { checkpointId: 'a', submissionIds: ['a', 'b'] } } };
  assert.deepEqual(submissionOutcome([merged, replyRow('a', 'both')], 'b'), { status: 'completed', text: 'both' });
});

test('a room member opens a task session: its result reaches the member session alone and wakes its relay turn in the room', async (t) => {
  const member = roomMemberSessionId('abc123', 'gh');
  const roomLog = roomSessionId('abc123');
  const spoke = roomRowMessage({
    id: 'row_gh_1',
    kind: 'speech',
    speaker: 'gh',
    name: 'GH Bot',
    text: 'I will build it.',
  });
  const sessions = new Map([
    [member, { id: member, messages: [], generation: 1 }],
    [roomLog, { id: roomLog, messages: [spoke], generation: 1 }],
  ]);
  const loadStored = (id) => sessions.get(id) || null;
  const queue = createRoutineResultQueue(join(tempDir(t), 'routine-results.json'));
  const wakes = [];
  const relays = [];
  const delivery = createAgentHomeDelivery({
    loadSession: loadStored,
    saveSession: async () => {},
    turnInFlight: () => false,
    queue,
    live: () => ({ busy: () => false, notice: () => {}, wake: async (...args) => wakes.push(args) }),
    retryLater: () => {},
    // The room host's relay turn (agent-room-host.mjs), finished at once.
    roomRelay: async (...args) => {
      relays.push(args);
      return { settled: Promise.resolve('done') };
    },
    log: () => {},
  });
  const pending = [];
  const h = fakeService();
  const { api } = tasks(h, {
    deliver: (agentId, report) => {
      const queued = delivery.enqueueTask(agentId, report);
      pending.push(queued);
      return queued;
    },
    watches: {
      add: (watch) => delivery.watchTask(watch),
      list: () => delivery.taskWatches(),
      remove: (runId) => delivery.unwatchTask(runId),
    },
    turnArtifacts: async () => ({ files: [], omitted: 0 }),
  });
  const memberSession = { id: member, owner: 'cli', sourceType: 'lead' };
  const session = createWorkspaceToolHandlers({
    rt: { session: memberSession, config: {} },
    executeSessionControl: createSessionControl({ getSessionService: () => h.service, agentTasks: api }),
  }).session;
  const created = JSON.parse(
    await session(
      { action: 'create', brief: 'Build the report\nwith charts' },
      { callerCtx: { callerSessionId: member }, callerCwd: '/rooms' }
    )
  );
  assert.equal(created.session_id, 'sess_task_1');
  const [, params] = h.calls.find(([name]) => name === 'create');
  assert.deepEqual(
    [params.sessionProfile.taskOrigin.agentId, params.sessionProfile.taskOrigin.sessionId],
    ['gh', member]
  );
  // The start line reaches the member's own session only.
  await Promise.all(pending);
  await delivery.drain(member);
  assert.equal(sessions.get(member).messages.length, 1);
  assert.match(
    sessions.get(member).messages[0].content,
    /started, not done yet; its final answer is reported here when it finishes\./
  );
  assert.equal(sessions.get(roomLog).messages.length, 1);
  // The brief's turn ends: the result lands in the member session, never as a raw room row.
  const [{ options }] = submitted(h);
  options.onSettled({ status: 'done', result: { content: 'Report built.\n\n- 3 charts' } });
  for (let i = 0; i < 20 && pending.length < 2; i += 1) await settle();
  assert.equal(await Promise.all(pending).then((homes) => homes.at(-1)), member);
  await delivery.drain(member);
  assert.deepEqual(
    sessions.get(roomLog).messages.map((message) => message.meta.transcript.messageId),
    ['row_gh_1'],
    'the room log gets no report row'
  );
  assert.match(sessions.get(member).messages.at(-1).content, /<task-output session="sess_task_1" status="completed">/);
  // The member is woken to relay it: a turn in its room through the room host, not a hidden home turn.
  assert.equal(wakes.length, 0);
  assert.equal(relays.length, 1);
  assert.equal(relays[0][0], member);
  assert.match(relays[0][1], /Report built\.[\s\S]*Relay the report above to the user now/);
  assert.match(relays[0][2].id, /^awake_/);
  for (let i = 0; i < 5; i += 1) await settle();
  assert.deepEqual(await queue.wakes(member), { owed: [], batches: [], overflow: null }, 'the relay turn retired it');
  assert.deepEqual(await queue.items('sess_home_gh'), []);
  assert.deepEqual(await delivery.taskWatches(), [], 'the watch dropped once the report was queued');
  // A replayed report adds nothing.
  await delivery.drain(
    await delivery.enqueueTask('gh', {
      runId: `${options.id}_end`,
      taskSessionId: 'sess_task_1',
      title: 'Build the report',
      status: 'completed',
      text: 'Report built.',
      from: member,
    })
  );
  assert.equal(sessions.get(member).messages.length, 2);
  assert.equal(relays.length, 1, 'never relayed twice');
  // A later send from the room to a task its agent opened at home reports to the room.
  const stored = { taskOrigin: { agentId: 'gh', sessionId: 'sess_home_gh', title: 'T' } };
  const re = tasks(fakeService(), { loadSession: async () => stored });
  assert.equal((await re.api.reportOrigin('sess_task_9', 'gh', member)).sessionId, member);
});

test("a member's relay answered under another turn's id is found by that turn after a restart, never relayed twice", async (t) => {
  const member = roomMemberSessionId('abc123', 'gh');
  const thread = { id: member, messages: [], generation: 1 };
  const file = join(tempDir(t), 'routine-results.json');
  const relays = [];
  const boot = (roomRelay) =>
    createAgentHomeDelivery({
      loadSession: (id) => (id === member ? thread : null),
      saveSession: async () => {},
      turnInFlight: () => false,
      queue: createRoutineResultQueue(file),
      live: () => ({ busy: () => false, notice: () => {} }),
      retryLater: () => {},
      roomRelay,
      log: () => {},
    });
  // The room answers the relay in a turn under another id, and the process stops mid-turn.
  const first = boot(async (...args) => {
    relays.push(args);
    await args[2].follow('rturn_1');
    return { settled: new Promise(() => {}) };
  });
  await first.drain(
    await first.enqueueTask('gh', {
      runId: 'turn_1_end',
      taskSessionId: 'sess_task_1',
      title: 'Job',
      status: 'completed',
      text: 'built',
      from: member,
    })
  );
  assert.equal(relays.length, 1);
  thread.messages.push(promptRow('rturn_1'), replyRow('rturn_1', 'Relayed: built.'));
  const second = boot(async (...args) => {
    relays.push(args);
    return { settled: Promise.resolve('done') };
  });
  for (const homeId of await second.recover()) await second.drain(homeId);
  assert.equal(relays.length, 1, 'the answering turn retired the relay');
  assert.deepEqual(await createRoutineResultQueue(file).wakes(member), { owed: [], batches: [], overflow: null });
});

test('a report that cannot be queued is retried in-process, delivered once, and keeps its watch when every try fails', async () => {
  const run = async (failures) => {
    const submits = [];
    const delivered = [];
    const removed = [];
    let calls = 0;
    const tasks = createAgentTaskSessions({
      getSessionService: () => ({
        materializeSession: async () => ({ getState: () => ({}), subscribe: () => () => {} }),
        submitSession: async (params) => {
          submits.push(params);
          return { accepted: true };
        },
      }),
      deliver: async (agentId, report) => {
        calls += 1;
        if (calls <= failures) throw new Error('queue busy');
        delivered.push([agentId, report.runId]);
      },
      watches: { add: async () => {}, list: async () => [], remove: async (id) => removed.push(id) },
      loadSession: async () => null,
      retryDelaysMs: [0, 0, 0],
      // A task turn's end is its final answer at once here (no agent work, no quiet period).
      pendingWork: async () => false,
      settleMs: 0,
      log: () => {},
    });
    await tasks.send('sess_task_1', 'go', { agentId: 'a', sessionId: 'sess_home_a', title: 'T', notify: true });
    submits[0].options.onSettled({ status: 'done', result: { content: 'ok' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { calls, delivered, removed };
  };
  const once = await run(1);
  assert.equal(once.calls, 2);
  assert.equal(once.delivered.length, 1, 'exactly one report');
  const never = await run(99);
  assert.equal(never.calls, 4, 'one try and three retries');
  assert.deepEqual(never.delivered, []);
  assert.deepEqual(never.removed, [], 'the durable watch stays for restart recovery');
});
