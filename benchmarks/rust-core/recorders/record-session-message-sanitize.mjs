#!/usr/bin/env node
// Golden twin of `src/runtime/agent/orchestrator/session/manager/message-sanitize.test.mjs`: what a session snapshot
// (`filterModelVisibleSessionMessages`) keeps, the notification a steering drain adds (`createSteeringDrain`), the
// provider-prefix guard across a turn boundary (`prepareProviderPrefixGuard`) and what an interrupted turn keeps
// (`finalizeTurnInterruptionSnapshot`). Notification texts come from the real envelope renderers.
//
//   node benchmarks/rust-core/recorders/record-session-message-sanitize.mjs --tree <dir>
import { exact } from './lib/exact.mjs';
import { runSessionRecorder } from './lib/session-rec.mjs';

// An outcome with the value encoded at the moment of return.
const outcomeExact = async (fn) => {
  try { return { ok: exact(await fn()) }; } catch (error) { return { error: exact(error) }; }
};

await runSessionRecorder(import.meta.url, {
  set: 'session-message-sanitize',
  testFile: 'src/runtime/agent/orchestrator/session/manager/message-sanitize.test.mjs',
  entry: 'Ran message-sanitize.mjs (filterModelVisibleSessionMessages), loop/steering.mjs (createSteeringDrain), provider-prefix-guard.mjs (prepareProviderPrefixGuard), manager/turn-interruption.mjs (finalizeTurnInterruptionSnapshot) and shared/task-notification-envelope.mjs on the test file\'s inputs. Did not run persistCompactedOutgoingAfterAskFailure (needs the store) nor a real turn.',
  replay: "Lines 32, 50: the rows appended with thread/inheritedRows/append and read back with thread/modelMessages/list (mixdog-core-session session/message_sanitize_replay.rs). Line 96: a turn's rows committed by the run, the process gone mid-turn, the thread reopened over the same store and read with thread/modelMessages/list (same file). Line 66: turn/start on the run host's real agent loop, the completion through TaskNotifier::finished, the conversation read with thread/modelMessages/list at each provider request (mixdog-core run_host/session_message_sanitize_replay.rs).",
  values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs)',
  exclusions: ["meta.transcript.messageId of a drained notification (msg_ + 32 hex, random per run), at that path only, is recorded as msg_<id>","object identity (assert.equal(snapshot[i], messages[i])) is recorded as identity flags: sameArray, sameElements; a Rust copy needs only equality","every other value is recorded whole, encoded at the moment it was returned","replay (lines 66, 96): meta.transcript.messageId of the turn's prompt row (msg_ + 32 hex, random, stamped by the core's turn start) is removed: the recording holds the test's literal prompt row without one","replay line 66: the recorder drains before the first request with no tool batch; the product drains at the request after a tool batch (send-phase.mjs:53, core mixdog-agent run.rs begin_iteration), so afterDrain is compared as the prompt row and the row that drain appends","replay line 66: meta.execution and meta.submissionIds of the drained row are removed: they come from the product's queued completion (its execution and queue id); the recorder's hand-built entry {mode, content} has neither","replay line 66: sentHistory and the literal assistant/tool rows of nextRequest are the recorder's own test literals (recorder lines 98-108), not product values: replayed as the property they assert (the next turn's request starts with every row the previous request sent; its answer and new prompt have the recorded role and content)","replay line 66: guardFirst, retained, shrunkRequest and shrunk are the state and verdicts of Node's in-memory provider prefix guard (provider-prefix-guard.mjs), which the core does not hold (the migration drops _providerPrefixGuardState, store-migration 11.4.1): the core's rows are append-only, so the shrink it guards against has no product path","replay line 96: responsePreserved and userTurnPreserved are read as the client sees them: the prompt row is still the conversation's first row, and rows besides the prompt and the restart line remain"],
}, async ({ imp }) => {
  // Declared normalisation: the transcript message id the drain stamps, at meta.transcript.messageId only.
  const maskId = (value) => {
    if (Array.isArray(value)) return value.map(maskId);
    if (value && typeof value === 'object') {
      const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskId(v)]));
      if (out.meta && out.meta.transcript && /^msg_[0-9a-f]{32}$/.test(out.meta.transcript.messageId)) out.meta = { ...out.meta, transcript: { ...out.meta.transcript, messageId: 'msg_<id>' } };
      return out;
    }
    return value;
  };
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
    const input = exact(messages);
    const snapshot = filterModelVisibleSessionMessages(messages);
    // The returned snapshot, encoded now, before the test's later push into it.
    const result = { snapshot: exact(snapshot), sameArray: snapshot === messages, sameElements: messages.every((m, i) => snapshot[i] === m) };
    snapshot.push({ role: 'assistant', content: 'Next response.' });
    result.sourceAfterPush = exact(messages);
    cases.push({ name: 'snapshot-keeps-notifications-following-work-and-images-without-aliasing', testLine: 32, input: { notificationInput: exact(notificationInput), messages: input }, result });
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
        rows.push({ messages: exact(messages), snapshot: exact(filterModelVisibleSessionMessages(messages)) });
      }
    }
    cases.push({ name: 'restored-and-legacy-notification-text-stays-in-history', testLine: 50, input: { shellInput: exact(notificationInput), agentInput: exact(agentInput) }, result: rows });
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
    const drained = exact(drain('pre-send'));
    const skillPromptCalls = exact(skillPrompts);
    const afterDrain = exact(messages);
    messages.push(...history(messages[1]).slice(2));
    const sentHistory = exact(messages);
    const guardRaw = prepareProviderPrefixGuard(null, messages, {});
    const guardFirst = exact(guardRaw);
    const committed = filterModelVisibleSessionMessages(messages);
    committed.push({ role: 'assistant', content: 'The check passed.' });
    const nextRequestArr = filterModelVisibleSessionMessages(committed);
    nextRequestArr.push({ role: 'user', content: 'Continue.' });
    const nextRequest = exact(nextRequestArr);
    const retained = await outcomeExact(() => prepareProviderPrefixGuard(guardRaw, nextRequestArr, {}));
    const shrunkArr = nextRequestArr.filter((message) => message.role === 'user');
    const shrunkRequest = exact(shrunkArr);
    const shrunk = await outcomeExact(() => prepareProviderPrefixGuard(guardRaw, shrunkArr, {}));
    cases.push({
      name: 'drained-notification-retains-the-provider-prefix-across-a-turn-boundary',
      testLine: 66,
      input: { prompt: 'Check the background result.', drained: exact([{ mode: 'task-notification', content: notification }]), toolWork: exact(history(messages[1]).slice(2)) },
      result: {
        drained, skillPromptCalls, afterDrain, sentHistory,
        guardFirst,
        nextRequest,
        retained,
        shrunkRequest, shrunk,
      },
    });
  }

  // 4 (test line 91)
  {
    const messages = history({ role: 'user', content: notification, meta: { source: 'task-notification' } });
    const input = exact(messages);
    const result = exact(finalizeTurnInterruptionSnapshot({
      turnOutgoing: messages, currentUserContent: messages[0].content, snapshot: { responseStarted: true }, abortReason: 'process-crash',
    }));
    cases.push({
      name: 'interrupted-turn-retains-notifications-and-completed-tool-work',
      testLine: 96,
      input: { messages: input, currentUserContent: messages[0].content, snapshot: { responseStarted: true }, abortReason: 'process-crash' },
      result,
    });
  }

  // The drain stamps a random transcript message id on the notification row: normalised, same shape msg_<32 hex>.
  return { cases: maskId(cases) };
});
