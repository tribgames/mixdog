// Retraction bookkeeping for replayed sends. A stalled stream is retried as a
// fresh request, so the text the previous attempt exposed is a DRAFT of the
// same answer, not an earlier part of it. These tests pin the two halves of
// that contract: a replacement supersedes the retracted draft, and a failure
// that never produced a replacement still preserves what the user saw.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTurnInterruptionTracker,
  finalizeTurnInterruptionSnapshot,
  USER_CANCEL_KEEP_PROMPT_REASON,
} from './turn-interruption.mjs';
import { renderShellCompletionEnvelope } from '../../../../shared/task-notification-envelope.mjs';

const OPENING = 'Let me check that for you.';

test('repeated retry attempts commit one copy of the opening, not one per retry', () => {
  const tracker = createTurnInterruptionTracker();

  // Attempt 1: an opening reaches the user, the stream stalls, the loop
  // retracts exactly what it exposed.
  tracker.recordTextDelta(OPENING);
  tracker.tombstoneText(OPENING.length);
  // Attempt 2: same answer, same opening, stalls again.
  tracker.recordTextDelta(OPENING);
  tracker.tombstoneText(OPENING.length);
  // Attempt 3 finally answers.
  tracker.recordTextDelta('Here is the answer.');

  assert.equal(tracker.snapshot().partialAssistantContent, 'Here is the answer.');
});

test('a crash between retries snapshots a single copy of the visible text', () => {
  const tracker = createTurnInterruptionTracker();

  tracker.recordTextDelta(OPENING);
  tracker.tombstoneText(OPENING.length);
  tracker.recordTextDelta(OPENING);

  assert.equal(tracker.snapshot().partialAssistantContent, OPENING);
});

test('text retracted with no replacement is restored for the failure path', () => {
  const tracker = createTurnInterruptionTracker();

  tracker.recordTextDelta(OPENING);
  tracker.tombstoneText(OPENING.length);

  // Nothing replaced it, so the bytes the user already saw must survive the
  // interruption/error finalize.
  assert.equal(tracker.snapshot().partialAssistantContent, OPENING);
  assert.equal(tracker.restoreTombstonedText(), true);
  assert.equal(tracker.snapshot().partialAssistantContent, OPENING);
});

test('process-crash recovery keeps a notification turn and closes its unfinished calls as Cancelled', () => {
  const notification = renderShellCompletionEnvelope({
    jobId: 'task_agent_island',
    status: 'completed',
    exitCode: 0,
    summary: 'Agent "island-agents" completed',
  });
  const turnOutgoing = [
    { role: 'user', content: notification },
    {
      role: 'assistant',
      content: 'Re-running the full gate.',
      toolCalls: [
        { id: 'call_done', name: 'read', arguments: { path: 'a' } },
        { id: 'call_gate', name: 'shell', arguments: { command: 'npm run gate:local' } },
      ],
    },
    { role: 'tool', toolCallId: 'call_done', content: 'file body' },
  ];
  const { messages, responsePreserved, userTurnPreserved } = finalizeTurnInterruptionSnapshot({
    turnOutgoing,
    currentUserContent: notification,
    snapshot: { responseStarted: true, phase: 'tools' },
  });
  assert.equal(responsePreserved, true);
  assert.equal(userTurnPreserved, true);
  assert.equal(messages[0].content, notification);
  assert.ok(messages.some((m) => m.role === 'assistant' && m.toolCalls?.length === 2));
  const results = (id) => messages.filter((m) => m.role === 'tool' && m.toolCallId === id);
  assert.deepEqual(
    results('call_done').map((m) => m.content),
    ['file body']
  );
  assert.deepEqual(
    results('call_gate').map((m) => m.content),
    ['Cancelled']
  );
  assert.equal(messages.at(-1).content, '[Request interrupted by process restart]');
});

test('a whitespace-only replacement does not supersede the retracted draft', () => {
  const tracker = createTurnInterruptionTracker();

  tracker.recordTextDelta(OPENING);
  tracker.tombstoneText(OPENING.length);
  tracker.recordTextDelta('  \n');

  assert.equal(tracker.restoreTombstonedText(), true);
  const { messages, responsePreserved } = tracker.finalize({
    turnOutgoing: [{ role: 'user', content: 'prompt' }],
    currentUserContent: 'prompt',
    abortReason: 'user-cancel',
  });
  assert.equal(responsePreserved, true);
  assert.equal(messages[1].role, 'assistant');
  assert.match(messages[1].content, /Let me check that for you\./);

  // Meaningful replacement text still supersedes it.
  const replaced = createTurnInterruptionTracker();
  replaced.recordTextDelta(OPENING);
  replaced.tombstoneText(OPENING.length);
  replaced.recordTextDelta('  ');
  replaced.recordTextDelta('Here is the answer.');
  assert.equal(replaced.restoreTombstonedText(), false);
  assert.equal(replaced.snapshot().partialAssistantContent, '  Here is the answer.');
});

test('a second reset of a whitespace-only retry keeps the meaningful retracted draft', () => {
  const tracker = createTurnInterruptionTracker();
  tracker.recordTextDelta(OPENING);
  tracker.tombstoneText(OPENING.length);
  tracker.recordTextDelta('  ');
  tracker.tombstoneText(2);
  assert.equal(tracker.restoreTombstonedText(), true);
  assert.match(tracker.snapshot().partialAssistantContent, /Let me check that for you\./);

  // A meaningful retry still replaces the draft: one copy per retry.
  const retried = createTurnInterruptionTracker();
  retried.recordTextDelta(OPENING);
  retried.tombstoneText(OPENING.length);
  retried.recordTextDelta('  ');
  retried.tombstoneText(2);
  retried.recordTextDelta(OPENING);
  retried.tombstoneText(OPENING.length);
  assert.equal(retried.restoreTombstonedText(), true);
  assert.equal(retried.snapshot().partialAssistantContent, OPENING);
});

test('a committed assistant message clears both the partial and the retracted draft', () => {
  const tracker = createTurnInterruptionTracker();

  tracker.recordTextDelta(OPENING);
  tracker.tombstoneText(OPENING.length);
  tracker.markAssistantMessageCommitted();

  assert.equal(tracker.snapshot().partialAssistantContent, '');
  assert.equal(tracker.restoreTombstonedText(), false);
});

// A user Stop the host will not answer with the prompt back in the input box
// (the desktop Stop button) must leave the prompt in the stored transcript: a
// first message cancelled while the model was only thinking otherwise leaves a
// zero-message session that every catalog hides, and the text is nowhere.
test('a user cancel that keeps the prompt retains the unanswered user turn and the plain cancel still rewinds it', () => {
  const turnOutgoing = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'RUN:slowt first message' },
  ];
  const finalize = (abortReason) =>
    finalizeTurnInterruptionSnapshot({
      turnOutgoing,
      currentUserContent: 'RUN:slowt first message',
      snapshot: { responseStarted: false },
      abortReason,
    });
  const kept = finalize(USER_CANCEL_KEEP_PROMPT_REASON);
  assert.equal(kept.userTurnPreserved, true);
  assert.equal(kept.responsePreserved, false);
  assert.deepEqual(
    kept.messages.map((message) => message.content),
    ['sys', 'RUN:slowt first message', '[Request interrupted]']
  );
  assert.equal(finalize('user-cancel').userTurnPreserved, false);
  assert.deepEqual(
    finalize('user-cancel').messages.map((message) => message.content),
    ['sys']
  );
});

test('a prompt-keeping user cancel after output still closes the turn with the user interrupt marker', () => {
  const { messages, responsePreserved } = finalizeTurnInterruptionSnapshot({
    turnOutgoing: [{ role: 'user', content: 'prompt' }],
    currentUserContent: 'prompt',
    snapshot: { responseStarted: true, partialAssistantContent: 'Working on it', phase: 'text' },
    abortReason: USER_CANCEL_KEEP_PROMPT_REASON,
  });
  assert.equal(responsePreserved, true);
  assert.equal(messages.at(-1).content, '[Request interrupted by user]');
  assert.equal(messages.at(-2).content, 'Working on it');
});
