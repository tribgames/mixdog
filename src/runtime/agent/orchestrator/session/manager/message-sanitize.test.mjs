import assert from 'node:assert/strict';
import test from 'node:test';
import {
  renderAgentCompletionEnvelope,
  renderShellCompletionEnvelope,
} from '../../../../shared/task-notification-envelope.mjs';
import { createSteeringDrain } from '../loop/steering.mjs';
import { prepareProviderPrefixGuard } from '../provider-prefix-guard.mjs';
import { filterModelVisibleSessionMessages } from './message-sanitize.mjs';
import { finalizeTurnInterruptionSnapshot } from './turn-interruption.mjs';

const notification = renderShellCompletionEnvelope({
  jobId: 'task_history',
  status: 'completed',
  exitCode: 0,
  summary: 'The background check passed.',
});

function historyWithNotification(message) {
  return [
    { role: 'user', content: 'Check the background result.' },
    message,
    {
      role: 'assistant',
      content: 'Inspecting the result.',
      toolCalls: [{ id: 'read_result', name: 'read', args: { file_path: 'result.txt' } }],
    },
    { role: 'tool', toolCallId: 'read_result', content: 'The check passed.' },
  ];
}

test('session snapshots preserve notifications, following work, and image content without aliasing the array', () => {
  const messages = historyWithNotification({
    role: 'user',
    content: notification,
    meta: { source: 'task-notification', execution: { id: 'task_history', surface: 'shell', status: 'completed' } },
  });
  messages.push(
    { role: 'assistant', content: 'The result is ready.' },
    { role: 'user', content: [{ type: 'image', data: 'image-bytes', mimeType: 'image/png' }] }
  );
  const snapshot = filterModelVisibleSessionMessages(messages);
  assert.deepEqual(snapshot, messages);
  assert.notEqual(snapshot, messages);
  for (let index = 0; index < messages.length; index += 1) assert.equal(snapshot[index], messages[index]);
  snapshot.push({ role: 'assistant', content: 'Next response.' });
  assert.equal(messages.length, 6);
});

test('restored and legacy notification text cannot delete an already model-visible history segment', () => {
  const notices = [
    notification,
    renderAgentCompletionEnvelope({ id: 'agent_history', tag: 'worker', status: 'failed', error: 'Check failed.' }),
    '[task_id: legacy_shell]\n[status: completed]\n[exit: 0]\n\nThe check passed.',
    'background task\ntask_id: legacy_task\nstatus: completed\n\nThe check passed.',
    'Async shell task legacy_shell (completed) finished.\n\nResult:\n> [task_id: legacy_shell]\n> [status: completed]',
  ];
  for (const content of notices) {
    for (const body of [content, [{ type: 'text', text: content }]]) {
      const messages = historyWithNotification({ role: 'user', content: body });
      assert.deepEqual(filterModelVisibleSessionMessages(messages), messages);
    }
  }
});

test('a drained notification and its tool results retain the provider prefix across a turn boundary', () => {
  const messages = [{ role: 'user', content: 'Check the background result.' }];
  const drain = createSteeringDrain({
    messages,
    opts: { drainSteering: () => [{ mode: 'task-notification', content: notification }] },
    onSkillPrompt: () => assert.fail('A task notification is not typed input.'),
  });
  assert.equal(drain('pre-send'), true);
  assert.equal(messages[1].meta.source, 'task-notification');
  messages.push(...historyWithNotification(messages[1]).slice(2));
  const sentHistory = structuredClone(messages);
  const guard = prepareProviderPrefixGuard(null, messages, {});
  const committed = filterModelVisibleSessionMessages(messages);
  committed.push({ role: 'assistant', content: 'The check passed.' });
  const nextRequest = filterModelVisibleSessionMessages(committed);
  nextRequest.push({ role: 'user', content: 'Continue.' });

  assert.deepEqual(nextRequest.slice(0, sentHistory.length), sentHistory);
  assert.doesNotThrow(() => prepareProviderPrefixGuard(guard, nextRequest, {}));
  assert.throws(
    () =>
      prepareProviderPrefixGuard(
        guard,
        nextRequest.filter((message) => message.role === 'user'),
        {}
      ),
    /provider message history shrank outside compaction/
  );
});

test('interrupted turns also retain notifications and the completed tool work that follows them', () => {
  const messages = historyWithNotification({
    role: 'user',
    content: notification,
    meta: { source: 'task-notification' },
  });
  const result = finalizeTurnInterruptionSnapshot({
    turnOutgoing: messages,
    currentUserContent: messages[0].content,
    snapshot: { responseStarted: true },
    abortReason: 'process-crash',
  });
  assert.deepEqual(result.messages.slice(0, messages.length), messages);
});
