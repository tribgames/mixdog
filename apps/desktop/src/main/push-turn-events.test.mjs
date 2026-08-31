import assert from 'node:assert/strict';
import test from 'node:test';

import { createTurnCompletionTracker } from './push-turn-events.ts';

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

test('a turn that stops produces one completion carrying the session preview', () => {
  const tracker = createTurnCompletionTracker();
  tracker.observe([session('a', { working: true })], 1_000);
  const completions = tracker.observe([
    session('a', { working: false, title: 'Refactor relay', preview: 'Done: 3 files changed' }),
  ], 2_000);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].sessionId, 'a');
  assert.equal(completions[0].title, 'Refactor relay');
  assert.equal(completions[0].preview, 'Done: 3 files changed');
});

test('a session that never started working is not announced', () => {
  const tracker = createTurnCompletionTracker();
  tracker.observe([session('a')], 1_000);
  assert.deepEqual(tracker.observe([session('a', { preview: 'edited' })], 2_000), []);
});

test('child-agent work counts as the session still working', () => {
  const tracker = createTurnCompletionTracker();
  tracker.observe([session('a', { working: true, agentWorking: true })], 1_000);
  assert.deepEqual(tracker.observe([session('a', { working: false, agentWorking: true })], 2_000), []);
  assert.equal(tracker.observe([session('a', { working: false })], 3_000).length, 1);
});

test('repeated stop reports within a minute notify once', () => {
  const tracker = createTurnCompletionTracker();
  tracker.observe([session('a', { working: true })], 1_000);
  assert.equal(tracker.observe([session('a', { working: false })], 2_000).length, 1);
  tracker.observe([session('a', { working: true })], 3_000);
  assert.deepEqual(tracker.observe([session('a', { working: false })], 4_000), []);
  tracker.observe([session('a', { working: true })], 70_000);
  assert.equal(tracker.observe([session('a', { working: false })], 80_000).length, 1);
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
