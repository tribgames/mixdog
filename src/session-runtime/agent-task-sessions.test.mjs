import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAgentTaskSessions, resolveTaskProject } from './agent-task-sessions.mjs';
import { createAgentHomeDelivery, createRoutineResultQueue } from './agent-home-delivery.mjs';
import { createSessionControl } from '../standalone/daemon-session-control.mjs';
import { createWorkspaceToolHandlers } from './internal-tool-executor/workspace-tools.mjs';
import { sessionOptions } from './session-create/session-options.mjs';
import { sessionOriginFields } from '../runtime/agent/orchestrator/session/manager/session-record.mjs';
import { restoreTranscriptItems } from '../runtime/agent/orchestrator/session/transcript-restore/restore.mjs';

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
  const api = createAgentTaskSessions({
    getSessionService: () => h.service,
    deliver: async (agentId, report) => delivered.push([agentId, report]),
    loadSession: async (id) => stored.get(id) || null,
    listProjects: async () => [{ name: 'mixdog', alias: null, path: '/repo/mixdog' }],
    newTaskDefault: async () => 'branch',
    modelRoute: async (ref) => ({ provider: 'test', model: ref }),
    log: () => {},
    ...overrides,
  });
  return { api, delivered, stored };
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
  for (const session of refused) await assert.rejects(run(session), /create belongs to an agent conversation/);
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
  assert.deepEqual(result, { session_id: 'sess_task_1', title: 'Read README.md', project: '/repo/mixdog' });
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
  assert.equal(opts.sourceName, 'agent:lead');
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
  const { api, delivered, stored } = tasks(h);
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

  // The agent's follow-up reports; the same send from anyone else does not.
  const execute = createSessionControl({ getSessionService: () => h.service, agentTasks: api });
  await execute(
    { action: 'send', session_id: taskId, prompt: 'and the second line?' },
    { callerSessionId: 'sess_home_lead', callerAgentId: 'lead' }
  );
  await execute(
    { action: 'send', session_id: taskId, prompt: 'from another agent' },
    { callerSessionId: 'sess_home_reviewer', callerAgentId: 'reviewer' }
  );
  await execute({ action: 'send', session_id: taskId, prompt: 'from a coding session' }, { callerSessionId: 'sess_c' });
  const [, followUp, foreign, coding] = submitted(h);
  assert.equal(typeof followUp.options.onSettled, 'function');
  assert.equal(foreign.options.onSettled, undefined);
  assert.equal(coding.options.onSettled, undefined);
  followUp.options.onSettled({ status: 'failed', error: 'provider down' });
  await settle();
  assert.deepEqual(delivered.at(-1)[1].status, 'failed');
  assert.equal(delivered.length, 4, "a user's own turns never report");
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
  assert.match(h.wakes[0][1], /Relay the task result above to the user now/);
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
