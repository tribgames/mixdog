// manager/message-sanitize.mjs
// Message sanitization + compaction-failure persistence helpers extracted
// verbatim from manager.mjs. sanitizeSessionMessagesForModel drops internal
// runtime-notification turns and cancelled-assistant stubs while keeping image
// content intact (reference-agent parity); the compact-failure helpers persist
// a compacted outgoing transcript when an ask throws mid-turn.
import { promptContentText, isInternalRuntimeNotificationText } from './prompt-utils.mjs';
import { saveSessionAsync } from '../store.mjs';
import { _getRuntimeEntry } from './runtime-liveness.mjs';

function isInternalCancelledAssistantMessage(message) {
    if (!message || message.role !== 'assistant') return false;
    if (message.cancelled === true) return true;
    const text = promptContentText(message.content).trim();
    return /^\[cancelled\]\s+This turn was interrupted before completion\./i.test(text)
        || /Preserve the user request above as the active task context/i.test(text);
}

export function sanitizeSessionMessagesForModel(messages) {
    // Drop internal runtime-notification turns and cancelled-assistant stubs so
    // they never reach the model, but KEEP image content intact. Reference-agent
    // parity: the live transcript and every model request retain attached
    // images across turns; only the compaction-summary call strips them. The
    // disk-stored session JSON replaces image bytes with a text placeholder at
    // serialization time (see store.mjs), so this no longer touches images.
    if (!Array.isArray(messages) || messages.length === 0) return [];
    const out = [];
    let droppingInternalTurn = false;
    for (const message of messages) {
        if (isInternalCancelledAssistantMessage(message)) {
            droppingInternalTurn = false;
            continue;
        }
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
    if (!activeSession || activeSession.closed === true) return;
    if (!Array.isArray(turnOutgoing) || turnOutgoing.length === 0) return;
    const currentRuntime = _getRuntimeEntry(sessionId);
    if (currentRuntime?.closed || currentRuntime?.generation !== askGeneration) return;
    const sanitized = sanitizeSessionMessagesForModel(turnOutgoing);
    const priorSanitized = sanitizeSessionMessagesForModel(
        Array.isArray(activeSession.messages) ? activeSession.messages : [],
    );
    const messagesAdvanced = sessionMessagesAdvancedBeyondCompactedOutgoing(priorSanitized, sanitized);
    const applied = applyCompactFailurePersistToSession(activeSession, {
        priorSanitized,
        sanitized,
        messagesAdvanced,
        error,
    });
    if (!applied) return;
    try {
        await saveSessionAsync(activeSession, { expectedGeneration: askGeneration });
    } catch { /* best-effort: preserve in-memory compaction even if disk is slow */ }
    if (currentRuntime) currentRuntime.session = activeSession;
}
