import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentStatuslinePayload,
  classifyAgentWorkers,
} from '../src/ui/statusline-agents.mjs';

function runningWorkers(agentWorkers = [], agentJobs = []) {
  const payload = agentStatuslinePayload(agentWorkers, agentJobs);
  return {
    payload,
    running: classifyAgentWorkers(payload.workers).runningWorkers,
  };
}

test('terminal worker suppresses a stale running job with the same tag', () => {
  const { payload, running } = runningWorkers(
    [{ tag: 'worker-a', status: 'idle', stage: 'idle' }],
    [{ tag: 'worker-a', status: 'running', startedAt: 1000 }],
  );

  assert.equal(running.length, 0);
  assert.equal(payload.workers.length, 1);
  assert.equal(payload.workers[0].status, 'idle');
});

test('terminal state wins when worker stage and status frames conflict', () => {
  const { running } = runningWorkers([
    { tag: 'worker-a', stage: 'idle', status: 'running' },
    { tag: 'worker-b', stage: 'streaming', status: 'closed' },
  ]);

  assert.equal(running.length, 0);
});

test('queued jobs remain visible without an active worker', () => {
  const pureQueued = runningWorkers([], [
    { tag: 'worker-a', status: 'queued', startedAt: 1000 },
  ]);
  assert.deepEqual(pureQueued.running.map((entry) => entry.tag), ['worker-a']);
  assert.equal(pureQueued.running[0].status, 'queued');

  const queuedReuse = runningWorkers(
    [{ tag: 'worker-b', status: 'idle' }],
    [{ tag: 'worker-b', status: 'pending', startedAt: 2000 }],
  );
  assert.deepEqual(queuedReuse.running.map((entry) => entry.tag), ['worker-b']);
  assert.equal(queuedReuse.running[0].status, 'queued');
});

test('unknown states are hidden and cannot revive from a stale running job', () => {
  const unknownOnly = runningWorkers([
    { tag: 'worker-a', status: 'paused' },
  ]);
  assert.equal(unknownOnly.running.length, 0);

  const withStaleJob = runningWorkers(
    [{ tag: 'worker-b', status: 'paused' }],
    [{ tag: 'worker-b', status: 'running', startedAt: 1000 }],
  );
  assert.equal(withStaleJob.running.length, 0);
});
