import assert from 'node:assert/strict';
import test from 'node:test';
import { agentStatuslinePayload, classifyAgentWorkers } from './statusline-agents.mjs';

test('a live worker stays authoritative over its own spawn job', () => {
  const payload = agentStatuslinePayload(
    [{ tag: 'worker-a', status: 'streaming', startedAt: 1000 }],
    [{ tag: 'worker-a', status: 'running', task_id: 'task-1' }]
  );
  assert.equal(payload.workers.length, 1);
  assert.equal(payload.workers[0].status, 'running');
  assert.equal(payload.workers[0].taskId, undefined);
  assert.deepEqual(payload.sessions.roles, ['worker-a']);
});

test('a queued job replaces an idle worker until the new worker starts', () => {
  const payload = agentStatuslinePayload(
    [{ tag: 'worker-b', status: 'idle' }],
    [{ tag: 'worker-b', status: 'queued', task_id: 'task-2' }]
  );
  assert.equal(payload.workers.length, 1);
  assert.equal(payload.workers[0].status, 'queued');
  assert.equal(payload.workers[0].taskId, 'task-2');
  assert.deepEqual(payload.sessions.roles, ['worker-b']);
});

test('terminal jobs leave the worker list and stay ordered newest first', () => {
  const payload = agentStatuslinePayload(
    [],
    [
      { tag: 'a', status: 'done', startedAt: 1, finishedAt: 100 },
      { tag: 'b', status: 'error', startedAt: 1, finishedAt: 300 },
    ]
  );
  assert.equal(payload.workers.length, 0);
  assert.deepEqual(
    payload.finishedJobs.map((job) => job.tag),
    ['b', 'a']
  );
  assert.equal(payload.finishedJobs[0].finalStatus, 'error');
});

test('maintenance agents are labelled once and idle workers drop out', () => {
  const { maintenance, runningWorkers } = classifyAgentWorkers([
    { tag: 'cycle1:1', agent: 'cycle1-agent', status: 'running' },
    { tag: 'cycle1:2', agent: 'cycle1-agent', status: 'running' },
    { tag: 'cycle2:1', agent: 'cycle2-agent', status: 'running' },
    { tag: 'worker-c', status: 'running' },
    { tag: 'worker-d', status: 'idle' },
  ]);
  assert.equal(maintenance.length, 2);
  assert.match(maintenance[0], /cycle1/);
  assert.match(maintenance[1], /cycle2/);
  assert.deepEqual(
    runningWorkers.map((worker) => worker.tag),
    ['worker-c']
  );
});
