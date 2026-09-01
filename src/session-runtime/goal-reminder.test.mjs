import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acknowledgePendingGoalReminder,
  markPendingGoalReminder,
  prependGoalReminderToLatestUserMessage,
  snapshotPendingGoalReminder,
} from './goal-reminder.mjs';
import { goalStateReminder, goalTaskLines } from './goal-text.mjs';

const goal = (overrides = {}) => ({
  id: 'goal_1',
  objective: 'Ship the verified result',
  status: 'active',
  tasks: [
    { id: 'task_1', text: 'Implement result', status: 'completed', kind: 'work' },
    { id: 'task_2', text: 'Verify  result', status: 'in_progress', kind: 'verification' },
  ],
  ...overrides,
});

test('post-compaction Goal reminder renders durable state once and clears on acceptance', () => {
  const session = { id: 'sess_goal_reminder' };
  // Ordinary turns carry no marker, so no Goal state is injected and no
  // stored Goal is read.
  assert.equal(snapshotPendingGoalReminder(session, { readGoal: () => goal() }), null);

  const pending = markPendingGoalReminder(session, 'compaction');
  const snapshot = snapshotPendingGoalReminder(session, { readGoal: () => goal() });
  assert.equal(snapshot.revision, pending.revision);
  assert.match(snapshot.content, /<goal_state>/);
  assert.match(snapshot.content, /Context was compacted/);
  assert.match(snapshot.content, /Objective: Ship the verified result/);
  assert.match(snapshot.content, /Status: active · tasks 1\/2/);
  assert.match(snapshot.content, /- \[x\] task_1 \(work\): Implement result/);
  assert.match(snapshot.content, /- \[~\] task_2 \(verification\): Verify result/);
  // Behaviour rules stay in the cached tool description; the injected block
  // carries state only.
  assert.doesNotMatch(snapshot.content, /set_tasks/);

  assert.equal(acknowledgePendingGoalReminder(session, snapshot.revision + 1), false);
  assert.ok(session.pendingGoalReminder);
  assert.equal(acknowledgePendingGoalReminder(session, snapshot.revision), true);
  assert.equal(snapshotPendingGoalReminder(session, { readGoal: () => goal() }), null);
});

test('a finished or missing Goal drops the pending reminder instead of re-reading it', () => {
  const finished = { id: 'sess_goal_reminder_done' };
  markPendingGoalReminder(finished);
  assert.equal(
    snapshotPendingGoalReminder(finished, { readGoal: () => goal({ status: 'complete' }) }),
    null,
  );
  assert.equal(finished.pendingGoalReminder, undefined);

  const missing = { id: 'sess_goal_reminder_missing' };
  markPendingGoalReminder(missing);
  assert.equal(snapshotPendingGoalReminder(missing, { readGoal: () => null }), null);
  assert.equal(missing.pendingGoalReminder, undefined);
});

test('an unfinished non-active Goal still renders so it survives compaction', () => {
  const session = { id: 'sess_goal_reminder_paused' };
  markPendingGoalReminder(session);
  const snapshot = snapshotPendingGoalReminder(session, {
    readGoal: () => goal({ status: 'paused' }),
  });
  assert.match(snapshot.content, /Status: paused/);
});

test('post-compact Goal state is prepended to the current user turn and leaves no next-turn reminder', () => {
  const session = { id: 'sess_goal_inline' };
  markPendingGoalReminder(session);
  const snapshot = snapshotPendingGoalReminder(session, { readGoal: () => goal() });
  const messages = prependGoalReminderToLatestUserMessage([
    { role: 'user', content: 'older compact handoff' },
    { role: 'assistant', content: 'recent answer' },
    { role: 'user', content: 'current instruction' },
  ], snapshot.content);
  acknowledgePendingGoalReminder(session, snapshot.revision);

  assert.equal(messages[0].content, 'older compact handoff');
  assert.match(messages[2].content, /<goal_state>/);
  assert.match(messages[2].content, /current instruction$/);
  assert.equal((JSON.stringify(messages).match(/<goal_state>/g) || []).length, 1);
  assert.equal(session.pendingGoalReminder, undefined);
});

test('Goal task lines carry mark, id, and kind for every task', () => {
  assert.deepEqual(goalTaskLines([]), ['- No durable tasks recorded yet.']);
  assert.deepEqual(
    goalTaskLines([{ id: 'task_9', text: 'Do <it>', status: 'pending', kind: 'work' }]),
    ['- [ ] task_9 (work): Do &lt;it&gt;'],
  );
  assert.equal(goalStateReminder(null), '');
});
