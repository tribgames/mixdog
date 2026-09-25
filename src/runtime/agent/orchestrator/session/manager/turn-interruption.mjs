import { sanitizeToolPairs } from '../context-utils.mjs';
import { collectAssistantToolCallIds as assistantToolCallIds } from '../context-tool-pairs.mjs';
import { isInternalRuntimeNotificationText, promptContentText } from './prompt-utils.mjs';
import { filterModelVisibleSessionMessages } from './message-sanitize.mjs';
import { journalDelta } from './turn-interruption-journal.mjs';

const INTERRUPT_MESSAGE = '[Request interrupted by user]';
const INTERRUPT_MESSAGE_FOR_TOOL_USE = '[Request interrupted by user for tool use]';
const PROCESS_RESTART_INTERRUPT_MESSAGE = '[Request interrupted by process restart]';
const SESSION_INTERRUPT_MESSAGE = '[Request interrupted]';
// Short tool_result body for any unfinished call closed by
// cancel/crash. UI maps this (and legacy long reject bodies) to Cancelled.
const INTERRUPTED_TOOL_RESULT = 'Cancelled';

// Abort reasons that represent an EXPLICIT user cancellation of this turn.
// Only these rewind a not-yet-answered user turn out of history — the TUI/
// desktop restore the prompt into the input box on user cancel, so keeping
// the message would duplicate it on resubmit. Any other closeReason (engine
// shutdown `cli-react-exit`, watchdog, idle-sweep, runner-crash, …) must
// PRESERVE the just-sent user turn: nothing restores the prompt there, and
// rewinding erases the user's message from the persisted transcript (the
// exact loss seen when the desktop app quits mid-turn).
const USER_CANCEL_ABORT_REASONS = new Set(['cli-abort', 'user-cancel', 'turn-abort']);

function provisionalUserTurnIndex(messages, currentUserContent) {
  const currentText = promptContentText(currentUserContent);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    if (message.content === currentUserContent || promptContentText(message.content) === currentText) {
      return i;
    }
  }
  return -1;
}

function rewindProvisionalUserTurn(messages, currentUserContent) {
  const index = provisionalUserTurnIndex(messages, currentUserContent);
  if (index >= 0) {
    // Remove the provisional user turn plus pre-send hooks appended
    // after it, while retaining any compaction rewrite before it.
    messages.splice(index);
  }
  return messages;
}

function finalizeInterruptedTurn({
  turnOutgoing,
  currentUserContent,
  responseStarted,
  partialAssistantContent,
  partialReasoningContent,
  observedToolCalls,
  observedToolResults,
  phase,
  abortReason,
}) {
  const messages = filterModelVisibleSessionMessages(turnOutgoing).slice();
  // Null/unknown reasons keep the legacy rewind (status quo for wrapped
  // aborts without a closeReason enum); named non-user reasons preserve.
  const userCancelled = abortReason == null || USER_CANCEL_ABORT_REASONS.has(abortReason);
  // A turn cancelled while the model was only thinking
  // produced no model-visible message, so the provisional user turn is
  // rewound and the prompt goes back to the input box. Anything the model
  // actually said or did — committed messages from this turn, buffered text,
  // tool calls/results — keeps the turn (reasoning alone does not).
  const producedOutput =
    String(partialAssistantContent || '').trim() !== '' ||
    observedToolCalls.size > 0 ||
    observedToolResults.size > 0 ||
    (() => {
      const index = provisionalUserTurnIndex(messages, currentUserContent);
      return index >= 0 && index < messages.length - 1;
    })();
  const preserveResponse =
    responseStarted && !isInternalRuntimeNotificationText(currentUserContent) && (producedOutput || !userCancelled);
  if (!preserveResponse) {
    if (!userCancelled) {
      return {
        messages,
        responsePreserved: false,
        userTurnPreserved: true,
      };
    }
    return {
      messages: rewindProvisionalUserTurn(messages, currentUserContent),
      responsePreserved: false,
      userTurnPreserved: false,
    };
  }

  appendObservedTurnOutput(messages, {
    partialAssistantContent,
    partialReasoningContent,
    observedToolCalls,
    observedToolResults,
  });
  const pairedMessages = sanitizeToolPairs(messages);
  // The synthetic marker is omitted when a queued user submission
  // interrupted the active request; that queued message is the boundary.
  if (abortReason !== 'interrupt' && abortReason !== 'provider-error') {
    let content = SESSION_INTERRUPT_MESSAGE;
    if (abortReason === 'process-crash') content = PROCESS_RESTART_INTERRUPT_MESSAGE;
    else if (userCancelled) content = phase === 'tools' ? INTERRUPT_MESSAGE_FOR_TOOL_USE : INTERRUPT_MESSAGE;
    pairedMessages.push({
      role: 'user',
      content,
    });
  }
  return { messages: pairedMessages, responsePreserved: true, userTurnPreserved: true };
}

/** Appends what the interrupted response produced but the transcript does not
 *  hold yet — buffered text/reasoning, unrepresented tool calls and early tool
 *  results — then closes every still-unanswered call as cancelled. */
function appendObservedTurnOutput(
  messages,
  { partialAssistantContent, partialReasoningContent, observedToolCalls, observedToolResults }
) {
  const representedToolCallIds = new Set();
  for (const message of messages) {
    for (const id of assistantToolCallIds(message)) representedToolCallIds.add(id);
  }
  const unrepresentedCalls = [...observedToolCalls.values()]
    .filter(({ call }) => call?.id && !representedToolCallIds.has(call.id))
    .map(({ call }) => ({ ...call }));
  const assistantContent = String(partialAssistantContent || '');
  const reasoningContent = String(partialReasoningContent || '');
  if (assistantContent || reasoningContent || unrepresentedCalls.length > 0) {
    messages.push({
      role: 'assistant',
      content: assistantContent,
      ...(reasoningContent ? { reasoningContent } : {}),
      ...(unrepresentedCalls.length > 0 ? { toolCalls: unrepresentedCalls } : {}),
    });
  }

  const representedToolResultIds = new Set(
    messages.filter((message) => message?.role === 'tool' && message.toolCallId).map((message) => message.toolCallId)
  );
  for (const result of observedToolResults.values()) {
    if (!result?.toolCallId || representedToolResultIds.has(result.toolCallId)) continue;
    messages.push({
      role: 'tool',
      content: result.content == null ? '' : result.content,
      toolCallId: result.toolCallId,
      ...(result.toolKind ? { toolKind: result.toolKind } : {}),
    });
    representedToolResultIds.add(result.toolCallId);
  }

  const allToolCallIds = [];
  for (const message of messages) {
    for (const id of assistantToolCallIds(message)) {
      if (!allToolCallIds.includes(id)) allToolCallIds.push(id);
    }
  }
  for (const callId of allToolCallIds) {
    if (representedToolResultIds.has(callId)) continue;
    messages.push({
      role: 'tool',
      content: INTERRUPTED_TOOL_RESULT,
      toolCallId: callId,
      toolKind: 'error',
    });
    representedToolResultIds.add(callId);
  }
}

export function createTurnInterruptionTracker() {
  const state = {
    responseStarted: false,
    partialAssistantContent: '',
    tombstonedAssistantContent: '',
    partialReasoningContent: '',
    phase: 'streaming',
    observedToolCalls: new Map(),
    observedToolResults: new Map(),
    // Epochs make the checkpoint journal's delta encoding sound WITHOUT
    // comparing whole buffers on every flush: an epoch bump means "this buffer
    // changed in a way that is not a plain append", so the encoder falls back
    // to a full (still small) set record instead of an append record.
    textEpoch: 0,
    reasoningEpoch: 0,
    tombEpoch: 0,
    callsEpoch: 0,
  };

  return {
    recordTextDelta(chunk) {
      const value = String(chunk ?? '');
      if (!value) return;
      state.responseStarted = true;
      // The replayed attempt has started producing its OWN text, so the
      // retracted tail it replaces is no longer what the user is looking
      // at. Dropping it here keeps exactly one copy of the opening
      // instead of one per retry (a 3-retry stall used to persist four
      // copies of the same first sentence). Reference agents never
      // commit a replayed attempt's discarded stream at all; the
      // tombstone exists only for the window between a retraction and
      // its replacement.
      if (state.tombstonedAssistantContent) {
        state.tombstonedAssistantContent = '';
        state.tombEpoch += 1;
      }
      state.partialAssistantContent += value;
    },
    tombstoneText(chars) {
      const count = Math.max(0, Number(chars) || 0);
      if (!count) return;
      const cutAt = Math.max(0, state.partialAssistantContent.length - count);
      // REPLACE, never accumulate: consecutive retractions belong to
      // successive attempts at the SAME answer, so keeping the earlier
      // tombstone alongside the newer one is what multiplied the visible
      // text across retries.
      state.tombstonedAssistantContent = state.partialAssistantContent.slice(cutAt);
      state.partialAssistantContent = state.partialAssistantContent.slice(0, cutAt);
      state.textEpoch += 1;
      state.tombEpoch += 1;
    },
    restoreTombstonedText() {
      if (!state.tombstonedAssistantContent) return false;
      // Append-only for the partial buffer (no textEpoch bump); only the
      // tombstone side is structurally reset.
      state.partialAssistantContent += state.tombstonedAssistantContent;
      state.tombstonedAssistantContent = '';
      state.tombEpoch += 1;
      return true;
    },
    hasResponseStarted() {
      return state.responseStarted;
    },
    recordReasoningDelta(chunk) {
      const value = String(chunk ?? '');
      if (!value) return;
      state.responseStarted = true;
      state.partialReasoningContent += value;
    },
    recordAssistantText(text) {
      const value = String(text ?? '');
      if (!value.trim()) return;
      state.responseStarted = true;
      // Buffered providers report the whole segment here; streaming
      // providers already accumulated the same segment via text deltas.
      if (!state.partialAssistantContent.trim()) state.partialAssistantContent += value;
    },
    markAssistantMessageCommitted() {
      state.partialAssistantContent = '';
      state.tombstonedAssistantContent = '';
      state.partialReasoningContent = '';
      state.observedToolCalls.clear();
      state.textEpoch += 1;
      state.reasoningEpoch += 1;
      state.tombEpoch += 1;
      state.callsEpoch += 1;
    },
    recordToolCalls(calls, { eagerStarted = false } = {}) {
      for (const call of Array.isArray(calls) ? calls : []) {
        if (!call?.id) continue;
        state.responseStarted = true;
        const prior = state.observedToolCalls.get(call.id);
        state.observedToolCalls.set(call.id, {
          call: { ...call },
          eagerStarted: prior?.eagerStarted === true || eagerStarted === true,
        });
      }
    },
    recordToolResult(message) {
      const callId = message?.toolCallId;
      if (!callId) return;
      state.responseStarted = true;
      if (message.__earlyNotify === true) {
        state.observedToolResults.set(callId, {
          role: 'tool',
          content: message.content == null ? '' : message.content,
          toolCallId: callId,
          toolKind: message.toolKind || (message.isError ? 'error' : null),
        });
      } else {
        // The authoritative result is already present in outgoing.
        state.observedToolResults.delete(callId);
      }
    },
    markProviderSendStarted() {
      state.phase = 'streaming';
    },
    markToolPhaseStarted() {
      state.phase = 'tools';
      state.responseStarted = true;
    },
    snapshot() {
      return {
        responseStarted: state.responseStarted,
        // A reset acknowledged by the UI temporarily tombstones text.
        // A process crash cannot complete that replacement, so retain
        // the same visible bytes the normal error path restores.
        partialAssistantContent: state.partialAssistantContent + state.tombstonedAssistantContent,
        partialReasoningContent: state.partialReasoningContent,
        phase: state.phase,
        observedToolCalls: [...state.observedToolCalls.entries()],
        observedToolResults: [...state.observedToolResults.entries()],
      };
    },
    /**
     * Delta against an opaque cursor from a previous call (null = seed). The
     * checkpoint journal uses this instead of snapshot() so a flush serializes
     * only what changed (see turn-interruption-journal.mjs).
     */
    journalDelta(cursor) {
      return journalDelta(state, cursor);
    },
    finalize({ turnOutgoing, currentUserContent, abortReason = null }) {
      return finalizeInterruptedTurn({
        turnOutgoing,
        currentUserContent,
        responseStarted: state.responseStarted,
        partialAssistantContent: state.partialAssistantContent,
        partialReasoningContent: state.partialReasoningContent,
        observedToolCalls: state.observedToolCalls,
        observedToolResults: state.observedToolResults,
        phase: state.phase,
        abortReason,
      });
    },
  };
}

export function finalizeTurnInterruptionSnapshot({
  turnOutgoing,
  currentUserContent,
  snapshot,
  abortReason = 'process-crash',
}) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  return finalizeInterruptedTurn({
    turnOutgoing,
    currentUserContent,
    responseStarted: source.responseStarted === true,
    partialAssistantContent: String(source.partialAssistantContent || ''),
    partialReasoningContent: String(source.partialReasoningContent || ''),
    observedToolCalls: new Map(Array.isArray(source.observedToolCalls) ? source.observedToolCalls : []),
    observedToolResults: new Map(Array.isArray(source.observedToolResults) ? source.observedToolResults : []),
    phase: source.phase === 'tools' ? 'tools' : 'streaming',
    abortReason,
  });
}
