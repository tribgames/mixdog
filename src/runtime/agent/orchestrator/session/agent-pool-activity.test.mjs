// The Agents pool's waiting state: a turn in `task wait` and an idle agent
// with a handed-off background task read `awaitingTask`, and every transition
// pulses the activity signal the desktop pool refresh listens to.
import assert from 'node:assert/strict';
import test from 'node:test';

import { withTurnProgress } from './agent-pool-progress.mjs';
import { runtimeState, isTurnInFlight } from './manager/runtime-state.mjs';
import { beginSessionTaskWait, markSessionAskStart, markSessionDone } from './manager/runtime-liveness.mjs';
import { onSessionActivityChange } from '../../../shared/session-activity-signal.mjs';
import { completeBackgroundTask, registerBackgroundTask } from '../../../shared/background-tasks.mjs';

const pool = (id, hasRunningTasks = () => false) =>
  withTurnProgress(
    [{ sessionId: id, agent: 'lead', status: 'running' }],
    (sid) => runtimeState.get(sid),
    isTurnInFlight,
    hasRunningTasks
  )[0];

test('task wait marks the in-flight row waiting and releases it on resume; transitions pulse the signal', () => {
  const id = 'sess_pool_wait';
  const pulses = [];
  const stop = onSessionActivityChange((sid) => pulses.push(sid));
  try {
    markSessionAskStart(id);
    runtimeState.get(id).controller = new AbortController();
    assert.equal(pool(id).awaitingTask, undefined);
    const release = beginSessionTaskWait(id);
    assert.equal(pool(id).awaitingTask, 'wait');
    release();
    release();
    assert.equal(pool(id).awaitingTask, undefined, 'resumed: running again');
    assert.ok(pulses.filter((sid) => sid === id).length >= 3, 'ask start, wait begin, wait end');
    runtimeState.get(id).controller = null;
    markSessionDone(id);
    assert.equal(pool(id).awaitingTask, undefined);
    assert.equal(pool(id, (sid) => sid === id).awaitingTask, 'background', 'idle with a handed-off task');
  } finally {
    stop();
    runtimeState.delete(id);
  }
});

test('handing off and finishing a background task pulse the signal for its owner', () => {
  const pulses = [];
  const stop = onSessionActivityChange((sid) => pulses.push(sid));
  try {
    const task = registerBackgroundTask({ surface: 'shell', context: { callerSessionId: 'sess_pool_owner' } });
    completeBackgroundTask(task.taskId, { status: 'completed', notify: false });
    assert.deepEqual(pulses, ['sess_pool_owner', 'sess_pool_owner']);
  } finally {
    stop();
  }
});

test('a woken in-flight row takes its turn start from the runtime, not the previous turn or a missing stamp', () => {
  const id = 'sess_pool_origin';
  try {
    markSessionAskStart(id);
    runtimeState.get(id).controller = new AbortController();
    const askAt = runtimeState.get(id).askStartedAt;
    const hourAgo = new Date(askAt - 3_600_000).toISOString();
    const start = (turnStartedAt) =>
      withTurnProgress(
        [{ sessionId: id, agent: 'lead', status: 'running', turnStartedAt }],
        (sid) => runtimeState.get(sid),
        isTurnInFlight
      )[0].turnStartedAt;
    assert.equal(start(hourAgo), new Date(askAt).toISOString());
    assert.equal(start(null), new Date(askAt).toISOString());
    const later = new Date(askAt + 5).toISOString();
    assert.equal(start(later), later);
  } finally {
    runtimeState.delete(id);
  }
});
