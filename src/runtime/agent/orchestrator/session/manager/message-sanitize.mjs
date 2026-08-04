// Model-visible session filtering and compaction-failure persistence.
import { isInternalRuntimeNotificationText } from './prompt-utils.mjs';
import { saveSessionAsync } from '../store.mjs';
import { _getRuntimeEntry } from './runtime-liveness.mjs';

export function filterModelVisibleSessionMessages(messages) {
    // Internal runtime notifications and their synthetic responses never enter
    // model history. Image content remains intact; the store replaces image
    // bytes only in its disk serialization snapshot.
    if (!Array.isArray(messages) || messages.length === 0) return [];
    const out = [];
    let droppingInternalTurn = false;
    for (const message of messages) {
        if (message?.role === 'user' && isInternalRuntimeNotificationText(message.content)) {
            droppingInternalTurn = true;
            continue;
        }
        if (droppingInternalTurn) {
            if (message?.role === 'user') {
                droppingInternalTurn = false;
            } else {
                continue;
            }
        }
        out.push(message);
    }
    return out;
}

function sessionMessagesSnapshotChanged(before, after) {
    if (!Array.isArray(before) || !Array.isArray(after)) return before !== after;
    if (before.length !== after.length) return true;
    for (let i = 0; i < before.length; i += 1) {
        if (before[i] !== after[i]) return true;
        try {
            if (JSON.stringify(before[i]) !== JSON.stringify(after[i])) return true;
        } catch {
            return true;
        }
    }
    return false;
}

function isCompactedOutgoingFinalAssistantMessage(message) {
    if (!message || message.role !== 'assistant') return false;
    if (message.emptyFinal === true) return true;
    return true;
}

function sessionMessagesAdvancedBeyondCompactedOutgoing(currentSanitized, compactedSanitized) {
    if (!Array.isArray(currentSanitized) || !Array.isArray(compactedSanitized)) return false;
    if (currentSanitized.length !== compactedSanitized.length + 1) return false;
    const prefix = currentSanitized.slice(0, compactedSanitized.length);
    if (sessionMessagesSnapshotChanged(compactedSanitized, prefix)) return false;
    return isCompactedOutgoingFinalAssistantMessage(currentSanitized[currentSanitized.length - 1]);
}

function messageSnapshotPresent(messages, wanted) {
    if (!wanted || !Array.isArray(messages)) return false;
    return messages.some((message) => {
        if (message === wanted) return true;
        try { return JSON.stringify(message) === JSON.stringify(wanted); } catch { return false; }
    });
}

export function compactedOutgoingPromptRetained(activeMessages, outgoingMessages) {
    const outgoing = filterModelVisibleSessionMessages(outgoingMessages);
    const prompt = [...outgoing].reverse().find((message) => message?.role === 'user');
    return Boolean(prompt) && messageSnapshotPresent(filterModelVisibleSessionMessages(activeMessages), prompt);
}

export const _sessionMessagesAdvancedBeyondCompactedOutgoing = sessionMessagesAdvancedBeyondCompactedOutgoing;

function applyCompactFailurePersistToSession(activeSession, {
    priorSanitized,
    sanitized,
    messagesAdvanced,
    error = null,
}) {
    if (!messagesAdvanced && !sessionMessagesSnapshotChanged(priorSanitized, sanitized)) return false;
    if (!messagesAdvanced) {
        activeSession.messages = sanitized;
        activeSession.providerState = undefined;
    }
    activeSession.updatedAt = Date.now();
    activeSession.lastUsedAt = Date.now();
    if (activeSession.compaction && typeof activeSession.compaction === 'object'
        && (activeSession.compaction.lastStage === 'compacting'
            || activeSession.compaction.lastStage === 'overflow_failed')) {
        const prev = activeSession.compaction;
        const cause = error?.cause;
        const overflow = error?.code === 'AGENT_CONTEXT_OVERFLOW';
        activeSession.compaction = {
            ...prev,
            lastStage: prev.lastStage === 'overflow_failed'
                ? 'overflow_failed'
                : (overflow ? 'overflow_failed' : 'failed'),
            lastCheckedAt: Date.now(),
            lastError: prev.lastError || cause?.message || error?.message || null,
            lastSemanticError: prev.lastSemanticError || cause?.message || null,
            lastRecallFastTrackError: prev.lastRecallFastTrackError
                || (cause?.message && String(cause?.name || '').includes('Recall') ? cause.message : null),
        };
    }
    return true;
}

export const _applyCompactFailurePersistToSession = applyCompactFailurePersistToSession;

export async function persistCompactedOutgoingAfterAskFailure({
    sessionId,
    activeSession,
    askGeneration,
    turnOutgoing,
    error = null,
}) {
    if (!activeSession || activeSession.closed === true) return false;
    if (!Array.isArray(turnOutgoing) || turnOutgoing.length === 0) return false;
    const currentRuntime = _getRuntimeEntry(sessionId);
    if (currentRuntime?.closed || currentRuntime?.generation !== askGeneration) return false;
    const sanitized = filterModelVisibleSessionMessages(turnOutgoing);
    const priorSanitized = filterModelVisibleSessionMessages(
        Array.isArray(activeSession.messages) ? activeSession.messages : [],
    );
    const messagesAdvanced = sessionMessagesAdvancedBeyondCompactedOutgoing(priorSanitized, sanitized);
    const promptRetainedBefore = compactedOutgoingPromptRetained(priorSanitized, sanitized);
    const applied = applyCompactFailurePersistToSession(activeSession, {
        priorSanitized,
        sanitized,
        messagesAdvanced,
        error,
    });
    if (!applied) return promptRetainedBefore;
    try {
        await saveSessionAsync(activeSession, { expectedGeneration: askGeneration });
    } catch { /* best-effort: preserve in-memory compaction even if disk is slow */ }
    if (currentRuntime) currentRuntime.session = activeSession;
    return compactedOutgoingPromptRetained(activeSession.messages, sanitized);
}
