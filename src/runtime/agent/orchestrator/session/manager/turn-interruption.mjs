import { sanitizeToolPairs } from '../context-utils.mjs';
import {
    isInternalRuntimeNotificationText,
    promptContentText,
} from './prompt-utils.mjs';
import { filterModelVisibleSessionMessages } from './message-sanitize.mjs';

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

function assistantToolCallIds(message) {
    if (!message || message.role !== 'assistant') return [];
    const ids = [];
    const seen = new Set();
    const add = (id) => {
        if (!id || seen.has(id)) return;
        seen.add(id);
        ids.push(id);
    };
    for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) add(call?.id);
    for (const blocks of [message.assistantBlocks, message.content]) {
        if (!Array.isArray(blocks)) continue;
        for (const block of blocks) {
            if (block?.type === 'tool_use') add(block.id);
        }
    }
    return ids;
}

function provisionalUserTurnIndex(messages, currentUserContent) {
    const currentText = promptContentText(currentUserContent);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message?.role !== 'user') continue;
        if (message.content === currentUserContent
            || promptContentText(message.content) === currentText) {
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
    const userCancelled = abortReason == null
        || USER_CANCEL_ABORT_REASONS.has(abortReason);
    // A turn cancelled while the model was only thinking
    // produced no model-visible message, so the provisional user turn is
    // rewound and the prompt goes back to the input box. Anything the model
    // actually said or did — committed messages from this turn, buffered text,
    // tool calls/results — keeps the turn (reasoning alone does not).
    const producedOutput = String(partialAssistantContent || '').trim() !== ''
        || observedToolCalls.size > 0
        || observedToolResults.size > 0
        || (() => {
            const index = provisionalUserTurnIndex(messages, currentUserContent);
            return index >= 0 && index < messages.length - 1;
        })();
    const preserveResponse = responseStarted
        && !isInternalRuntimeNotificationText(currentUserContent)
        && (producedOutput || !userCancelled);
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
        messages
            .filter((message) => message?.role === 'tool' && message.toolCallId)
            .map((message) => message.toolCallId),
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
        const observed = observedToolCalls.get(callId);
        const executionStarted = phase === 'tools' || observed?.eagerStarted === true;
        messages.push({
            role: 'tool',
            content: INTERRUPTED_TOOL_RESULT,
            toolCallId: callId,
            toolKind: 'error',
        });
        representedToolResultIds.add(callId);
    }

    const pairedMessages = sanitizeToolPairs(messages);
    // The synthetic marker is omitted when a queued user submission
    // interrupted the active request; that queued message is the boundary.
    if (abortReason !== 'interrupt' && abortReason !== 'provider-error') {
        pairedMessages.push({
            role: 'user',
            content: abortReason === 'process-crash'
                ? PROCESS_RESTART_INTERRUPT_MESSAGE
                : userCancelled
                    ? (phase === 'tools' ? INTERRUPT_MESSAGE_FOR_TOOL_USE : INTERRUPT_MESSAGE)
                    : SESSION_INTERRUPT_MESSAGE,
        });
    }
    return { messages: pairedMessages, responsePreserved: true, userTurnPreserved: true };
}

export function createTurnInterruptionTracker() {
    let responseStarted = false;
    let partialAssistantContent = '';
    let tombstonedAssistantContent = '';
    let partialReasoningContent = '';
    let phase = 'streaming';
    const observedToolCalls = new Map();
    const observedToolResults = new Map();

    return {
        recordTextDelta(chunk) {
            const value = String(chunk ?? '');
            if (!value) return;
            responseStarted = true;
            partialAssistantContent += value;
        },
        tombstoneText(chars) {
            const count = Math.max(0, Number(chars) || 0);
            if (!count) return;
            const cutAt = Math.max(0, partialAssistantContent.length - count);
            tombstonedAssistantContent = partialAssistantContent.slice(cutAt)
                + tombstonedAssistantContent;
            partialAssistantContent = partialAssistantContent.slice(
                0,
                cutAt,
            );
        },
        restoreTombstonedText() {
            if (!tombstonedAssistantContent) return false;
            partialAssistantContent += tombstonedAssistantContent;
            tombstonedAssistantContent = '';
            return true;
        },
        hasResponseStarted() {
            return responseStarted;
        },
        recordReasoningDelta(chunk) {
            const value = String(chunk ?? '');
            if (!value) return;
            responseStarted = true;
            partialReasoningContent += value;
        },
        recordAssistantText(text) {
            const value = String(text ?? '');
            if (!value.trim()) return;
            responseStarted = true;
            // Buffered providers report the whole segment here; streaming
            // providers already accumulated the same segment via text deltas.
            if (!partialAssistantContent.trim()) partialAssistantContent += value;
        },
        markAssistantMessageCommitted() {
            partialAssistantContent = '';
            tombstonedAssistantContent = '';
            partialReasoningContent = '';
            observedToolCalls.clear();
        },
        recordToolCalls(calls, { eagerStarted = false } = {}) {
            for (const call of Array.isArray(calls) ? calls : []) {
                if (!call?.id) continue;
                responseStarted = true;
                const prior = observedToolCalls.get(call.id);
                observedToolCalls.set(call.id, {
                    call: { ...call },
                    eagerStarted: prior?.eagerStarted === true || eagerStarted === true,
                });
            }
        },
        recordToolResult(message) {
            const callId = message?.toolCallId;
            if (!callId) return;
            responseStarted = true;
            if (message.__earlyNotify === true) {
                observedToolResults.set(callId, {
                    role: 'tool',
                    content: message.content == null ? '' : message.content,
                    toolCallId: callId,
                    toolKind: message.toolKind || (message.isError ? 'error' : null),
                });
            } else {
                // The authoritative result is already present in outgoing.
                observedToolResults.delete(callId);
            }
        },
        markProviderSendStarted() {
            phase = 'streaming';
        },
        markToolPhaseStarted() {
            phase = 'tools';
            responseStarted = true;
        },
        snapshot() {
            return {
                responseStarted,
                // A reset acknowledged by the UI temporarily tombstones text.
                // A process crash cannot complete that replacement, so retain
                // the same visible bytes the normal error path restores.
                partialAssistantContent: partialAssistantContent + tombstonedAssistantContent,
                partialReasoningContent,
                phase,
                observedToolCalls: [...observedToolCalls.entries()],
                observedToolResults: [...observedToolResults.entries()],
            };
        },
        finalize({ turnOutgoing, currentUserContent, abortReason = null }) {
            return finalizeInterruptedTurn({
                turnOutgoing,
                currentUserContent,
                responseStarted,
                partialAssistantContent,
                partialReasoningContent,
                observedToolCalls,
                observedToolResults,
                phase,
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
