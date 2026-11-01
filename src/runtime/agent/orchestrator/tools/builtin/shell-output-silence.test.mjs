import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readShellTaskOutput } from './lib/shell-task-output.mjs';
import { shellTaskSilenceNote, waitedJobSilence } from './lib/shell-output-silence.mjs';
import { beginSessionTaskWait, markSessionAskStart } from '../../session/manager/runtime-liveness.mjs';
import { cleanupBackgroundTasks, registerBackgroundTask } from '../../../../shared/background-tasks.mjs';
import { buildAgentTaskProgressFields } from '../../../../../session-runtime/services/agent-task-status.mjs';
import { renderResult } from '../../../../../session-runtime/services/agent-tool/render.mjs';

const MIN = 60_000;
const WARN_MS = 10 * MIN;

// A running job whose capture files were last written at fake times. `base` is
// in the past because a task cannot start in the future; `now` is a fake clock.
function quietJob(t, { stdoutAt, stderrAt = stdoutAt }) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-silence-'));
  const sessionId = `sess_silence_${Math.random().toString(36).slice(2)}`;
  t.after(() => {
    cleanupBackgroundTasks({ context: { sessionId }, includeRunning: true });
    rmSync(root, { recursive: true, force: true });
  });
  const base = Date.now() - 3_600_000;
  const paths = { stdout_path: join(root, 'out.log'), stderr_path: join(root, 'err.log') };
  const touch = (path, offsetMs) => {
    writeFileSync(path, offsetMs == null ? '' : 'x\n');
    utimesSync(path, new Date(base + (offsetMs ?? 0)), new Date(base + (offsetMs ?? 0)));
  };
  touch(paths.stdout_path, stdoutAt);
  touch(paths.stderr_path, stderrAt);
  const task = registerBackgroundTask({
    taskId: `job_silence_${sessionId}`,
    startedAtMs: base,
    surface: 'shell',
    operation: 'shell',
    label: 'slow test',
    context: { callerSessionId: sessionId },
    meta: { stdout: paths.stdout_path, stderr: paths.stderr_path },
  });
  return { base, paths, task, sessionId, touch };
}

test('a running job quiet past the threshold is flagged possibly hung, not "not an error"', (t) => {
  const { base, paths, task } = quietJob(t, { stdoutAt: 0 });
  const digest = (offsetMs) =>
    readShellTaskOutput(task, paths, { digest: true, now: base + offsetMs, silenceWarnMs: WARN_MS });

  assert.match(digest(9 * MIN), /still running, not an error/, 'under the threshold: unchanged reassurance');
  const hung = digest(12 * MIN);
  assert.match(hung, /\[progress\] no output for 12m — may be hung; inspect or cancel/);
  assert.doesNotMatch(hung, /not an error/);
  assert.equal(
    shellTaskSilenceNote(task, { now: base + 12 * MIN, warnMs: WARN_MS }),
    'no output for 12m — may be hung; inspect or cancel'
  );
});

test('output on either stream resets the silence clock', (t) => {
  const { base, paths, task, touch } = quietJob(t, { stdoutAt: 0 });
  const now = base + 12 * MIN;
  assert.ok(shellTaskSilenceNote(task, { now, warnMs: WARN_MS }));

  touch(paths.stderr_path, 11 * MIN); // stderr alone counts
  assert.equal(shellTaskSilenceNote(task, { now, warnMs: WARN_MS }), null);
  assert.match(
    readShellTaskOutput(task, paths, { digest: true, now, silenceWarnMs: WARN_MS }),
    /still running, not an error/
  );

  // Silent again for another full window: flagged from the last output.
  assert.equal(
    shellTaskSilenceNote(task, { now: base + 22 * MIN, warnMs: WARN_MS }),
    'no output for 11m — may be hung; inspect or cancel'
  );
});

test('an unreadable capture file means unknown silence, never a warning from the other stream', (t) => {
  const { base, paths, task } = quietJob(t, { stdoutAt: 0 });
  const now = base + 20 * MIN;
  assert.ok(shellTaskSilenceNote(task, { now, warnMs: WARN_MS }), 'readable and quiet: flagged');

  // Both files are created before the command runs, so a missing stderr (ENOENT)
  // is unknown: its recent output could be what cannot be seen.
  rmSync(paths.stderr_path);
  assert.equal(shellTaskSilenceNote(task, { now, warnMs: WARN_MS }), null);
  assert.doesNotMatch(
    readShellTaskOutput(task, paths, { digest: true, now, silenceWarnMs: WARN_MS }),
    /may be hung/
  );

  // A non-ENOENT stat error (here ENOTDIR) is unknown as well.
  const notDir = { ...paths, stderr_path: join(paths.stdout_path, 'x') };
  assert.equal(shellTaskSilenceNote(task, { now, warnMs: WARN_MS, result: notDir }), null);
});

test('agent status shows the waited job tool silence and flags a hung one in the diagnostic', (t) => {
  const { base, task, sessionId } = quietJob(t, { stdoutAt: 0 });
  markSessionAskStart(sessionId);
  const release = beginSessionTaskWait(sessionId, task.taskId);
  t.after(release);
  const now = base + 23 * MIN;
  const silence = waitedJobSilence([task.taskId], { now, warnMs: WARN_MS });
  assert.deepEqual(silence, { taskId: task.taskId, silentMs: 23 * MIN, hung: true });

  // The activity heartbeat keeps `silent_for` at 6s while the tool runs.
  const fields = buildAgentTaskProgressFields({
    now,
    runtimeStage: 'tool_running',
    runtime: { lastProgressAt: now - 6_000, lastToolCall: 'task' },
    toolSilence: silence,
  });
  assert.equal(fields.silent_for, 6);
  assert.equal(fields.tool_silent_for, `23m (shell job ${task.taskId} no output)`);
  assert.match(fields.diagnostic, /^tool possibly hung: shell job .* no output for 23m/);
  assert.match(renderResult({ task_id: 't1', status: 'running', ...fields }, 'status'), /tool_silent_for: 23m \(shell job/);

  const fresh = waitedJobSilence([task.taskId], { now: base + 2 * MIN, warnMs: WARN_MS });
  const calm = buildAgentTaskProgressFields({ now: base + 2 * MIN, runtimeStage: 'tool_running', toolSilence: fresh });
  assert.equal(calm.tool_silent_for, `2m (shell job ${task.taskId} no output)`);
  assert.equal(calm.diagnostic, 'tool running');
  assert.equal(buildAgentTaskProgressFields({ now, runtimeStage: 'tool_running' }).tool_silent_for, undefined);
});
