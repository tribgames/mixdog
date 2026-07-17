// src/runtime/agent/orchestrator/session/manager.mjs
// Thin facade over the split session-manager modules in ./manager/. This file
// re-exports the EXACT public surface the previous monolith exposed so every
// importer (loop.mjs, loop/tool-exec.mjs, agent-dispatch.mjs, session-builder,
// abort-lookup, statusline-agents, headless-role, session-runtime, and the
// smoke scripts) keeps resolving its symbols through manager.mjs unchanged.
//
// Module map:
//   manager/runtime-liveness.mjs       — in-memory stage/heartbeat + accessors
//   manager/tool-resolution.mjs        — tool policy resolution/narrowing
//   manager/context-meta.mjs           — context-window / compact-trigger meta
//   manager/prompt-utils.mjs           — prompt content shaping helpers
//   manager/pending-messages.mjs       — pending-send queue (enqueue/drain)
//   manager/usage-metrics.mjs          — usage accounting / persistence
//   manager/rules-cache.mjs            — cached rule builders
//   manager/status-telemetry.mjs       — standalone status telemetry
//   manager/compaction-runner.mjs      — session compaction runner
//   manager/session-errors.mjs         — SessionClosedError
//   manager/runtime-loaders.mjs        — lazy code_graph/agent-loop/bash bridges
//   manager/agent-runtime-singleton.mjs— injected Agent Runtime singleton
//   manager/session-id.mjs             — monotonic session-id minting
//   manager/provider-cache-key.mjs     — provider-scoped cache key
//   manager/prefetch-bridge.mjs        — explicit-prefetch bridge
//   manager/message-sanitize.mjs       — model-message sanitize + fail persist
//   manager/session-lock.mjs           — per-session ask mutex
//   manager/session-lifecycle.mjs      — createSession/updateRoute/resume
//   manager/ask-session.mjs            — askSession + abort-aware call wrapper
//   manager/session-crud.mjs           — read/clear/compact/status/flush
//   manager/session-close.mjs          — closeSession/abortSessionTurn
//   manager/idle-cleanup.mjs           — periodic idle/tombstone sweep
import { configureRuntimeLiveness } from './manager/runtime-liveness.mjs';
import { loadSession, saveSessionAsync } from './store.mjs';

// Wire the store deps the liveness module needs without importing store.mjs
// back into it via manager.mjs (avoids re-entry / keeps one store contract).
configureRuntimeLiveness({ loadSession, saveSessionAsync });

// ── Runtime-liveness surface ──────────────────────────────────────────────
// External importers (loop.mjs, loop/tool-exec.mjs, agent-dispatch.mjs,
// abort-lookup.mjs, statusline-agents.mjs) resolve these through manager.mjs.
export {
    updateSessionStage,
    markSessionAskStart,
    markSessionStreamDelta,
    markSessionToolCall,
    markSessionDone,
    markSessionEmptyFinal,
    markSessionError,
    markSessionCancelled,
    getSessionRuntime,
    isSessionCompactionBlocked,
    getSessionProgressSnapshot,
    forEachSessionRuntime,
    hideSessionFromList,
    getSessionAbortSignal,
    getSessionLastProgressAt,
    linkParentSignalToSession,
} from './manager/runtime-liveness.mjs';

// ── Tool resolution / pending messages / prompt utils ─────────────────────
export { previewSessionTools } from './manager/tool-resolution.mjs';
export {
    _mergePendingMessageEntries,
    enqueuePendingMessage,
    drainPendingMessages,
    markCompletionEntry,
    COMPLETION_NOTIFICATION_KIND,
} from './manager/pending-messages.mjs';
export { isInternalRuntimeNotificationText as _isInternalRuntimeNotificationText } from './manager/prompt-utils.mjs';

// ── Usage-metrics surface — re-exported unchanged so loop.mjs / smoke scripts
//    keep resolving these through the facade. ────────────────────────────────
export {
    bumpUsageMetricsTurnId,
    resolveUsageMetricsTurnId,
    bumpUsageMetricsEpoch,
    resolveUsageMetricsEpoch,
    usageMetricsSourceKey,
    usageMetricsIdempotencyKey,
    applyAskTerminalUsageTotals,
    persistIterationMetrics,
} from './manager/usage-metrics.mjs';

// ── Rules builders — deep importers of the old symbol names resolve here. ──
export {
    _buildSharedRules,
    _buildAgentRules,
    _buildLeadRules,
    _buildLeadMetaContext,
    _buildAgentSpecific,
} from './manager/rules-cache.mjs';

// ── Test-only aliases for the legacy auto-compact-limit migration +
//    buffer-config preservation (scripts/compact-trigger-migration-smoke.mjs). ─
import {
    resolveSessionContextMeta,
    compactTriggerForSession,
    preserveBufferConfigFields,
} from './manager/context-meta.mjs';
export const _resolveSessionContextMeta = resolveSessionContextMeta;
export const _compactTriggerForSession = compactTriggerForSession;
export const _preserveBufferConfigFields = preserveBufferConfigFields;

// ── Session lifecycle / ask / crud / close / cleanup ──────────────────────
export { SessionClosedError } from './manager/session-errors.mjs';
export { setAgentRuntime } from './manager/agent-runtime-singleton.mjs';
export { createSession, updateSessionRoute, resumeSession } from './manager/session-lifecycle.mjs';
export { askSession, _api_call_with_interrupt } from './manager/ask-session.mjs';
export {
    _sessionMessagesAdvancedBeyondCompactedOutgoing,
    _applyCompactFailurePersistToSession,
} from './manager/message-sanitize.mjs';
export {
    getSession,
    listSessions,
    findSessionByScopeKey,
    clearSessionMessages,
    compactSessionMessages,
    updateSessionStatus,
    flushSessionMetrics,
} from './manager/session-crud.mjs';
export { deleteSession } from './store.mjs';
export { closeSession, abortSessionTurn } from './manager/session-close.mjs';
export { sweepTombstones, startIdleCleanup, stopIdleCleanup } from './manager/idle-cleanup.mjs';
