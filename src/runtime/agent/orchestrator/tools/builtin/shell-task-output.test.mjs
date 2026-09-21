import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readShellTaskOutput } from './lib/shell-task-output.mjs';
import { renderBackgroundedResult } from './bash-tool/backgrounded-result.mjs';
import { executeTaskTool } from './task-tool.mjs';
import { buildShellCompletion } from './shell-jobs.mjs';
import { cleanupBackgroundTasks, completeBackgroundTask, getBackgroundTask, renderBackgroundTask } from '../../../../shared/background-tasks.mjs';
import { validateBuiltinArgs } from './arg-guard.mjs';
import { interruptTaskWaitForSession } from '../../session/task-wait-control.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-task-output-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stdout_path = join(root, 'stdout.log');
  const stderr_path = join(root, 'stderr.log');
  writeFileSync(stdout_path, '');
  writeFileSync(stderr_path, '');
  return { stdout_path, stderr_path };
}

test('shell promotion and task reads share a cursor without hiding failures or original logs', async (t) => {
  const paths = fixture(t);
  const jobId = `job_delta_${Date.now()}`;
  const sessionId = `sess_${jobId}`;
  t.after(() => cleanupBackgroundTasks({ context: { sessionId }, includeRunning: true }));
  writeFileSync(paths.stdout_path, 'already received\n');
  const first = renderBackgroundedResult({
    result: { jobId, stdoutPath: paths.stdout_path, stderrPath: paths.stderr_path },
    command: 'test command', cwd: tmpdir(), options: { sessionId }, stdout: 'already received\n', stderr: '',
  });
  assert.match(first, /already received/);
  appendFileSync(paths.stdout_path, 'new result\n');
  appendFileSync(paths.stderr_path, 'failure warning\n');
  const completion = buildShellCompletion(jobId, {
    status: 'completed', exitCode: 1, stdoutPath: paths.stdout_path, stderrPath: paths.stderr_path,
    stdoutPreview: 'already received\nnew result\n', stderrPreview: 'failure warning\n',
  });
  completeBackgroundTask(jobId, { status: completion.taskStatus, result: completion.result, resultText: completion.body, notify: false });
  const second = await executeTaskTool({ action: 'read', task_id: jobId }, { sessionId });
  assert.doesNotMatch(second, /already received|<task-notification>|stdout_preview/);
  assert.match(second, /new result/);
  assert.match(second, /failure warning/);
  assert.match(second, /exit_code: 1/);
  assert.equal(second.split(`task_id: ${jobId}`).length - 1, 1);
  const again = await executeTaskTool({ action: 'wait', task_id: jobId }, { sessionId });
  assert.match(again, /no new output/);
  assert.match(again, /exit_code: 1/);
  const replay = await executeTaskTool({ action: 'read', task_id: jobId, output: 'tail' }, { sessionId });
  assert.match(replay, /already received/);
  assert.match(replay, /failure warning/);
  assert.ok(replay.replaceAll('\\', '/').includes(paths.stderr_path.replaceAll('\\', '/')));
  assert.match(await executeTaskTool({ action: 'read', task_id: jobId }, { sessionId }), /no new output/);
  assert.equal(readFileSync(paths.stdout_path, 'utf8'), 'already received\nnew result\n');
  assert.match(await executeTaskTool({ action: 'read', task_id: jobId }, { sessionId: 'other' }), /task not found/);
});

test('paged output preserves every UTF-8 byte and does not consume an omitted middle', (t) => {
  const paths = fixture(t);
  const source = `${'a'.repeat(8191)}한글🙂${'b'.repeat(17000)}\n`;
  writeFileSync(paths.stdout_path, source);
  const task = { status: 'running' };
  let reconstructed = '';
  for (let page = 0; page < 4; page++) {
    const text = readShellTaskOutput(task, paths);
    const body = text.split('[stdout]\n')[1]?.split('\n\n[stdout:')[0];
    if (body) reconstructed += body;
    if (page < 3) assert.match(text, /unread bytes/);
  }
  assert.equal(reconstructed, source);
  assert.equal(readShellTaskOutput(task, paths), '(no new output)');
});

test('preview-only jobs preserve changed previews, and disk errors stay visible and retryable', (t) => {
  const task = { status: 'running' };
  assert.equal(readShellTaskOutput(task, { stdout_preview: 'old\n' }), '[stdout]\nold\n');
  assert.equal(readShellTaskOutput(task, { stdout_preview: 'old\nnew\n' }), '[stdout]\nnew\n');
  assert.equal(readShellTaskOutput(task, { stdout_preview: 'changed\n' }), '[stdout]\nchanged\n');
  const paths = fixture(t);
  rmSync(paths.stderr_path);
  assert.match(readShellTaskOutput(task, paths), /stderr read error:/);
  writeFileSync(paths.stderr_path, 'recovered warning');
  assert.match(readShellTaskOutput(task, paths), /recovered warning/);
});

test('shell completion is rendered once with its verdict, not a nested notification', () => {
  const completion = buildShellCompletion('job_failed', {
    status: 'failed', timedOut: true, signal: 'SIGTERM', stderrPreview: 'failure details',
  });
  const text = renderBackgroundTask({
    taskId: 'job_failed', surface: 'shell', status: completion.taskStatus,
    result: completion.result, resultText: completion.body, error: completion.error,
  }, { includeResult: true });
  assert.doesNotMatch(text, /<task-notification>/);
  assert.match(text, /timed_out: true/);
  assert.match(text, /signal: SIGTERM/);
  assert.match(text, /failure details/);
  assert.equal(text.split('task_id: job_failed').length - 1, 1);
});

test('completed large output prioritizes final diagnostics within a bounded response', (t) => {
  const paths = fixture(t);
  const source = 'progress\n'.repeat(6000) + 'FATAL: final failure evidence\n';
  writeFileSync(paths.stdout_path, source);
  writeFileSync(paths.stderr_path, 'warning\n'.repeat(6000) + 'final stderr diagnosis\n');
  const task = { status: 'failed' };
  const result = readShellTaskOutput(task, paths);
  assert.match(result, /FATAL: final failure evidence/);
  assert.match(result, /final stderr diagnosis/);
  assert.match(result, /earlier bytes omitted/);
  assert.ok(Buffer.byteLength(result) < 26 * 1024);
  assert.equal(readShellTaskOutput(task, paths), '(no new output)');
  assert.match(readShellTaskOutput(task, paths, { output: 'tail' }), /FATAL: final failure evidence/);
  assert.equal(readFileSync(paths.stdout_path, 'utf8'), source);
});

test('replay does not consume unread bytes and recovers output after response or context loss', (t) => {
  const paths = fixture(t);
  const task = { status: 'running' };
  writeFileSync(paths.stdout_path, 'first response\n');
  readShellTaskOutput(task, paths); // The caller discards this response.
  appendFileSync(paths.stdout_path, 'unread response\n');
  const replay = readShellTaskOutput(task, paths, { output: 'tail' });
  assert.match(replay, /first response/);
  assert.match(replay, /unread response/);
  assert.equal(readShellTaskOutput(task, paths), '[stdout]\nunread response\n');
  assert.match(readShellTaskOutput({ status: 'completed' }, paths, { output: 'tail' }), /first response/);
});

test('model output strips split ANSI controls without changing original log bytes', (t) => {
  const paths = fixture(t);
  const task = { status: 'running' };
  const source = 'a'.repeat(8191) + '\x1b[31mcolored warning\x1b[0m\n\x1b]0;private title\x07visible\n';
  writeFileSync(paths.stdout_path, source);
  const first = readShellTaskOutput(task, paths);
  const second = readShellTaskOutput(task, paths);
  assert.equal(/\x1b|private title|\[31m/.test(first + second), false, 'terminal controls must not leak');
  assert.match(second, /colored warning/);
  assert.match(second, /visible/);
  assert.equal(readFileSync(paths.stdout_path, 'utf8'), source);
  writeFileSync(paths.stdout_path, 'b'.repeat(8185) + '\x1b]0;' + 'title'.repeat(3000) + '\x1b\\after title\n');
  const oscTask = { status: 'running' };
  let output = '';
  for (let i = 0; i < 3; i++) output += readShellTaskOutput(oscTask, paths);
  assert.equal(/\x1b|titletitle/.test(output), false, 'split OSC payload must not leak');
  assert.match(output, /after title/);
});

test('task output mode is validated for the actions that own it', () => {
  for (const action of ['read', 'wait']) {
    for (const output of ['new', 'tail']) {
      assert.equal(validateBuiltinArgs('task', { action, task_id: 'job_mode', output }), null);
    }
  }
  assert.match(validateBuiltinArgs('task', { action: 'read', task_id: 'job_mode', output: 'all' }), /new or tail/);
  assert.match(validateBuiltinArgs('task', { action: 'cancel', task_id: 'job_mode', output: 'tail' }), /only valid/);
  assert.match(validateBuiltinArgs('task', { action: 'list', output: 'tail' }), /only valid/);
});

test('interrupted waits keep the job alive and leave explicit output replay available', async (t) => {
  const paths = fixture(t);
  const jobId = `job_interrupt_${Date.now()}`;
  const sessionId = `sess_${jobId}`;
  t.after(() => cleanupBackgroundTasks({ context: { sessionId }, includeRunning: true }));
  writeFileSync(paths.stdout_path, 'before interruption\n');
  renderBackgroundedResult({
    result: { jobId, stdoutPath: paths.stdout_path, stderrPath: paths.stderr_path },
    command: 'test command', cwd: tmpdir(), options: { sessionId }, stdout: '', stderr: '',
  });
  const task = getBackgroundTask(jobId);
  task.result = paths;
  task.promise = new Promise(() => {});
  const timer = setTimeout(() => interruptTaskWaitForSession(sessionId), 20);
  try {
    const result = await executeTaskTool({ action: 'wait', task_id: jobId }, { sessionId });
    assert.match(result, /Wait interrupted by new user input/);
    assert.equal(task.status, 'running');
    assert.match(await executeTaskTool({ action: 'read', task_id: jobId, output: 'tail' }, { sessionId }), /before interruption/);
  } finally {
    clearTimeout(timer);
  }
});
