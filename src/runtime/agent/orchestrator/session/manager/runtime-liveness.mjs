// ── Runtime liveness map ──────────────────────────────────────────────
// In-memory only. Tracks per-session stage + stream heartbeat so agent type=list
// can surface whether a session is actually alive vs stuck. Never persisted —
// heartbeats would otherwise churn the session JSON on every SSE delta.
//
// Extracted from manager.mjs (pass-3). The Map and its timer companion are
// module-level singletons — preserving the baseline's single-process shape.
// manager.mjs owns askSession's controller/generation lifecycle and calls the
// accessors below via imports; a small set of accessors that need the session
// store / provider registry are injected through configureRuntimeLiveness() to
// avoid a circular import back into manager.mjs.
//
// Entry shape: {
//   stage, lastStreamDeltaAt, lastTransportAt, firstSemanticAt,
//   lastSemanticAt, lastReasoningAt, lastVisibleTextAt, lastToolProtocolAt,
//   lastToolCall, lastError, updatedAt,
//   controller?: AbortController,  // set while an ask is in flight
//   generation?: number,            // snapshot taken at ask start
//   closed?: boolean,               // flipped by closeSession()
// }
import { createAbortController } from '../../../../shared/abort-controller.mjs';
import { publishHeartbeat, deleteHeartbeat } from '../store.mjs';
import { DEFAULT_ACTIVITY_HEARTBEAT_MS } from '../../stall-policy.mjs';
import {
    configureUsageMetricsRuntime,
    dropMetricSeenState,
    bumpUsageMetricsTurnId,
} from './usage-metrics.mjs';

const HEARTBEAT_THROTTLE_MS = 60_000; // 60s

const _runtimeState = new Map();
const _toolActivityHeartbeats = new Map();
const VALID_STAGES = new Set([
    'connecting', 'requesting', 'streaming', 'tool_running', 'idle', 'error', 'done', 'cancelling',
]);
const TERMINAL_STAGES = new Set(['done', 'error']);

// Injected deps that would otherwise pull manager.mjs's store/provider surface
// back into this module (circular). Wired once from manager.mjs at load time.
let _deps = {
    loadSession: () => null,
    saveSessionAsync: async () => {},
};
export function configureRuntimeLiveness(deps = {}) {
    _deps = { ..._deps, ...deps };
}

export function _touchRuntime(id) {
    let entry = _runtimeState.get(id);
    if (!entry) {
        entry = {
            stage: 'idle',
            lastStreamDeltaAt: null,
            lastTransportAt: null,
            firstSemanticAt: null,
            lastSemanticAt: null,
            lastReasoningAt: null,
            lastVisibleTextAt: null,
            lastToolProtocolAt: null,
            lastToolCall: null,
            lastError: null,
            updatedAt: Date.now(),
        };
        _runtimeState.set(id, entry);
    }
    return entry;
}

export function _stopToolActivityHeartbeat(id) {
    if (!id) return;
    const timer = _toolActivityHeartbeats.get(id);
    if (!timer) return;
    try { clearInterval(timer); } catch { /* ignore */ }
    _toolActivityHeartbeats.delete(id);
}

function _touchSessionActivityProgress(id) {
    const entry = _runtimeState.get(id);
    if (!entry || entry.closed || entry.controller?.signal?.aborted) return;
    if (entry.stage !== 'tool_running') return;
    const now = Date.now();
    entry.lastProgressAt = now;
    entry.updatedAt = now;
    publishHeartbeat(id, now);
}

function _startToolActivityHeartbeat(id) {
    _stopToolActivityHeartbeat(id);
    if (!(DEFAULT_ACTIVITY_HEARTBEAT_MS > 0)) return;
    const timer = setInterval(() => _touchSessionActivityProgress(id), DEFAULT_ACTIVITY_HEARTBEAT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    _toolActivityHeartbeats.set(id, timer);
}

export function updateSessionStage(id, stage) {
    if (!id || !VALID_STAGES.has(stage)) return;
    const entry = _touchRuntime(id);
    const now = Date.now();
    const priorStage = entry.stage;
    entry.stage = stage;
    if (stage === 'requesting' && priorStage !== 'requesting') {
        entry.modelRequestStartedAt = now;
    }
    entry.lastProgressAt = now;
    entry.updatedAt = now;
    if (stage !== 'tool_running') _stopToolActivityHeartbeat(id);
}

/**
 * Reset heartbeat-visible fields for a new ask. Preserves controller/generation/
 * closed (lifecycle) but clears the previous run's streaming state so stale
 * lastToolCall / lastStreamDeltaAt from the previous ask don't leak into the
 * new one.
 */
export function markSessionAskStart(id) {
    if (!id) return;
    _stopToolActivityHeartbeat(id);
    const entry = _touchRuntime(id);
    entry.usageMetricsTurnIncremental = false;
    const sessionForTurn = entry.session ?? _deps.loadSession(id);
    if (sessionForTurn) bumpUsageMetricsTurnId(sessionForTurn);
    entry.stage = 'connecting';
    entry.lastStreamDeltaAt = null;
    entry.lastTransportAt = null;
    entry.firstSemanticAt = null;
    entry.lastSemanticAt = null;
    entry.lastReasoningAt = null;
    entry.lastVisibleTextAt = null;
    entry.lastToolProtocolAt = null;
    entry.lastSemanticKind = null;
    entry.transportTrackingEnabled = false;
    entry.lastToolCall = null;
    entry.toolStartedAt = null;
    entry.toolSelfDeadlineMs = null;
    entry.lastError = null;
    // A new ask starts a fresh turn lifecycle — clear any stale empty-final
    // classification from the prior turn so inspectBridgeEntry doesn't keep
    // short-circuiting to 'empty-synthesis' (which would disable stall
    // detection for the entire new turn).
    entry.emptyFinal = false;
    entry.emptyFinalAt = null;
    // askStartedAt tracks the turn, but request/watchdog clocks begin only
    // after provider admission (the scheduler emits stage=requesting).
    const now = Date.now();
    entry.askStartedAt = now;
    entry.modelRequestStartedAt = null;
    entry.lastProgressAt = now;
    entry.updatedAt = now;
    // Publish heartbeat immediately so the status aggregator picks the
    // session up in the connecting / requesting window. Without this the
    // .hb file only landed on the first stream chunk — producing a 3–10s
    // (xhigh: 30s+) invisible gap where agent sessions ran but the CC
    // statusline showed no maintenance/agent badge. STREAM_FRESH_MS (5 min)
    // still drops a session whose provider truly never returns a chunk;
    // markSessionStreamDelta keeps refreshing once chunks arrive.
    publishHeartbeat(id, now);
}
export function enableSessionTransportTracking(id) {
    if (!id) return;
    const entry = _runtimeState.get(id);
    if (!entry || entry.closed || entry.controller?.signal?.aborted) return;
    entry.transportTrackingEnabled = true;
}
export function disableSessionTransportTracking(id) {
    if (!id) return;
    const entry = _runtimeState.get(id);
    if (!entry) return;
    entry.transportTrackingEnabled = false;
}
export function markSessionTransportActivity(id) {
    if (!id) return;
    const entry = _runtimeState.get(id);
    if (!entry || entry.closed || entry.controller?.signal?.aborted) return;
    const now = Date.now();
    entry.lastTransportAt = now;
    entry.updatedAt = now;
    publishHeartbeat(id, now);
}
function _normalizeModelProgressKind(kind) {
    const value = typeof kind === 'string'
        ? kind
        : (kind && typeof kind.kind === 'string' ? kind.kind : 'semantic');
    if (value === 'transport' || value === 'reasoning' || value === 'text' || value === 'tool') {
        return value;
    }
    return 'semantic';
}
export async function markSessionStreamDelta(id, kind = 'semantic') {
    if (!id) return;
    // Non-creating lookup: a live ask ALWAYS has a runtime entry (markSessionAskStart
    // creates it before streaming begins). _touchRuntime would instead resurrect a
    // blank entry — and closeSession()/idle-sweep clear _runtimeState on a deferred
    // tick while a detached provider stream may still be trickling deltas. A delta
    // arriving after that clear must NOT re-create an entry or it would republish the
    // .hb heartbeat that markSessionClosed deleted, orphaning a dead session's
    // heartbeat indefinitely (the disk tombstone blocks ask resumption but not this
    // path). Skip a missing, tombstoned, or aborted entry — never refresh liveness.
    const entry = _runtimeState.get(id);
    if (!entry || entry.closed || entry.controller?.signal?.aborted) return;
    const progressKind = _normalizeModelProgressKind(kind);
    if (progressKind === 'transport') {
        markSessionTransportActivity(id);
        return;
    }
    _stopToolActivityHeartbeat(id);
    const now = Date.now();
    // Every semantic model event also proves transport health. The inverse is
    // intentionally false: raw chunks/keepalives update only lastTransportAt.
    entry.lastTransportAt = now;
    if (!entry.firstSemanticAt) entry.firstSemanticAt = now;
    entry.lastSemanticAt = now;
    entry.lastSemanticKind = progressKind;
    if (progressKind === 'reasoning') entry.lastReasoningAt = now;
    if (progressKind === 'text') entry.lastVisibleTextAt = now;
    if (progressKind === 'tool') entry.lastToolProtocolAt = now;
    entry.lastStreamDeltaAt = now;
    entry.lastProgressAt = now;
    // Only promote to 'streaming' if we were in a pre-stream stage; never downgrade
    // mid-tool (tool_running has its own delta source if the tool streams back).
    if (entry.stage === 'connecting' || entry.stage === 'requesting') {
        entry.stage = 'streaming';
    }
    // Lightweight heartbeat (≤5s self-throttled) for the status aggregator.
    // Disk-side session.lastHeartbeatAt below is the heavy 60s zombie-reaper
    // signal; the .hb file is the fast fresh-session signal consumed by the
    // status line.
    publishHeartbeat(id, now);
    const session = entry.session;
    if (session && now - (session.lastHeartbeatAt || 0) > HEARTBEAT_THROTTLE_MS) {
        session.lastHeartbeatAt = now;
        await _deps.saveSessionAsync(session, { expectedGeneration: session.generation });
    }
    entry.updatedAt = now;
}
export function markSessionToolCall(id, toolName, selfDeadlineMs) {
    if (!id) return;
    const entry = _touchRuntime(id);
    entry.stage = 'tool_running';
    entry.lastToolCall = toolName || null;
    // Self-enforced deadline (ms) for tools that kill themselves at a known
    // budget (shell timeout / task wait). The watchdog raises the tool-running
    // ceiling to this + grace instead of aborting at toolRunningMs. Null/<=0
    // means unknown -> plain toolRunningMs behavior.
    entry.toolSelfDeadlineMs = (typeof selfDeadlineMs === 'number' && selfDeadlineMs > 0)
        ? selfDeadlineMs
        : null;
    entry.toolStartedAt = Date.now();
    entry.lastTransportAt = entry.toolStartedAt;
    if (!entry.firstSemanticAt) entry.firstSemanticAt = entry.toolStartedAt;
    entry.lastSemanticAt = entry.toolStartedAt;
    entry.lastSemanticKind = 'tool';
    entry.lastToolProtocolAt = entry.toolStartedAt;
    entry.lastProgressAt = entry.toolStartedAt;
    entry.updatedAt = entry.toolStartedAt;
    publishHeartbeat(id, entry.toolStartedAt);
    _startToolActivityHeartbeat(id);
}
// Parent AbortSignal listeners are dropped on askSession unwind (finally /
// terminal return) and on error/cancel/close — not in markSessionDone, which
// also runs between queued follow-up turns within one ask.
export function markSessionDone(id, { empty = false } = {}) {
    if (!id) return;
    _stopToolActivityHeartbeat(id);
    const entry = _touchRuntime(id);
    entry.stage = 'done';
    entry.lastError = null;
    entry.askStartedAt = null;
    entry.toolStartedAt = null;
    // Non-empty completion: drop any stale empty-final flag so a subsequent
    // ask on the same reusable runtime entry starts clean. Empty-final
    // completions preserve the flag (set by markSessionEmptyFinal just prior).
    if (!empty) {
        entry.emptyFinal = false;
        entry.emptyFinalAt = null;
    }
    const doneTs = Date.now();
    entry.doneAt = doneTs;
    entry.lastProgressAt = doneTs;
    entry.updatedAt = doneTs;
    // Terminal stage — drop the heartbeat so the status badge releases
    // immediately. A subsequent ask on the same session re-publishes via
    // markSessionStreamDelta on the first chunk.
    deleteHeartbeat(id);
}
// Tag a session as having completed with empty final synthesis (no
// content/reasoning). Distinct from `markSessionDone`: still a success
// (no abort), but the stall watchdog and post-mortem tools can
// distinguish "finished empty" from "finished with content" without
// mistaking the silence for a stall.
export function markSessionEmptyFinal(id) {
    if (!id) return;
    const entry = _touchRuntime(id);
    entry.emptyFinal = true;
    entry.emptyFinalAt = Date.now();
}
export function markSessionError(id, msg) {
    if (!id) return;
    _stopToolActivityHeartbeat(id);
    const entry = _touchRuntime(id);
    entry.stage = 'error';
    entry.lastError = msg ? String(msg).slice(0, 200) : null;
    entry.askStartedAt = null;
    entry.toolStartedAt = null;
    // Error path is a non-empty completion (we have an error message, not a
    // silent empty final). Clear the flag so the next ask starts clean.
    entry.emptyFinal = false;
    entry.emptyFinalAt = null;
    const errTs = Date.now();
    entry.doneAt = errTs;
    entry.lastProgressAt = errTs;
    entry.updatedAt = errTs;
    deleteHeartbeat(id);
    _unlinkParentAbortListener(entry);
}
export function markSessionCancelled(id) {
    if (!id) return;
    _stopToolActivityHeartbeat(id);
    const entry = _touchRuntime(id);
    entry.stage = 'done';
    entry.lastError = null;
    entry.askStartedAt = null;
    entry.toolStartedAt = null;
    entry.emptyFinal = false;
    entry.emptyFinalAt = null;
    const doneTs = Date.now();
    entry.doneAt = doneTs;
    entry.lastProgressAt = doneTs;
    entry.updatedAt = doneTs;
    deleteHeartbeat(id);
    _unlinkParentAbortListener(entry);
}
export function getSessionRuntime(id) {
    return id ? (_runtimeState.get(id) || null) : null;
}

const _COMPACTION_BLOCKED_STAGES = new Set([
    'connecting', 'requesting', 'streaming', 'tool_running', 'cancelling',
]);

export function isSessionCompactionBlocked(sessionId) {
    if (!sessionId) return false;
    const entry = _runtimeState.get(sessionId);
    if (!entry || entry.closed === true) return false;
    if (entry.controller && !entry.controller.signal?.aborted) return true;
    return _COMPACTION_BLOCKED_STAGES.has(entry.stage);
}

export function getSessionProgressSnapshot(sessionId) {
    const entry = _runtimeState.get(sessionId);
    if (!entry) return null;
    const askStartedAt = entry.askStartedAt || 0;
    const modelRequestStartedAt = entry.modelRequestStartedAt || 0;
    const firstSemanticAt = entry.firstSemanticAt || 0;
    const firstActivityAt = firstSemanticAt;
    const stage = entry.stage || 'idle';
    const activeModelStage = stage === 'connecting'
        || stage === 'requesting'
        || stage === 'streaming';
    const waitingForTransport = Boolean(
        modelRequestStartedAt
        && activeModelStage
        && !entry.lastTransportAt
    );
    const waitingForFirstSemantic = Boolean(
        modelRequestStartedAt
        && activeModelStage
        && !firstSemanticAt
    );
    return {
        stage,
        askStartedAt,
        modelRequestStartedAt,
        firstActivityAt,
        firstSemanticAt,
        lastTransportAt: entry.lastTransportAt || 0,
        lastSemanticAt: entry.lastSemanticAt || 0,
        lastSemanticKind: entry.lastSemanticKind || null,
        lastReasoningAt: entry.lastReasoningAt || 0,
        lastVisibleTextAt: entry.lastVisibleTextAt || 0,
        lastToolProtocolAt: entry.lastToolProtocolAt || 0,
        lastStreamDeltaAt: entry.lastStreamDeltaAt || 0,
        toolStartedAt: entry.toolStartedAt || 0,
        currentTool: entry.lastToolCall || null,
        toolSelfDeadlineMs: entry.toolSelfDeadlineMs || 0,
        lastProgressAt: entry.lastProgressAt || 0,
        updatedAt: entry.updatedAt || 0,
        hasFirstActivity: Boolean(firstSemanticAt && (!askStartedAt || firstSemanticAt >= askStartedAt)),
        hasFirstSemantic: Boolean(firstSemanticAt && (!askStartedAt || firstSemanticAt >= askStartedAt)),
        hasVisibleProgress: Boolean(
            (entry.lastVisibleTextAt && (!askStartedAt || entry.lastVisibleTextAt >= askStartedAt))
            || (entry.lastToolProtocolAt && (!askStartedAt || entry.lastToolProtocolAt >= askStartedAt))
        ),
        waitingForTransport,
        waitingForFirstSemantic,
        // Backward-compatible alias for older status/watchdog consumers. It is
        // semantic activity now, never generic transport.
        waitingForFirstActivity: waitingForFirstSemantic,
    };
}

/**
 * Iterate all active session runtimes. Used by the stream watchdog.
 * Returns an iterable of [sessionId, entry] pairs; consumers should
 * treat entries as read-only snapshots and avoid mutating them.
 */
export function forEachSessionRuntime() {
    return _runtimeState.entries();
}

// Wire the usage-metrics runtime accessor to this module's _runtimeState so
// persistIterationMetrics can read the live in-memory session and flag
// usageMetricsTurnIncremental. (Moved with the map from manager.mjs.)
configureUsageMetricsRuntime({ getRuntimeEntry: (id) => _runtimeState.get(id) });

/** Mark session hidden so listSessions() filters it out (runtime-only). */
export function hideSessionFromList(sessionId) {
    if (!sessionId) return;
    const entry = _runtimeState.get(sessionId);
    if (entry) entry.listHidden = true;
}

export function getSessionAbortSignal(sessionId) {
    return _runtimeState.get(sessionId)?.controller?.signal ?? null;
}

/**
 * Return the most recent "session is making progress" timestamp.
 *
 * Combines three independent progress signals so an idle watchdog can stay
 * alive across both streaming and long tool calls:
 *   - lastStreamDeltaAt: provider stream chunk landed
 *   - toolStartedAt: a tool call just kicked off (nested tool work may
 *     stall the outer stream for a while; this keeps the watchdog from
 *     killing legitimate sub-agent runs)
 *   - askStartedAt: ask just started; covers the pre-stream connect window
 *
 * Returns 0 when the runtime entry is unknown so callers can decide to
 * either skip the watchdog or treat 0 as "no progress yet".
 */
export function getSessionLastProgressAt(sessionId) {
    const entry = _runtimeState.get(sessionId);
    if (!entry) return 0;
    return Math.max(
        entry.lastProgressAt || 0,
        entry.lastStreamDeltaAt || 0,
        entry.toolStartedAt || 0,
        entry.askStartedAt || 0,
    );
}

/**
 * Link a parent AbortSignal to a sub-session's controller so that aborting
 * the parent (fan-out deadline or caller ESC) tears down the agent role's
 * provider call promptly. Safe to call after prepareAgentSession but before
 * askSession completes. No-op if the session runtime isn't found.
 *
 * @param {string} sessionId — the sub-session to abort
 * @param {AbortSignal} parentSignal — upstream signal (from fan-out coordinator)
 */
export function linkParentSignalToSession(sessionId, parentSignal) {
    if (!(parentSignal instanceof AbortSignal)) return;
    const entry = _touchRuntime(sessionId);
    if (!entry.controller) entry.controller = createAbortController();
    const abortReason = () => {
        const reason = parentSignal.reason;
        if (reason instanceof Error) return reason;
        if (reason !== undefined && reason !== null && reason !== '') return new Error(String(reason));
        return new Error('parent signal aborted');
    };
    if (parentSignal.aborted) {
        _unlinkParentAbortListener(entry);
        // Retain the parent signal (listener null — nothing left to fire) so a
        // later fresh-controller swap in askSession can DETECT this early abort
        // and re-cascade it onto the new controller; otherwise the abort would
        // be silently dropped and provider computation would run detached.
        entry.parentAbortLink = { signal: parentSignal, listener: null };
        try { entry.controller.abort(abortReason()); } catch { /* ignore */ }
        return;
    }
    _unlinkParentAbortListener(entry);
    const onParentAbort = () => {
        try { entry.controller?.abort(abortReason()); } catch { /* ignore */ }
    };
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
    entry.parentAbortLink = { signal: parentSignal, listener: onParentAbort };
}
export function _unlinkParentAbortListener(entry) {
    const link = entry?.parentAbortLink;
    if (!link) return;
    try { link.signal.removeEventListener('abort', link.listener); } catch { /* ignore */ }
    entry.parentAbortLink = null;
}
export function _clearSessionRuntime(id) {
    if (id) {
        _stopToolActivityHeartbeat(id);
        _unlinkParentAbortListener(_runtimeState.get(id));
        _runtimeState.delete(id);
        // R15: also drop the per-session metric-idempotency Set; otherwise it
        // grows O(sessions x iterations) for the whole server lifetime since
        // nothing else deletes from _metricSeenIter on session close.
        dropMetricSeenState(id);
    }
}

/**
 * Evict a settled terminal runtime entry without ever touching an in-flight
 * controller. askSession calls this after detaching its controller; the
 * periodic cleanup also uses it to drain any backlog left by older paths.
 */
export function _evictTerminalSessionRuntime(id) {
    if (!id) return false;
    const entry = _runtimeState.get(id);
    if (!entry) return false;
    if (entry.controller && !entry.controller.signal?.aborted) return false;
    if (entry.closed !== true && !TERMINAL_STAGES.has(entry.stage)) return false;
    _clearSessionRuntime(id);
    return true;
}

export function _sweepTerminalSessionRuntimes() {
    let cleaned = 0;
    for (const [id] of _runtimeState) {
        if (_evictTerminalSessionRuntime(id)) cleaned++;
    }
    return cleaned;
}

// Direct-Map accessors for manager.mjs internals (askSession / closeSession /
// idle-sweep) that mutate entries in place. Kept as thin exports so the Map
// stays private to this module.
export function _getRuntimeEntry(id) {
    return _runtimeState.get(id);
}
export function _runtimeEntries() {
    return _runtimeState.entries();
}
