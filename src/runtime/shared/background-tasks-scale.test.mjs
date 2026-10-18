import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeBackgroundTaskSessionIds,
  cancelBackgroundTasks,
  completeBackgroundTask,
  hasActiveBackgroundTasks,
  registerBackgroundTask,
} from './background-tasks.mjs';
import { createBusyTracker } from '../../standalone/session-service/retention/busy.mjs';

test('one task pass answers every session exactly as the per-session check does', (t) => {
  t.after(() => cancelBackgroundTasks({ notify: false }));
  registerBackgroundTask({ surface: 'shell', context: { callerSessionId: 'sess_a' } });
  registerBackgroundTask({ surface: 'agent', context: { routingSessionId: 'sess_b' } });
  const detached = registerBackgroundTask({ surface: 'shell', context: { callerSessionId: 'sess_c' } });
  detached.detached = true;
  const done = registerBackgroundTask({ surface: 'shell', context: { callerSessionId: 'sess_d' } });
  completeBackgroundTask(done.taskId, { status: 'completed', notify: false });
  // Attributed to a host process only: never counted for a session.
  registerBackgroundTask({ surface: 'shell', context: { clientHostPid: 4242 } });
  for (const options of [{}, { surface: 'shell' }, { surface: 'shell', awaitedOnly: true }, { awaitedOnly: true }]) {
    const ids = activeBackgroundTaskSessionIds(options);
    for (const sessionId of ['sess_a', 'sess_b', 'sess_c', 'sess_d', 'sess_none']) {
      assert.equal(
        ids.has(sessionId),
        hasActiveBackgroundTasks({ ...options, callerSessionId: sessionId }),
        `${sessionId} ${JSON.stringify(options)}`
      );
    }
  }
  assert.deepEqual([...activeBackgroundTaskSessionIds()].sort(), ['sess_a', 'sess_b', 'sess_c']);
});

// The daemon's owner heartbeat, telemetry and status count busy sessions
// every few seconds. Counting by one task scan per session (each also a full
// prune) blocked the event loop for 12.4 s in a profile taken under heavy
// agent load; the count is one task scan now.
test('a busy count over thousands of sessions and running tasks stays one task scan', (t) => {
  t.after(() => cancelBackgroundTasks({ notify: false }));
  const sessions = Array.from({ length: 5000 }, (_, i) => ({ sessionId: `sess_${i}`, busy: i === 1 }));
  for (let i = 0; i < 5000; i += 1) {
    registerBackgroundTask({ surface: 'shell', context: { callerSessionId: `sess_${(i * 2) % 5000}` } });
  }
  const tracker = createBusyTracker({ sessions, currentSessionId: (entry) => entry.sessionId });
  const startedAt = performance.now();
  const busy = tracker.liveBusyCount();
  const elapsedMs = performance.now() - startedAt;
  // Every even session has a running task; sess_1 runs a turn.
  assert.equal(busy, 2501);
  assert.ok(elapsedMs < 1000, `busy count took ${Math.round(elapsedMs)}ms`);
  assert.equal(tracker.sessionBusy(sessions[2]), true);
  assert.equal(tracker.sessionBusy(sessions[3]), false);
});
