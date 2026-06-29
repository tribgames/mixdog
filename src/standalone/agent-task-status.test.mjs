import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendAgentProgressKv,
  buildAgentTaskProgressFields,
  resolveSilentForSeconds,
} from './agent-task-status.mjs';

test('waiting for first activity explains silence', () => {
  const now = 1_000_000;
  const fields = buildAgentTaskProgressFields({
    now,
    sessionStatus: 'running',
    runtimeStage: 'requesting',
    snapshot: {
      stage: 'requesting',
      waitingForFirstActivity: true,
      modelRequestStartedAt: now - 12_000,
      askStartedAt: now - 12_000,
      lastProgressAt: now - 12_000,
    },
    policy: { firstResponseMs: 120_000, idleStaleMs: 1_800_000, toolRunningMs: 600_000 },
    taskStatus: 'running',
  });
  assert.equal(fields.last_progress, 'awaiting first model response');
  assert.match(fields.diagnostic, /waiting for first response/);
  assert.match(fields.watchdog, /first=120s/);
});

test('streaming without recent deltas is called out', () => {
  const now = 2_000_000;
  const fields = buildAgentTaskProgressFields({
    now,
    sessionStatus: 'running',
    runtimeStage: 'streaming',
    snapshot: {
      stage: 'streaming',
      waitingForFirstActivity: false,
      lastStreamDeltaAt: now - 23_000,
      lastProgressAt: now - 23_000,
    },
    taskStatus: 'running',
  });
  assert.match(fields.last_progress, /no stream delta for 23s/);
  assert.match(fields.diagnostic, /no visible output yet \(23s\)/);
  assert.equal(fields.silent_for, 23);
});

test('queued follow-ups surface on idle worker', () => {
  const fields = buildAgentTaskProgressFields({
    sessionStatus: 'idle',
    runtimeStage: 'streaming',
    queuedFollowups: 2,
    taskStatus: 'running',
  });
  assert.equal(fields.queued_followups, 2);
  assert.match(fields.diagnostic, /2 follow-ups queued/);
});

test('resolveSilentForSeconds uses latest progress signal', () => {
  const now = 10_000;
  const silent = resolveSilentForSeconds(now, { lastProgressAt: now - 5_000 }, { lastStreamDeltaAt: now - 9_000 });
  assert.equal(silent, 5);
});

test('appendAgentProgressKv keeps base line first', () => {
  const line = appendAgentProgressKv('- job1 spawn running', {
    worker_stage: 'streaming',
    silent_for: 4,
    diagnostic: 'streaming',
  });
  assert.match(line, /^- job1 spawn running /);
  assert.match(line, /stage=streaming/);
  assert.match(line, /hint=streaming/);
});

