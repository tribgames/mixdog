import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// The first reap of the process: the lazily loaded shell-jobs module has not
// resolved when the handoff classifies the stopped jobs. A promoted job that
// still runs must be reported as still stopping, never as stopped.
mock.module('../../tools/builtin/shell-jobs.mjs', {
  namedExports: { isShellJobRunning: (id) => id === 'first_reap_running' },
});
const { armTurnShellReap, takeStoppedShellJobs } = await import('./turn-reap.mjs');
const { registerBackgroundTask, cancelBackgroundTasks } = await import('../../../../shared/background-tasks.mjs');

const job = (sessionId, taskId) =>
  registerBackgroundTask({
    taskId,
    surface: 'shell',
    operation: 'shell',
    label: taskId,
    context: { callerSessionId: sessionId, routingSessionId: sessionId },
    cancel() {},
  });

test('on the first reap a still-running promoted job is still stopping, not stopped', async () => {
  const sessionId = 'first_reap_session';
  job(sessionId, 'first_reap_running');
  job(sessionId, 'first_reap_gone');
  armTurnShellReap(sessionId, { askStartedAt: Date.now() - 1_000 });
  const jobs = await takeStoppedShellJobs(sessionId);
  assert.deepEqual(jobs, { stopped: ['first_reap_gone'], stopping: ['first_reap_running'] });
  cancelBackgroundTasks({ surface: 'shell', executionSessionId: sessionId, notify: false });
});
