import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseTaskNotification,
  renderAgentCompletionEnvelope,
  renderShellCompletionEnvelope,
} from './task-notification-envelope.mjs';
import {
  backgroundTaskHeaderStatus,
  isBracketedShellNotificationEnvelope,
  isInternalRuntimeNotificationText,
  isModelVisibleToolCompletionWrapper,
  modelVisibleToolCompletionMessage,
  shouldPersistModelVisibleToolCompletion,
} from './tool-execution-contract.mjs';





test('failure without a result carries its error, not a synthetic result or usage', () => {
  const text = renderAgentCompletionEnvelope({ id: 'task_agent_2', status: 'failed', error: 'quota <limit> & retry' });
  assert.equal(
    text,
    [
      '<task-notification>',
      '<task-id>task_agent_2</task-id>',
      '<status>failed</status>',
      '<summary>Agent "task_agent_2" failed</summary>',
      '<error>quota &lt;limit&gt; &amp; retry</error>',
      '</task-notification>',
    ].join('\n')
  );
  assert.equal(parseTaskNotification(text).error, 'quota <limit> & retry');
  assert.equal(text.split('quota &lt;limit&gt; &amp; retry').length - 1, 1);
  assert.equal(shouldPersistModelVisibleToolCompletion(text), true);
  assert.equal(modelVisibleToolCompletionMessage(text, { model_visible: false }), '');
  const cancelled = renderAgentCompletionEnvelope({
    id: 'task_agent_3',
    tag: 'review',
    status: 'cancelled',
    error: 'cancelled',
  });
  assert.match(cancelled, /<summary>Agent "review" was cancelled<\/summary>/);
  assert.doesNotMatch(cancelled, /<(?:result|error|usage)>/);
});

test('shell non-zero exit remains a completed command result, with log and preview sections', () => {
  const text = renderShellCompletionEnvelope({
    jobId: 'job_1',
    status: 'completed',
    exitCode: 2,
    command: 'npm\n  test',
    outputFile: 'C:/logs/job_1.stdout.log',
    summary: '1 failing test',
    stdoutPreview: 'out',
    stderrPreview: 'err',
  });
  assert.equal(
    text,
    [
      '<task-notification>',
      '<task-id>job_1</task-id>',
      '<status>completed</status>',
      '<exit-code>2</exit-code>',
      '<summary>Shell task completed (exit 2): npm test</summary>',
      '<output-file>C:/logs/job_1.stdout.log</output-file>',
      '<result>',
      'Summary: 1 failing test',
      '',
      '[stdout preview]',
      'out',
      '',
      '[stderr preview]',
      'err',
      '</result>',
      '</task-notification>',
    ].join('\n')
  );
  assert.equal(isBracketedShellNotificationEnvelope(text), true);
  assert.equal(modelVisibleToolCompletionMessage(text), text);
  assert.equal(parseTaskNotification(text).exitCode, 2);
  const empty = renderShellCompletionEnvelope({ jobId: 'job_empty', status: 'completed', exitCode: 0 });
  assert.equal(modelVisibleToolCompletionMessage(empty), empty);
});


