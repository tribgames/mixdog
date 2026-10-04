import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTurnCompletionTracker,
  sessionsWithPendingWork,
  shouldShowTurnNotification,
} from './push-turn-events.ts';

const session = (id, overrides = {}) => ({
  id,
  title: `Session ${id}`,
  preview: `preview ${id}`,
  updatedAt: 0,
  messageCount: 2,
  cwd: 'C:/Project/mixdog',
  classification: 'task',
  projectPath: 'C:/Project/mixdog',
  ...overrides,
});

test('the first roster only establishes a baseline', () => {
  const tracker = createTurnCompletionTracker();
  assert.deepEqual(tracker.observe([session('a'), session('b')], 1_000), []);
});

test('a turn that stops records its start and never uses the roster preview as an answer', () => {
  const tracker = createTurnCompletionTracker();
  tracker.observe([session('a', { working: true })], 1_000);
  const completions = tracker.observe(
    [session('a', { working: false, title: 'Refactor relay', preview: 'Done: 3 files changed' })],
    2_000
  );
  assert.equal(completions.length, 1);
  assert.equal(completions[0].sessionId, 'a');
  assert.equal(completions[0].title, 'Refactor relay');
  assert.equal(completions[0].preview, '');
  assert.equal(completions[0].startedAt, 1_000);
});

test('a session that never started working is not announced', () => {
  const tracker = createTurnCompletionTracker();
  tracker.observe([session('a')], 1_000);
  assert.deepEqual(tracker.observe([session('a', { preview: 'edited' })], 2_000), []);
});

test('only schedule completions bypass foreground suppression', () => {
  for (const sourceType of [undefined, 'webhook', 'schedule']) {
    const tracker = createTurnCompletionTracker();
    tracker.observe([session('a', { sourceType, working: true })], 1_000);
    const [completion] = tracker.observe([session('a', { sourceType })], 2_000);
    assert.equal(completion.sourceType, sourceType);
    assert.equal(shouldShowTurnNotification(completion, true), sourceType === 'schedule');
    assert.equal(shouldShowTurnNotification(completion, false), true);
  }
});

test('child-agent work counts as the session still working', () => {
  const tracker = createTurnCompletionTracker();
  tracker.observe([session('a', { working: true, agentWorking: true })], 1_000);
  assert.deepEqual(tracker.observe([session('a', { working: false, agentWorking: true })], 2_000), []);
  assert.equal(tracker.observe([session('a', { working: false })], 3_000).length, 1);
});

test('a repeated idle roster does not announce the same finish twice', () => {
  const tracker = createTurnCompletionTracker();
  tracker.observe([session('a', { working: true })], 1_000);
  assert.equal(tracker.observe([session('a', { working: false })], 2_000).length, 1);
  assert.deepEqual(tracker.observe([session('a', { working: false, preview: 'edited' })], 3_000), []);
});

test('every real finish is announced, even one shortly after the previous', () => {
  const tracker = createTurnCompletionTracker();
  tracker.observe([session('a', { working: true })], 1_000);
  assert.equal(tracker.observe([session('a', { working: false })], 2_000).length, 1);
  tracker.observe([session('a', { working: true })], 3_000);
  assert.equal(tracker.observe([session('a', { working: false })], 4_000).length, 1);
});

const agentRow = (sessionId, ownerSessionId, overrides = {}) => ({
  tag: `worker:${sessionId}`,
  sessionId,
  ownerSessionId,
  agent: sessionId === ownerSessionId ? 'lead' : 'worker',
  provider: null,
  model: null,
  status: 'idle',
  stage: 'idle',
  startedAt: null,
  turnStartedAt: null,
  createdAt: null,
  updatedAt: null,
  cwd: null,
  clientHostPid: null,
  taskId: null,
  ...overrides,
});

test('pending work comes from running child agents only, not shell jobs or the Lead row status', () => {
  const pending = sessionsWithPendingWork([
    agentRow('child-1', 'a', { status: 'running', stage: 'running' }),
    agentRow('child-2', 'b', { status: 'queued', stage: 'queued' }),
    agentRow('c', 'c', { shellJobCount: 1 }),
    agentRow('child-c', 'c', { status: 'idle', stage: 'idle', shellJobCount: 2 }),
    agentRow('child-3', 'd', { status: 'idle', stage: 'idle' }),
    agentRow('e', 'e', { status: 'running', stage: 'running' }),
  ]);
  assert.deepEqual([...pending].sort(), ['a', 'b']);
});

test('a Lead that stops to wait on background work is not announced until the work settles', () => {
  const tracker = createTurnCompletionTracker();
  tracker.observe([session('a', { working: true })], 1_000);
  // Lead turn ended while its child agent still runs: an intermediate stop.
  assert.deepEqual(tracker.observe([session('a', { working: false })], 2_000, new Set(['a'])), []);
  assert.equal(tracker.isIdle('a'), false);
  // The job finished and woke the Lead for its final answer.
  tracker.observe([session('a', { working: true })], 3_000, new Set());
  const completions = tracker.observe([session('a', { working: false })], 4_000, new Set());
  assert.equal(completions.length, 1);
});

test('background work settling without a new Lead turn announces the answer already given', () => {
  const tracker = createTurnCompletionTracker();
  tracker.observe([session('a', { working: true })], 1_000);
  assert.deepEqual(tracker.observe([session('a', { working: false })], 2_000, new Set(['a'])), []);
  assert.equal(tracker.observe([session('a', { working: false })], 3_000, new Set()).length, 1);
});

test('an archived session stays silent', () => {
  const tracker = createTurnCompletionTracker();
  tracker.observe([session('a', { working: true })], 1_000);
  assert.deepEqual(tracker.observe([session('a', { working: false, archived: true })], 2_000), []);
});

test('idleness is reported for the quiet-period recheck', () => {
  const tracker = createTurnCompletionTracker();
  tracker.observe([session('a', { working: true })], 1_000);
  assert.equal(tracker.isIdle('a'), false);
  tracker.observe([session('a', { working: false })], 2_000);
  assert.equal(tracker.isIdle('a'), true);
  // A turn that resumed during the quiet period must cancel its notification.
  tracker.observe([session('a', { working: true })], 2_500);
  assert.equal(tracker.isIdle('a'), false);
});

test('a deleted session leaves no state behind and re-baselines if it returns', () => {
  const tracker = createTurnCompletionTracker();
  tracker.observe([session('a', { working: true })], 1_000);
  tracker.observe([], 2_000);
  assert.equal(tracker.isIdle('a'), false);
  assert.deepEqual(tracker.observe([session('a', { working: false })], 3_000), []);
});

test('several sessions finishing in one roster each get a completion', () => {
  const tracker = createTurnCompletionTracker();
  tracker.observe([session('a', { working: true }), session('b', { working: true })], 1_000);
  const completions = tracker.observe([session('a'), session('b')], 2_000);
  assert.deepEqual(completions.map((entry) => entry.sessionId).sort(), ['a', 'b']);
});
