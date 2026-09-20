import assert from 'node:assert/strict';
import test from 'node:test';
import { completeBackgroundTask, registerBackgroundTask } from '../../runtime/shared/background-tasks.mjs';
import { createJobViews } from './job-views.mjs';

// The read-only job/session views over a fake session manager and the real
// background-task registry: the /agents list and its active filter, job rows
// (live vs frozen terminal), task lookup with the worker fallback, render
// shaping, spawn meta builders, and the busy check.

function fakeMgr(sessions) {
  return {
    getSession: (id) => sessions.get(id) || null,
    getSessionRuntime: (id) => sessions.get(id)?.runtime || null,
    getSessionProgressSnapshot: (id) => sessions.get(id)?.snapshot || null,
    getSessionPendingMessageDepth: (id) => sessions.get(id)?.pendingDepth ?? null,
  };
}

function views({ sessions = new Map(), tags = new Map(), entries = [] } = {}) {
  const refreshes = [];
  const api = createJobViews({
    mgr: fakeMgr(sessions),
    getLiveSession: (id) => sessions.get(id) || null,
    reg: { getProvider: () => null },
    DEFAULT_SPAWN_PREP_TIMEOUT_MS: 1000,
    refreshTagsFromSessions: (options) => refreshes.push(options),
    agentSessionEntries: () => entries,
    tags,
    cfgMod: { loadConfig: () => ({}) },
  });
  return { api, refreshes };
}

const session = (id, overrides = {}) => ({
  id,
  agent: 'worker',
  provider: 'openai',
  model: 'gpt-5',
  createdAt: '2026-01-01T00:00:00.000Z',
  messages: [{ role: 'user', content: 'go' }],
  tools: [],
  ...overrides,
});

test('list projects agent sessions and keeps only rows that can still do work unless terminal rows are asked for', () => {
  const streaming = session('s-streaming', {
    status: 'streaming',
    runtime: { stage: 'streaming', lastStreamDeltaAt: Date.now() - 2000 },
  });
  const idle = session('s-idle', { status: 'idle' });
  const closed = session('s-closed', { closed: true, status: 'streaming' });
  const sessions = new Map([
    ['s-streaming', streaming],
    ['s-idle', idle],
    ['s-closed', closed],
  ]);
  const { api, refreshes } = views({
    sessions,
    entries: [
      { tag: 'a', session: streaming },
      { tag: 'b', session: idle },
      { tag: 'c', session: closed },
    ],
  });
  const active = api.list({ scanSessions: true, context: { callerSessionId: 'lead' } });
  assert.deepEqual(refreshes, [{ scanSessions: true, context: { callerSessionId: 'lead' } }]);
  assert.deepEqual(
    active.map((row) => [row.tag, row.status, row.stage]),
    [['a', 'streaming', 'streaming']]
  );
  assert.equal(active[0].messages, 1);
  assert.equal(active[0].staleSeconds, 2);
  assert.equal(typeof active[0].worker_stage, 'string');
  const all = api.list({ includeTerminal: true });
  assert.deepEqual(
    all.map((row) => [row.tag, row.status, row.stage]),
    [
      ['a', 'streaming', 'streaming'],
      ['b', 'idle', 'idle'],
      ['c', 'closed', 'closed'],
    ]
  );
});

test('job rows read live progress for running tasks and freeze terminal ones; lookup accepts task id, tag or session', () => {
  const live = session('jv-s-run', { status: 'streaming', runtime: { stage: 'streaming' }, clientHostPid: 777 });
  const { api } = views({ sessions: new Map([['jv-s-run', live]]) });
  const running = registerBackgroundTask({
    surface: 'agent',
    operation: 'spawn',
    meta: { tag: 'jv-run', sessionId: 'jv-s-run', agent: 'worker', provider: 'openai', model: 'gpt-5' },
    input: { tag: 'jv-run' },
  });
  const done = registerBackgroundTask({
    surface: 'agent',
    operation: 'spawn',
    startedAtMs: Date.now() - 60_000,
    meta: { tag: 'jv-done', sessionId: 'jv-s-run', agent: 'worker' },
  });
  completeBackgroundTask(done.taskId, { status: 'completed', result: 'finished', notify: false });

  const rows = api.listJobs().filter((row) => ['jv-run', 'jv-done'].includes(row.tag));
  const runRow = rows.find((row) => row.tag === 'jv-run');
  const doneRow = rows.find((row) => row.tag === 'jv-done');
  assert.equal(runRow.workerStatus, 'streaming');
  assert.equal(runRow.clientHostPid, 777);
  assert.equal(runRow.type, 'spawn');
  assert.equal(doneRow.workerStatus, 'completed', 'a finished job never re-reads the reused live session');
  assert.equal(doneRow.stage, 'completed');
  assert.equal(doneRow.clientHostPid, null);

  assert.equal(
    api.listJobs({ clientHostPid: 777 }).some((row) => row.tag === 'jv-run'),
    true
  );
  assert.equal(
    api.listJobs({ clientHostPid: 778 }).some((row) => row.tag === 'jv-run'),
    false
  );

  assert.equal(api.getJob({ task_id: running.taskId }), running);
  assert.equal(api.getJob({ tag: 'jv-run' }), running);
  assert.equal(api.getJob({ sessionId: 'jv-s-run' }), running, 'the most recently started task wins a shared session');
  assert.throws(() => api.getJob({ tag: 'jv-missing' }), /no task found for tag\/sessionId "jv-missing"/);
  assert.throws(() => api.getJob({}), /task_id, tag, or sessionId is required/);

  const rendered = api.renderJob(running, true);
  assert.equal(rendered.task_id, running.taskId);
  assert.equal(rendered.tag, 'jv-run');
  assert.equal(rendered.workerStatus, 'streaming');
  assert.equal('result' in rendered, false, 'an unfinished job has no result yet');
  const frozen = api.renderJob(done, true);
  assert.equal(frozen.result, 'finished');
  assert.equal(frozen.stage, 'completed');
  assert.equal(frozen.clientHostPid, null);

  const spawning = api.renderJob({ taskId: 't', operation: 'spawn', status: 'running', meta: { tag: 'x' } });
  assert.equal(spawning.worker_stage, 'spawning');
  assert.equal(spawning.diagnostic, 'worker session not started yet');
  const respawned = api.renderJob({ taskId: 't', operation: 'spawn', status: 'completed', meta: { respawned: true } });
  assert.equal(respawned.respawned, true);
  assert.match(respawned.note, /previous session reaped/);
});

test('a worker session without a task answers read/status with a synthetic job built from its last assistant output', () => {
  const worker = session('jv-s-worker', {
    status: 'idle',
    presetName: 'fast',
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'done: 42' },
      { role: 'assistant', content: '   ' },
    ],
  });
  const silent = session('jv-s-silent', { status: 'idle', messages: [], lastHandoff: 'handoff text' });
  const { api, refreshes } = views({
    sessions: new Map([
      ['jv-s-worker', worker],
      ['jv-s-silent', silent],
    ]),
    tags: new Map([['jv-worker', 'jv-s-worker']]),
  });
  const job = api.getJobOrWorker({ tag: 'jv-worker' });
  assert.deepEqual(refreshes.at(-1), { scanSessions: true, context: {} });
  assert.equal(job.operation, 'worker');
  assert.equal(job.taskId, null);
  assert.equal(job.status, 'idle');
  assert.equal(job.result, 'done: 42');
  assert.equal(job.startedAt, worker.createdAt);
  assert.deepEqual(job.meta, {
    tag: 'jv-worker',
    sessionId: 'jv-s-worker',
    agent: 'worker',
    preset: 'fast',
    provider: 'openai',
    model: 'gpt-5',
    effort: null,
    fast: false,
  });
  assert.equal(api.workerFallbackJob('jv-s-silent').result, 'handoff text');
  assert.equal(api.workerFallbackJob('jv-s-silent').meta.tag, null);
  silent.lastHandoff = '';
  assert.equal(api.workerFallbackJob('jv-s-silent').result, '(worker session has no assistant output yet)');
  assert.equal(api.workerFallbackJob('nobody'), null);
  assert.throws(() => api.getJobOrWorker({ tag: 'nobody' }), /no task found/);
});

test('spawn meta builders, meta merge and the busy check', () => {
  const busy = { id: 'b', runtime: { controller: { signal: { aborted: false } } } };
  const aborted = { id: 'a', runtime: { controller: { signal: { aborted: true } }, stage: 'idle' } };
  const noRuntime = { id: 'n', status: 'streaming' };
  const { api } = views({
    sessions: new Map([
      ['b', busy],
      ['a', aborted],
      ['n', noRuntime],
    ]),
  });
  assert.equal(api.isSessionBusy('b'), true);
  assert.equal(api.isSessionBusy('a'), false);
  assert.equal(api.isSessionBusy('n'), true);
  assert.equal(api.isSessionBusy('missing'), false);

  const pending = api.pendingSpawnMeta(
    { agent: 'worker', provider: 'openai', model: 'gpt-5', tag: ' t1 ', fast: true },
    { note: 'x' }
  );
  assert.equal(pending.tag, 't1');
  assert.equal(pending.sessionId, null);
  assert.equal(pending.provider, 'openai');
  assert.equal(pending.model, 'gpt-5');
  assert.equal(pending.fast, true);
  assert.equal(pending.note, 'x');
  assert.equal(api.pendingSpawnMeta({}).fast, null);

  const prepared = api.preparedSpawnMeta({
    tag: 't2',
    session: { id: 's2' },
    agent: 'worker',
    presetName: 'named',
    preset: { provider: 'anthropic', model: 'claude', effort: 'high', fast: true },
  });
  assert.equal(prepared.tag, 't2');
  assert.equal(prepared.sessionId, 's2');
  assert.equal(prepared.provider, 'anthropic');
  assert.equal(prepared.model, 'claude');
  assert.equal(prepared.effort, 'high');
  assert.equal(prepared.fast, true);
  assert.equal(typeof prepared.preset, 'string');

  const job = { meta: { tag: 'old', agent: 'worker' }, input: { tag: 'old', sessionId: null }, label: 'old' };
  api.mergeJobMeta(job, { tag: 'new', sessionId: 's9' });
  assert.equal(job.meta.tag, 'new');
  assert.equal(job.meta.sessionId, 's9');
  assert.equal(job.meta.agent, 'worker');
  assert.deepEqual(job.input, { tag: 'new', sessionId: 's9', agent: 'worker' });
  assert.equal(job.label, 'new');
  api.mergeJobMeta(null, { tag: 'ignored' });
});
