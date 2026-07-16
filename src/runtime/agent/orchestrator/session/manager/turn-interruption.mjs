import { sanitizeToolPairs } from '../context-utils.mjs';
import {
    isInternalRuntimeNotificationText,
    promptContentText,
} from './prompt-utils.mjs';
import { filterModelVisibleSessionMessages } from './message-sanitize.mjs';

const INTERRUPT_MESSAGE = '[Request interrupted by user]';
const INTERRUPT_MESSAGE_FOR_TOOL_USE = '[Request interrupted by user for tool use]';
const STREAMING_INTERRUPTED_TOOL_RESULT = 'Interrupted by user';
const TOOL_USE_REJECT_RESULT = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

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

function rewindProvisionalUserTurn(messages, currentUserContent) {
    const currentText = promptContentText(currentUserContent);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message?.role !== 'user') continue;
        if (message.content === currentUserContent
            || promptContentText(message.content) === currentText) {
            // Remove the provisional user turn plus pre-send hooks appended
            // after it, while retaining any compaction rewrite before it.
            messages.splice(i);
            break;
        }
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
    const preserveResponse = responseStarted
        && !isInternalRuntimeNotificationText(currentUserContent);
    if (!preserveResponse) {
        return {
            messages: rewindProvisionalUserTurn(messages, currentUserContent),
            responsePreserved: false,
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
            content: executionStarted
                ? TOOL_USE_REJECT_RESULT
                : STREAMING_INTERRUPTED_TOOL_RESULT,
            toolCallId: callId,
            toolKind: 'error',
        });
        representedToolResultIds.add(callId);
    }

    const pairedMessages = sanitizeToolPairs(messages);
    // Claude Code omits the synthetic marker when a queued user submission
    // interrupted the active request; that queued message is the boundary.
    if (abortReason !== 'interrupt') {
        pairedMessages.push({
            role: 'user',
            content: phase === 'tools'
                ? INTERRUPT_MESSAGE_FOR_TOOL_USE
                : INTERRUPT_MESSAGE,
        });
    }
    return { messages: pairedMessages, responsePreserved: true };
}

export function createTurnInterruptionTracker() {
    let responseStarted = false;
    let partialAssistantContent = '';
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
