import assert from 'node:assert/strict';
import test from 'node:test';
import { hasAgentResponseResult } from '../../runtime/shared/tool-card-model/agent-surface.mjs';
import { parseAgentJob } from '../../tui/session/agent-envelope.mjs';
import { createAgentExecute } from './execute.mjs';
import { renderResult } from './render.mjs';

const common = {
  agent: 'worker',
  provider: 'openai',
  model: 'gpt-5',
  clientHostPid: 777,
  windowTokens: 1234,
  windowCap: 10000,
  silent_for: 12,
  watchdog: 'healthy',
  diagnostic: 'worker is making progress',
  queued_followups: 0,
};
const workers = [
  {
    ...common,
    tag: 'alpha',
    sessionId: 'sess_alpha',
    status: 'running',
    worker_stage: 'tool',
    last_progress: 'read render.mjs',
  },
  {
    ...common,
    tag: 'beta',
    sessionId: 'sess_beta',
    status: 'running',
    worker_stage: 'streaming',
    last_progress: 'writing compact renderer',
  },
  {
    ...common,
    tag: 'gamma',
    sessionId: 'sess_gamma',
    status: 'running',
    worker_stage: 'testing',
    last_progress: 'running targeted agent contracts to verify compact list output and status diagnostics',
  },
];
const jobs = workers.map((worker, index) => ({
  ...worker,
  task_id: `task_${worker.tag}`,
  type: index === 1 ? 'send' : 'spawn',
  status: ['running', 'completed', 'failed'][index],
  error: index === 2 ? 'contract failed' : null,
}));
const compactList = [
  'agents: 3 · tasks: 3',
  '- alpha  running/tool  read render.mjs',
  '- beta  running/streaming  writing compact renderer',
  '- gamma  running/testing  running targeted agent contracts to verify compact list out…',
  '- task_alpha  spawn  running  alpha',
  '- task_beta  send  completed  beta',
  '- task_gamma  spawn  failed  gamma error=contract failed',
].join('\n');

test('list renders three workers and tasks compactly without becoming an agent response card', () => {
  const text = renderResult({ workers, jobs });
  assert.equal(text, compactList);
  assert.equal(hasAgentResponseResult(text), false);
  assert.equal(parseAgentJob(text), null);
});

test('list keeps progress and failed errors on one line, bounds progress, and never falls back to session ids', () => {
  const text = renderResult({
    workers: [
      { tag: 'edge', status: 'idle', worker_stage: 'idle', last_progress: 'x'.repeat(60) },
      { tag: 'long', status: 'running', stage: 'tool', last_progress: 'x'.repeat(61) },
      { tag: 'blank', last_progress: ' \n ' },
      { tag: 'multiline', status: 'running', last_progress: ' read\n  render.mjs\t now ' },
    ],
    jobs: [
      { task_id: 'task_no_tag', type: 'send', status: 'failed', sessionId: 'sess_hidden', error: ' timeout\n  waiting ' },
      { task_id: 'task_done', type: 'spawn', status: 'completed', tag: 'edge', error: 'stale error' },
    ],
  });
  assert.equal(text, [
    'agents: 4 · tasks: 2',
    `- edge  idle  ${'x'.repeat(60)}`,
    `- long  running/tool  ${'x'.repeat(59)}…`,
    '- blank  idle',
    '- multiline  running  read render.mjs now',
    '- task_no_tag  send  failed  - error=timeout waiting',
    '- task_done  spawn  completed  edge',
  ].join('\n'));
  assert.equal(hasAgentResponseResult(text), false);
});

test('empty and one-sided lists retain stable count headers', () => {
  for (const value of [{ workers: [] }, { jobs: [] }, { workers: [], jobs: [] }]) {
    const text = renderResult(value);
    assert.equal(text, 'agents: 0 · tasks: 0\n(no agents or tasks)');
    assert.equal(hasAgentResponseResult(text), false);
  }
  assert.equal(renderResult({ workers: [{ tag: 'alpha', status: 'running' }] }), 'agents: 1 · tasks: 0\n- alpha  running');
  assert.equal(
    renderResult({ jobs: [{ task_id: 'task_alpha', type: 'spawn', status: 'running', tag: 'alpha' }] }),
    'agents: 0 · tasks: 1\n- task_alpha  spawn  running  alpha'
  );
});

function executeWithViews(views) {
  return createAgentExecute({
    mgr: {},
    awaitKeychainPrewarm: async () => {},
    registry: { wantsSessionScan: () => false },
    views,
  });
}

test('list and targetless status use the same compact scoped overview', async () => {
  const context = { callerSessionId: 'lead' };
  const execute = executeWithViews({
    list: (options) => {
      assert.deepEqual(options, { scanSessions: false, context });
      return workers;
    },
    listJobs: (scope) => {
      assert.equal(scope, context);
      return jobs;
    },
  });
  assert.equal(await execute({ type: 'list' }, context), compactList);
  assert.equal(await execute({ type: 'status' }, context), compactList);
  assert.equal(await execute({ type: 'status', tag: ' ' }, context), compactList);
});

test('targeted status retains full diagnostics for running and failed jobs', async () => {
  const job = {
    ...jobs[0],
    effort: 'high',
    fast: true,
    workerStatus: 'streaming',
    stage: 'tool',
    startedAt: '2026-01-01T00:00:00.000Z',
  };
  const execute = executeWithViews({
    getJobOrWorker: (args) => {
      assert.ok(args.tag === 'alpha' || args.task_id === 'task_alpha' || args.sessionId === 'sess_alpha');
      return job;
    },
    renderJob: (value, includeResult) => {
      assert.equal(includeResult, false);
      return value;
    },
  });
  for (const target of [{ tag: 'alpha' }, { task_id: 'task_alpha' }, { sessionId: 'sess_alpha' }]) {
    const text = await execute({ type: 'status', ...target });
    for (const line of [
      'agent task: task_alpha',
      'status: running',
      'type: spawn',
      'target: alpha sess_alpha',
      'agent: worker',
      'model: openai/gpt-5',
      'effort: high',
      'fast: on',
      'worker: streaming/tool',
      'worker_stage: tool',
      'last_progress: read render.mjs',
      'silent_for: 12s',
      'watchdog: healthy',
      'queued_followups: 0',
      'diagnostic: worker is making progress',
      'started: 2026-01-01 00:00:00Z',
    ]) {
      assert.ok(text.split('\n').includes(line), `missing status line: ${line}`);
    }
    assert.match(text, /^elapsed: .+ \(running\)$/m);
    assert.equal(parseAgentJob(text).taskId, 'task_alpha');
  }
  job.status = 'failed';
  job.finishedAt = '2026-01-01T00:00:01.000Z';
  job.error = 'contract failed';
  const failed = await execute({ type: 'status', tag: 'alpha' });
  assert.match(failed, /^finished: 2026-01-01 00:00:01Z$/m);
  assert.match(failed, /^elapsed: .+$/m);
  assert.match(failed, /^error: contract failed$/m);
  assert.doesNotMatch(failed, /^notification:/m);
});

test('spawn/send acknowledgements and read results retain their existing envelopes', async () => {
  for (const type of ['spawn', 'send']) {
    const job = { ...jobs[0], type, effort: 'high', fast: true, startedAt: '2026-01-01T00:00:00.000Z' };
    const ack = [
      'agent task: task_alpha',
      'status: running',
      `type: ${type}`,
      'target: alpha sess_alpha',
      'notification: completion will be delivered; end the turn.',
    ].join('\n');
    assert.equal(renderResult(job), ack);
    const execute = executeWithViews({
      getJobOrWorker: () => job,
      renderJob: (value, includeResult) => {
        assert.equal(includeResult, true);
        return { ...value, result: 'partial output' };
      },
    });
    assert.equal(await execute({ type: 'read', task_id: 'task_alpha' }), `${ack}\n\npartial output`);
  }
  assert.equal(
    renderResult({ queued: true, tag: 'alpha', sessionId: 'sess_alpha', agent: 'worker', queueDepth: 2 }),
    'agent message queued\ntarget: alpha sess_alpha\nagent: worker\nqueueDepth: 2'
  );
});

test('close and cancel acknowledgements retain their existing envelopes', () => {
  assert.equal(
    renderResult({ closed: true, tag: 'alpha', sessionId: 'sess_alpha', forgotten: true }),
    'agent close: ok\ntag: alpha\nsessionId: sess_alpha\nforgotten: true'
  );
  assert.equal(
    renderResult({ task_id: 'task_alpha', type: 'cancel', status: 'cancelled', tag: 'alpha' }),
    'agent task: task_alpha\nstatus: cancelled\ntype: cancel\ntarget: alpha'
  );
  assert.equal(
    renderResult({ task_id: 'task_alpha', type: 'close', tag: 'alpha' }),
    'agent task: task_alpha\ntype: close\ntarget: alpha'
  );
});
