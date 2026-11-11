#!/usr/bin/env node
// Golden twin of `src/runtime/agent/orchestrator/session/manager/message-sanitize.test.mjs`: what a session snapshot
// (`filterModelVisibleSessionMessages`) keeps, the notification a steering drain adds (`createSteeringDrain`), the
// provider-prefix guard across a turn boundary (`prepareProviderPrefixGuard`) and what an interrupted turn keeps
// (`finalizeTurnInterruptionSnapshot`). Notification texts come from the real envelope renderers.
//
//   node benchmarks/rust-core/recorders/record-session-message-sanitize.mjs --tree <dir>
import { outcome, runSessionRecorder } from './lib/session-rec.mjs';

await runSessionRecorder(import.meta.url, {
  set: 'session-message-sanitize',
  testFile: 'src/runtime/agent/orchestrator/session/manager/message-sanitize.test.mjs',
  entry: 'Ran message-sanitize.mjs (filterModelVisibleSessionMessages), loop/steering.mjs (createSteeringDrain), provider-prefix-guard.mjs (prepareProviderPrefixGuard), manager/turn-interruption.mjs (finalizeTurnInterruptionSnapshot) and shared/task-notification-envelope.mjs on the test file\'s inputs. Did not run persistCompactedOutgoingAfterAskFailure (needs the store) nor a real turn.',
  replay: 'mixdog-core run_host factory.rs item commit / mixdog-agent project.rs (model rows), mixdog-agent interrupt.rs finalize_interrupted_turn and the provider prefix guard: build the same messages (texts as recorded) and compare the snapshot (element-wise identity flags aside: a Rust snapshot is a copy), the steering-drained row, guard verdicts with their error text, and the interrupted-turn messages whole.',
  exclusions: ['meta.transcript.messageId of a drained notification (msg_ + 32 hex, random per run) is recorded as msg_<id>', 'object identity (assert.equal(snapshot[i], messages[i])) is recorded as identity flags: sameArray, sameElements; a Rust copy needs only equality'],
}, async ({ imp }) => {
  const { renderAgentCompletionEnvelope, renderShellCompletionEnvelope } = await imp('src/runtime/shared/task-notification-envelope.mjs');
  const { createSteeringDrain } = await imp('src/runtime/agent/orchestrator/session/loop/steering.mjs');
  const { prepareProviderPrefixGuard } = await imp('src/runtime/agent/orchestrator/session/provider-prefix-guard.mjs');
  const { filterModelVisibleSessionMessages } = await imp('src/runtime/agent/orchestrator/session/manager/message-sanitize.mjs');
  const { finalizeTurnInterruptionSnapshot } = await imp('src/runtime/agent/orchestrator/session/manager/turn-interruption.mjs');

  const notificationInput = { jobId: 'task_history', status: 'completed', exitCode: 0, summary: 'The background check passed.' };
  const notification = renderShellCompletionEnvelope(notificationInput);
  const history = (message) => [
    { role: 'user', content: 'Check the background result.' },
    message,
    { role: 'assistant', content: 'Inspecting the result.', toolCalls: [{ id: 'read_result', name: 'read', args: { file_path: 'result.txt' } }] },
    { role: 'tool', toolCallId: 'read_result', content: 'The check passed.' },
  ];
  const cases = [];

  // 1 (test line 28)
  {
    const messages = history({
      role: 'user', content: notification,
      meta: { source: 'task-notification', execution: { id: 'task_history', surface: 'shell', status: 'completed' } },
    });
    messages.push({ role: 'assistant', content: 'The result is ready.' }, { role: 'user', content: [{ type: 'image', data: 'image-bytes', mimeType: 'image/png' }] });
    const input = structuredClone(messages);
    const snapshot = filterModelVisibleSessionMessages(messages);
    const result = { snapshot, sameArray: snapshot === messages, sameElements: messages.every((m, i) => snapshot[i] === m) };
    snapshot.push({ role: 'assistant', content: 'Next response.' });
    result.sourceLengthAfterPush = messages.length;
    cases.push({ name: 'snapshot-keeps-notifications-following-work-and-images-without-aliasing', testLine: 32, input: { notificationInput, messages: input }, result });
  }

  // 2 (test line 46)
  {
    const agentInput = { id: 'agent_history', tag: 'worker', status: 'failed', error: 'Check failed.' };
    const notices = [
      notification,
      renderAgentCompletionEnvelope(agentInput),
      '[task_id: legacy_shell]\n[status: completed]\n[exit: 0]\n\nThe check passed.',
      'background task\ntask_id: legacy_task\nstatus: completed\n\nThe check passed.',
      'Async shell task legacy_shell (completed) finished.\n\nResult:\n> [task_id: legacy_shell]\n> [status: completed]',
    ];
    const rows = [];
    for (const content of notices) {
      for (const body of [content, [{ type: 'text', text: content }]]) {
        const messages = history({ role: 'user', content: body });
        rows.push({ messages: structuredClone(messages), snapshot: filterModelVisibleSessionMessages(messages) });
      }
    }
    cases.push({ name: 'restored-and-legacy-notification-text-stays-in-history', testLine: 50, input: { shellInput: notificationInput, agentInput }, result: rows });
  }

  // 3 (test line 62)
  {
    const messages = [{ role: 'user', content: 'Check the background result.' }];
    const skillPrompts = [];
    const drain = createSteeringDrain({
      messages,
      opts: { drainSteering: () => [{ mode: 'task-notification', content: notification }] },
      onSkillPrompt: (...args) => skillPrompts.push(args),
    });
    const drained = drain('pre-send');
    const afterDrain = structuredClone(messages);
    messages.push(...history(messages[1]).slice(2));
    const sentHistory = structuredClone(messages);
    const guard = prepareProviderPrefixGuard(null, messages, {});
    const committed = filterModelVisibleSessionMessages(messages);
    committed.push({ role: 'assistant', content: 'The check passed.' });
    const nextRequest = filterModelVisibleSessionMessages(committed);
    nextRequest.push({ role: 'user', content: 'Continue.' });
    const retained = await outcome(() => prepareProviderPrefixGuard(guard, nextRequest, {}));
    const shrunkRequest = nextRequest.filter((message) => message.role === 'user');
    const shrunk = await outcome(() => prepareProviderPrefixGuard(guard, shrunkRequest, {}));
    cases.push({
      name: 'drained-notification-retains-the-provider-prefix-across-a-turn-boundary',
      testLine: 66,
      input: { prompt: 'Check the background result.', drained: [{ mode: 'task-notification', content: notification }], toolWork: history(messages[1]).slice(2) },
      result: {
        drained, skillPromptCalls: skillPrompts.length, afterDrain, sentHistory,
        guardFirst: guard ?? null,
        nextRequest, prefixEqualsSentHistory: JSON.stringify(nextRequest.slice(0, sentHistory.length)) === JSON.stringify(sentHistory),
        retained,
        shrunkRequest, shrunk,
      },
    });
  }

  // 4 (test line 91)
  {
    const messages = history({ role: 'user', content: notification, meta: { source: 'task-notification' } });
    const input = structuredClone(messages);
    const result = finalizeTurnInterruptionSnapshot({
      turnOutgoing: messages, currentUserContent: messages[0].content, snapshot: { responseStarted: true }, abortReason: 'process-crash',
    });
    cases.push({
      name: 'interrupted-turn-retains-notifications-and-completed-tool-work',
      testLine: 96,
      input: { messages: input, currentUserContent: messages[0].content, snapshot: { responseStarted: true }, abortReason: 'process-crash' },
      result,
    });
  }

  // The drain stamps a random transcript message id on the notification row: normalised, same shape msg_<32 hex>.
  return JSON.parse(JSON.stringify({ cases }).replace(/msg_[0-9a-f]{32}/g, 'msg_<id>'));
});
