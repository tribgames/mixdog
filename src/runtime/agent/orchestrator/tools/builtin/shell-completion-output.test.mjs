import assert from 'node:assert/strict';
import test from 'node:test';
import { buildShellCompletion } from './shell-jobs.mjs';
import { renderBackgroundTask, renderBackgroundTaskNotification } from '../../../../shared/background-tasks.mjs';

test('completion notice omits logs while task read retains full output', () => {
  const detail = { status: 'completed', exitCode: 0, stdoutPreview: 'old\nnew\n', stderrPreview: 'warning\nlater\n' };
  const completion = buildShellCompletion('job_output', detail);
  const task = {
    taskId: 'job_output',
    surface: 'shell',
    status: 'completed',
    meta: {},
    result: completion.result,
    resultText: completion.body,
  };
  for (const notice of [completion.notification, renderBackgroundTaskNotification(task)]) {
    assert.doesNotMatch(notice, /old|warning|later/);
    assert.match(notice, /task read/);
    assert.match(notice, /<exit-code>0/);
  }
  const output = renderBackgroundTask(task, { includeResult: true });
  assert.ok(output.includes(detail.stdoutPreview));
  assert.ok(output.includes(detail.stderrPreview));
});

test('changed previews and failure evidence are preserved', () => {
  const detail = {
    status: 'completed',
    exitCode: 1,
    stdoutPreview: 'head\n...omitted...\ntail',
    stderrPreview: 'failure',
  };
  const completion = buildShellCompletion('job_failed', detail);
  assert.ok(completion.body.includes(detail.stdoutPreview));
  assert.match(completion.body, /failure/);
  assert.match(completion.body, /<exit-code>1/);
  assert.match(completion.notification, /<exit-code>1/);
});
