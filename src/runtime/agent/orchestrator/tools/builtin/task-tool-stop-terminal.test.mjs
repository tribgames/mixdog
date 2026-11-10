// A Stop asked of a background shell that already ended is not a failed stop:
// the answer names the terminal state so the desktop row can show it. The
// registry entry of an earlier run of the runtime is gone, but the job's
// record on disk (the recovery machinery) still says how it ended.
// Import before runtime modules: shell-job records are written under it.
import { fixtureRoot } from '../lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { cancelBackgroundTask, registerBackgroundTask } from '../../../../shared/background-tasks.mjs';
import { cleanupTempDirs } from '../../../../shared/worktrees/test-support.mjs';
import {
  _shellJobRecordWritesSettledForTest,
  completeShellJobRecord,
  publishShellJobRecord,
} from './lib/shell-job-records.mjs';
import { stopBackgroundShellJob } from './task-tool.mjs';

after(cleanupTempDirs);

const OWNER = 'sess_stop_terminal_owner';
const OTHER = 'sess_stop_terminal_other';
const ctx = (sessionId) => ({ callerSessionId: sessionId, clientHostPid: process.pid });

async function recordJob(jobId, status) {
  publishShellJobRecord(
    { jobId, pid: process.pid, command: 'python -m http.server', cwd: fixtureRoot },
    { ownerSessionId: OWNER, clientHostPid: process.pid }
  );
  await _shellJobRecordWritesSettledForTest(jobId);
  if (status === 'running') return;
  await completeShellJobRecord(jobId, { status, exitCode: 137, error: 'cancelled by task control' });
  await _shellJobRecordWritesSettledForTest(jobId);
}

test('a stop of a job the registry already holds as ended answers its terminal state', async () => {
  registerBackgroundTask({
    taskId: 'job_stop_terminal_registry',
    surface: 'shell',
    operation: 'shell',
    label: 'serve',
    context: ctx(OWNER),
  });
  cancelBackgroundTask('job_stop_terminal_registry', 'cancelled by task control');

  const answer = await stopBackgroundShellJob('job_stop_terminal_registry', ctx(OWNER));
  assert.equal(answer.stopped, false);
  assert.equal(answer.finished, true, 'an ended job is reported as ended, not as a failed stop');
  assert.match(answer.error, /already cancelled/);
});

test('a stop of a job only its record remembers answers the terminal state the record holds', async () => {
  await recordJob('job_stop_terminal_record', 'cancelled');

  const answer = await stopBackgroundShellJob('job_stop_terminal_record', ctx(OWNER));
  assert.equal(answer.stopped, false);
  assert.equal(answer.finished, true);
  assert.match(answer.error, /already cancelled/);

  const foreign = await stopBackgroundShellJob('job_stop_terminal_record', ctx(OTHER));
  assert.equal(foreign.finished, undefined, 'another session learns nothing about the job');
  assert.match(foreign.error, /task not found/);
});

test('a stop of a job whose record still reads running but has no live task is not reported as ended', async () => {
  await recordJob('job_stop_terminal_unknown', 'running');

  const answer = await stopBackgroundShellJob('job_stop_terminal_unknown', ctx(OWNER));
  assert.equal(answer.stopped, false);
  assert.equal(answer.finished, undefined);
  assert.match(answer.error, /unavailable after restart/);
});
