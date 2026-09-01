import { contextMessagesSignature } from '../context-utils.mjs';
import {
    checkpointMessage,
    findTurnStart,
    turnMessagesForCheckpoint,
} from './turn-checkpoint-journal.mjs';

const TURN_CONTEXT_STATE_VERSION = 1;

function nonNegativeCount(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : null;
}

function compactCheckpointState(compaction) {
    if (!compaction || typeof compaction !== 'object') return null;
    const state = {};
    for (const key of [
        'boundaryTokens',
        'triggerTokens',
        'lastChangedAt',
        'lastCompactAt',
        'lastBeforeTokens',
        'lastAfterTokens',
        'currentEstimatedTokens',
    ]) {
        const value = Number(compaction[key]);
        if (Number.isFinite(value) && value >= 0) state[key] = value;
    }
    return Object.keys(state).length > 0 ? state : null;
}

/**
 * Capture provider usage or a post-compact replacement reading against the
 * same canonical message representation persisted by the checkpoint.
 */
export function captureTurnCheckpointContextState(session, messages, currentUserContent) {
    if (!session || !Array.isArray(messages)) return null;
    const providerCount = nonNegativeCount(session.contextPressureBaselineMessageCount);
    const providerTokens = Number(session.contextPressureBaselineTokens);
    const usageSnapshot = session.contextUsageSnapshot;
    let kind = null;
    let anchorCount = null;
    let usedTokens = null;
    if (providerCount !== null && Number.isFinite(providerTokens) && providerTokens > 0) {
        kind = 'provider';
        anchorCount = providerCount;
        usedTokens = Math.round(providerTokens);
    } else if (usageSnapshot && typeof usageSnapshot === 'object') {
        const snapshotCount = nonNegativeCount(usageSnapshot.messageCount);
        const snapshotTokens = Number(usageSnapshot.usedTokens);
        if (snapshotCount !== null && Number.isFinite(snapshotTokens) && snapshotTokens >= 0) {
            kind = 'post_compact';
            anchorCount = snapshotCount;
            usedTokens = Math.round(snapshotTokens);
        }
    }
    if (!kind || anchorCount === null || anchorCount > messages.length) return null;

    const start = findTurnStart(messages, currentUserContent);
    const fullTranscript = start < 0;
    const committedPrefixCount = fullTranscript ? 0 : start;
    const canonicalTurnMessages = fullTranscript
        ? messages.map(checkpointMessage)
        : turnMessagesForCheckpoint(messages, currentUserContent);
    const turnMessageCount = anchorCount - committedPrefixCount;
    if (turnMessageCount < 0 || turnMessageCount > canonicalTurnMessages.length) return null;

    return {
        version: TURN_CONTEXT_STATE_VERSION,
        kind,
        usedTokens,
        outputTokens: Math.max(0, Math.round(Number(session.contextPressureBaselineOutputTokens) || 0)),
        committedPrefixCount,
        committedPrefixSignature: contextMessagesSignature(messages, committedPrefixCount),
        turnMessageCount,
        turnPrefixSignature: contextMessagesSignature(canonicalTurnMessages, turnMessageCount),
        provider: session.provider || null,
        model: session.model || null,
        toolSchemaSignature: kind === 'provider'
            ? session.contextPressureBaselineToolSignature || null
            : usageSnapshot?.toolSchemaSignature || null,
        requestReserveTokens: kind === 'provider'
            ? Math.max(0, Math.round(Number(session.contextPressureBaselineRequestReserveTokens) || 0))
            : 0,
        boundary: kind === 'provider'
            ? (session.contextPressureBaselineBoundary === 'request' ? 'request' : 'complete')
            : 'complete',
        updatedAt: Math.max(0, Math.round(Number(
            kind === 'provider'
                ? session.contextPressureBaselineUpdatedAt
                : usageSnapshot?.updatedAt,
        ) || Date.now())),
        ...(kind === 'post_compact' ? { usageSnapshot: { ...usageSnapshot } } : {}),
        compaction: compactCheckpointState(session.compaction),
    };
}

function checkpointContextSliceMatches(messages, state) {
    const committedPrefixCount = nonNegativeCount(state?.committedPrefixCount);
    const turnMessageCount = nonNegativeCount(state?.turnMessageCount);
    if (committedPrefixCount === null || turnMessageCount === null) return false;
    if (committedPrefixCount + turnMessageCount > messages.length) return false;
    if (contextMessagesSignature(messages, committedPrefixCount)
        !== String(state.committedPrefixSignature || '')) return false;
    const turnPrefix = messages.slice(
        committedPrefixCount,
        committedPrefixCount + turnMessageCount,
    );
    return contextMessagesSignature(turnPrefix, turnPrefix.length)
        === String(state.turnPrefixSignature || '');
}

function legacyProviderBaselineMatches(session) {
    const count = nonNegativeCount(session?.contextPressureBaselineMessageCount);
    return count !== null
        && count <= (Array.isArray(session?.messages) ? session.messages.length : 0)
        && String(session.contextPressureBaselinePrefixSignature || '')
            === contextMessagesSignature(session.messages, count);
}

function markUnanchoredContext(session) {
    const retainedTokens = Number(session.contextPressureBaselineTokens)
        || Number(session.contextUsageSnapshot?.usedTokens)
        || Number(session.lastContextTokens)
        || 0;
    if (retainedTokens <= 0) return;
    session.contextPressureUnanchoredAfterRestart = true;
    session.contextPressureUnanchoredReason = 'checkpoint_context_mismatch';
}

export function restoreTurnCheckpointContextState(session, checkpoint) {
    if (!session || !Array.isArray(session.messages)) return false;
    const state = checkpoint?.contextState;
    const rawUsedTokens = Number(state?.usedTokens);
    if (!state || state.version !== TURN_CONTEXT_STATE_VERSION
        || !Number.isFinite(rawUsedTokens) || rawUsedTokens < 0
        || String(state.provider || '') !== String(session.provider || '')
        || String(state.model || '') !== String(session.model || '')
        || !checkpointContextSliceMatches(session.messages, state)) {
        if (legacyProviderBaselineMatches(session)) {
            delete session.contextPressureUnanchoredAfterRestart;
            delete session.contextPressureUnanchoredReason;
            return true;
        }
        markUnanchoredContext(session);
        return false;
    }

    const count = state.committedPrefixCount + state.turnMessageCount;
    const usedTokens = Math.max(0, Math.round(rawUsedTokens));
    session.contextPressureBaselineTokens = usedTokens;
    session.contextPressureBaselineOutputTokens = Math.max(
        0,
        Math.round(Number(state.outputTokens) || 0),
    );
    session.contextPressureBaselineMessageCount = count;
    session.contextPressureBaselinePrefixSignature = contextMessagesSignature(session.messages, count);
    session.contextPressureBaselineProvider = session.provider || null;
    session.contextPressureBaselineModel = session.model || null;
    session.contextPressureBaselineToolSignature = state.toolSchemaSignature || null;
    session.contextPressureBaselineRequestReserveTokens = Math.max(
        0,
        Math.round(Number(state.requestReserveTokens) || 0),
    );
    session.contextPressureBaselineBoundary = state.boundary === 'request' ? 'request' : 'complete';
    session.contextPressureBaselineUpdatedAt = Math.max(
        0,
        Math.round(Number(state.updatedAt) || Date.now()),
    );
    session.contextPressureBaselineSource = state.kind === 'post_compact'
        ? 'checkpoint_post_compact'
        : 'checkpoint_provider';
    session.lastContextTokens = usedTokens;
    session.lastContextTokensUpdatedAt = session.contextPressureBaselineUpdatedAt;
    session.lastContextTokensStaleAfterCompact = false;
    if (state.kind === 'post_compact' && state.usageSnapshot) {
        session.contextUsageSnapshot = {
            ...state.usageSnapshot,
            usedTokens,
            messageCount: count,
            messagesSignature: session.contextPressureBaselinePrefixSignature,
        };
        if (state.usageSnapshot.usageMetricsTurnId) {
            session.usageMetricsTurnId = state.usageSnapshot.usageMetricsTurnId;
        }
        if (Number.isFinite(Number(state.usageSnapshot.usageMetricsEpoch))) {
            session.usageMetricsEpoch = Number(state.usageSnapshot.usageMetricsEpoch);
        }
    }
    if (state.compaction && typeof state.compaction === 'object') {
        session.compaction = {
            ...(session.compaction || {}),
            ...state.compaction,
        };
    }
    delete session.contextPressureUnanchoredAfterRestart;
    delete session.contextPressureUnanchoredReason;
    return true;
}
