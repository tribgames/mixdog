import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acknowledgePendingGoalReminder,
  markPendingGoalReminder,
  prependGoalReminderToLatestUserMessage,
  snapshotPendingGoalReminder,
} from './goal-reminder.mjs';
import { continuationPrompt, goalStateReminder, goalTaskLines } from './goal-text.mjs';

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

test('compaction preserves exact duration and elapsed time instead of losing the time commitment', () => {
  for (const status of ['active', 'paused']) {
    const session = { id: `sess_goal_time_${status}` };
    const current = goal({ status, timeLimitMs: 3_600_000, timeUsedMs: 615_000 });
    markPendingGoalReminder(session, 'compaction');
    const snapshot = snapshotPendingGoalReminder(session, { readGoal: () => current });
    for (const text of [snapshot.content, continuationPrompt(current)]) {
      assert.match(text, /Requested duration: 1h \(3600000 ms\)/);
      assert.match(text, /Time elapsed: 11m \(615000 ms\)/);
      assert.match(text, /Time remaining: 50m \(2985000 ms\)/);
    }
    assert.equal(snapshot.goal.status, status);
    assert.equal(snapshot.goal.timeLimitMs, 3_600_000);
  }
  const untimed = goal({ timeLimitMs: 0, timeUsedMs: 615_000 });
  for (const text of [goalStateReminder(untimed), continuationPrompt(untimed)]) {
    assert.match(text, /Duration: none/);
    assert.match(text, /Time elapsed: 11m \(615000 ms\)/);
    assert.doesNotMatch(text, /Requested duration:|Time remaining:/);
  }
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

test('a paused Goal reminder couples atomic resume to approved work, not messages alone', () => {
  const session = { id: 'sess_goal_reply' };
  markPendingGoalReminder(session, 'paused');
  const snapshot = snapshotPendingGoalReminder(session, {
    readGoal: () => goal({ status: 'paused' }),
  });
  assert.match(snapshot.content, /Call resume with any task changes in the same call only when continuing user-approved work/);
  assert.match(snapshot.content, /not for questions or notifications alone/);
  assert.match(snapshot.content, /abandon only if the user redirected away from this objective/);
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

test('request preparation finds a paused Goal without any intake marker and does not resume it', () => {
  const session = { id: 'sess_goal_cold_turn' };
  const paused = goal({ status: 'paused', revision: 7 });
  const before = structuredClone(paused);
  const snapshot = snapshotPendingGoalReminder(session, {
    includePaused: true, readGoal: () => paused,
  });
  assert.match(snapshot.content, /Status: paused/);
  assert.match(snapshot.content, /Revision: 7/);
  assert.equal(snapshot.reason, 'paused');
  assert.deepEqual(paused, before);
  acknowledgePendingGoalReminder(session, snapshot.revision);
  // Answering a question is not a resume. The next actual request still needs
  // the durable state even though the prior marker was acknowledged.
  const next = snapshotPendingGoalReminder(session, {
    includePaused: true, readGoal: () => paused,
  });
  assert.ok(next.revision > snapshot.revision);
  assert.deepEqual(paused, before);
});

test('request preparation uses current state when input precedes pause and stays quiet otherwise', () => {
  const session = { id: 'sess_goal_late_pause' };
  let current = goal();
  const options = { includePaused: true, readGoal: () => current };
  assert.equal(snapshotPendingGoalReminder(session, options), null);
  assert.equal(session.pendingGoalReminder, undefined);
  current = goal({ status: 'paused', revision: 9 });
  const snapshot = snapshotPendingGoalReminder(session, options);
  assert.match(snapshot.content, /Revision: 9/);
  assert.match(snapshot.content, /Status: paused/);
  // A marker must not describe an already-resumed Goal as paused.
  current = goal({ revision: 10 });
  const updated = snapshotPendingGoalReminder(session, options);
  assert.doesNotMatch(updated.content, /This Goal is paused/);
  acknowledgePendingGoalReminder(session, updated.revision);
  assert.equal(snapshotPendingGoalReminder(session, options), null);
});

test('compaction and objective reminders retain the current paused-state recovery guidance', () => {
  for (const reason of ['compaction', 'objective-updated']) {
    const session = { id: `sess_goal_${reason}` };
    markPendingGoalReminder(session, reason);
    const snapshot = snapshotPendingGoalReminder(session, {
      includePaused: true, readGoal: () => goal({ status: 'paused' }),
    });
    assert.equal(snapshot.reason, reason);
    assert.match(snapshot.content, /This Goal is paused/);
    assert.match(snapshot.content, /only when continuing user-approved work/);
  }
});
