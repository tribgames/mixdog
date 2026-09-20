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
import {
  _clearDeliveredCompletions,
  isDeliveredCompletion,
  recordDeliveredCompletion,
} from '../agent/orchestrator/session/manager/delivered-completions.mjs';
import { markCompletionEntry } from '../agent/orchestrator/session/manager/pending-message-entry.mjs';
import { shouldExcludeIngestMessage } from '../memory/lib/session-ingest.mjs';

test('agent completion is exactly one tagged block with verbatim result and no usage', () => {
  const result = '  **Done**\r\n<result>literal nested tag</result>\n';
  const text = renderAgentCompletionEnvelope({ id: 'task_agent_1', tag: 'tidy-skill', status: 'completed', result });
  assert.equal(text, [
    '<task-notification>',
    '<task-id>task_agent_1</task-id>',
    '<tag>tidy-skill</tag>',
    '<status>completed</status>',
    '<summary>Agent "tidy-skill" completed</summary>',
    `<result>\n${result}\n</result>`,
    '</task-notification>',
  ].join('\n'));
  assert.equal(parseTaskNotification(text).result, result);
  assert.equal(modelVisibleToolCompletionMessage(text), text);
  assert.equal(isModelVisibleToolCompletionWrapper(text), true);
  assert.equal(isInternalRuntimeNotificationText(text), true);
  assert.equal(backgroundTaskHeaderStatus(text), 'completed');
  assert.equal(shouldExcludeIngestMessage({ role: 'user', content: text }), true);
});

test('failure without a result carries its error, not a synthetic result or usage', () => {
  const text = renderAgentCompletionEnvelope({ id: 'task_agent_2', status: 'failed', error: 'quota <limit> & retry' });
  assert.equal(text, [
    '<task-notification>',
    '<task-id>task_agent_2</task-id>',
    '<status>failed</status>',
    '<summary>Agent "task_agent_2" failed: quota &lt;limit&gt; &amp; retry</summary>',
    '<error>quota &lt;limit&gt; &amp; retry</error>',
    '</task-notification>',
  ].join('\n'));
  assert.equal(parseTaskNotification(text).error, 'quota <limit> & retry');
  assert.equal(shouldPersistModelVisibleToolCompletion(text), true);
  assert.equal(modelVisibleToolCompletionMessage(text, { model_visible: false }), '');
  const cancelled = renderAgentCompletionEnvelope({ id: 'task_agent_3', tag: 'review', status: 'cancelled', error: 'cancelled' });
  assert.match(cancelled, /<summary>Agent "review" was cancelled<\/summary>/);
  assert.doesNotMatch(cancelled, /<(?:result|error|usage)>/);
});

test('shell non-zero exit remains a completed command result, with log and preview sections', () => {
  const text = renderShellCompletionEnvelope({
    jobId: 'job_1', status: 'completed', exitCode: 2, command: 'npm\n  test',
    outputFile: 'C:/logs/job_1.stdout.log', summary: '1 failing test', stdoutPreview: 'out', stderrPreview: 'err',
  });
  assert.equal(text, [
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
  ].join('\n'));
  assert.equal(isBracketedShellNotificationEnvelope(text), true);
  assert.equal(modelVisibleToolCompletionMessage(text), text);
  assert.equal(parseTaskNotification(text).exitCode, 2);
  const empty = renderShellCompletionEnvelope({ jobId: 'job_empty', status: 'completed', exitCode: 0 });
  assert.equal(modelVisibleToolCompletionMessage(empty), empty);
});

test('large results are not truncated by wrapping or re-enqueue', () => {
  const result = `start\n${'x'.repeat(40_000)}\nend`;
  const text = renderAgentCompletionEnvelope({ id: 'task_agent_large', status: 'completed', result });
  const entry = markCompletionEntry(modelVisibleToolCompletionMessage(text));
  assert.equal(entry.content, text);
  assert.equal(parseTaskNotification(entry.content).result, result);
  assert.deepEqual(entry.execution, { surface: 'agent', id: 'task_agent_large', status: 'completed' });
});

test('legacy quoted rows still classify and dedupe against new rows by task identity', () => {
  const legacy = 'Async agent task task_agent_legacy (completed) finished.\n\nResult:\n> background task\n> task_id: task_agent_legacy\n> surface: agent\n> status: completed\n> \n> done';
  const current = renderAgentCompletionEnvelope({ id: 'task_agent_legacy', status: 'completed', result: 'done' });
  assert.equal(isModelVisibleToolCompletionWrapper(legacy), true);
  assert.equal(shouldExcludeIngestMessage({ role: 'user', content: legacy }), true);
  assert.equal(modelVisibleToolCompletionMessage(legacy), current);
  assert.equal(markCompletionEntry(legacy).id, markCompletionEntry(current).id);
  _clearDeliveredCompletions();
  try {
    recordDeliveredCompletion({ text: legacy });
    assert.equal(isDeliveredCompletion({ text: current }), true);
  } finally {
    _clearDeliveredCompletions();
  }
});
