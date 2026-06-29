import { getHiddenRole } from './internal-roles.mjs';

const SECOND_MS = 1000;
const MIN_PROVIDER_TIMEOUT_MS = 30_000;

export const STALL_TICK_MS = 15_000;
export const DEFAULT_STALL_WARN_S = 300;
export const DEFAULT_STALL_ABORT_S = 600;
// First-byte (no-stream-delta) abort for the agent stall watchdog. A wedged
// socket can sit at stage=requesting with zero server events. The 30s deadline
// trialed here false-aborted slow high-reasoning first bytes (e.g. gpt-5.5
// XHIGH, which can legitimately think >30s before the first delta) and, paired
// with dispatch auto-retry, produced premature aborts + duplicate re-dispatches.
// Auto-retry is now removed, so a single
// attempt must get a generous first-byte window: 300s (5 min). Env-overridable.
export const DEFAULT_STALL_FIRST_BYTE_ABORT_S = (() => {
    const raw = process.env.MIXDOG_STALL_FIRST_BYTE_ABORT_S;
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return Math.min(Math.max(n, 5), 600);
    return 300;
})();

export function envThresholdSeconds(env = process.env) {
    const raw = env.STALL_TIMEOUT_S;
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

export function resolveBaseStallThresholds(env = process.env) {
    const abort = envThresholdSeconds(env) ?? DEFAULT_STALL_ABORT_S;
    const warn = abort > DEFAULT_STALL_WARN_S ? DEFAULT_STALL_WARN_S : Math.floor(abort / 2);
    return { warn, abort };
}

const _baseThresholds = resolveBaseStallThresholds();
export const STALL_WARN_S = _baseThresholds.warn;
export const STALL_ABORT_S = _baseThresholds.abort;
export const STALL_WARN_MS = STALL_WARN_S * SECOND_MS;
export const STALL_ABORT_MS = STALL_ABORT_S * SECOND_MS;

export const PROVIDER_MAX_BEFORE_WARN_MS = Math.max(
    SECOND_MS,
    STALL_WARN_MS - STALL_TICK_MS,
);

export function resolveTimeoutMs(envNames, fallbackMs, { minMs = 1_000, maxMs = Number.POSITIVE_INFINITY, env = process.env } = {}) {
    const names = Array.isArray(envNames) ? envNames : [envNames].filter(Boolean);
    for (const name of names) {
        const raw = env?.[name];
        if (raw == null || raw === '') continue;
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) {
            return Math.min(Math.max(n, minMs), maxMs);
        }
    }
    return Math.min(Math.max(fallbackMs, minMs), maxMs);
}

// While a tool call is in flight, bump lastProgressAt on this cadence so long
// executions stay "active" without emitting model-visible content.
export const DEFAULT_ACTIVITY_HEARTBEAT_MS = resolveTimeoutMs(
    'MIXDOG_AGENT_ACTIVITY_HEARTBEAT_MS',
    30_000,
    { minMs: 5_000, maxMs: 300_000 },
);

export const PROVIDER_FIRST_BYTE_TIMEOUT_MS = resolveTimeoutMs(
    'MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS',
    Math.min(120_000, PROVIDER_MAX_BEFORE_WARN_MS),
    { minMs: MIN_PROVIDER_TIMEOUT_MS, maxMs: PROVIDER_MAX_BEFORE_WARN_MS },
);

export const PROVIDER_GENERATE_TOTAL_TIMEOUT_MS = resolveTimeoutMs(
    'MIXDOG_PROVIDER_GENERATE_TOTAL_TIMEOUT_MS',
    PROVIDER_MAX_BEFORE_WARN_MS,
    { minMs: PROVIDER_FIRST_BYTE_TIMEOUT_MS, maxMs: PROVIDER_MAX_BEFORE_WARN_MS },
);

export const PROVIDER_NONSTREAM_TOTAL_TIMEOUT_MS = resolveTimeoutMs(
    ['MIXDOG_NONSTREAM_TOTAL_TIMEOUT_MS', 'MIXDOG_COMPAT_NONSTREAM_TOTAL_TIMEOUT_MS'],
    480_000,
    { minMs: PROVIDER_GENERATE_TOTAL_TIMEOUT_MS, maxMs: STALL_ABORT_MS },
);

export const PROVIDER_CACHE_CREATE_TIMEOUT_MS = resolveTimeoutMs(
    'MIXDOG_PROVIDER_CACHE_CREATE_TIMEOUT_MS',
    Math.min(120_000, PROVIDER_GENERATE_TOTAL_TIMEOUT_MS),
    { minMs: MIN_PROVIDER_TIMEOUT_MS, maxMs: PROVIDER_MAX_BEFORE_WARN_MS },
);

export const PROVIDER_CACHE_CREATE_TOTAL_TIMEOUT_MS = resolveTimeoutMs(
    'MIXDOG_PROVIDER_CACHE_CREATE_TOTAL_TIMEOUT_MS',
    Math.min(180_000, PROVIDER_GENERATE_TOTAL_TIMEOUT_MS),
    { minMs: MIN_PROVIDER_TIMEOUT_MS, maxMs: PROVIDER_MAX_BEFORE_WARN_MS },
);

export const PROVIDER_HTTP_RESPONSE_TIMEOUT_MS = resolveTimeoutMs(
    'MIXDOG_PROVIDER_HTTP_RESPONSE_TIMEOUT_MS',
    60_000,
    { minMs: 10_000, maxMs: PROVIDER_MAX_BEFORE_WARN_MS },
);

// Stream idle watchdog is OFF by default — matches reference agent native
// behaviour (its watchdog is gated behind CLAUDE_ENABLE_STREAM_WATCHDOG).
// The agent stall watchdog (STALL_ABORT_S, 600s) is the backstop for
// genuinely dead streams; this short inter-chunk idle watchdog only adds
// value when explicitly enabled, and otherwise prematurely kills slow
// high-reasoning streams. Enable with MIXDOG_ENABLE_STREAM_WATCHDOG=1.
const _sseWatchdogRaw = process.env.MIXDOG_ENABLE_STREAM_WATCHDOG;
export const PROVIDER_SSE_IDLE_WATCHDOG_ENABLED =
    _sseWatchdogRaw === '1' || _sseWatchdogRaw === 'true' || _sseWatchdogRaw === 'yes';

export const PROVIDER_SSE_IDLE_TIMEOUT_MS = resolveTimeoutMs(
    'MIXDOG_PROVIDER_SSE_IDLE_TIMEOUT_MS',
    90_000,
    { minMs: 10_000, maxMs: STALL_WARN_MS },
);

export const PROVIDER_WS_HANDSHAKE_TIMEOUT_MS = resolveTimeoutMs(
    'MIXDOG_PROVIDER_WS_HANDSHAKE_TIMEOUT_MS',
    30_000,
    { minMs: 5_000, maxMs: PROVIDER_MAX_BEFORE_WARN_MS },
);

export const PROVIDER_WS_ACQUIRE_TIMEOUT_MS = resolveTimeoutMs(
    'MIXDOG_PROVIDER_WS_ACQUIRE_TIMEOUT_MS',
    15_000,
    { minMs: 5_000, maxMs: PROVIDER_MAX_BEFORE_WARN_MS },
);

export const PROVIDER_WS_FIRST_MEANINGFUL_TIMEOUT_MS = resolveTimeoutMs(
    'MIXDOG_PROVIDER_WS_FIRST_MEANINGFUL_TIMEOUT_MS',
    Math.min(PROVIDER_FIRST_BYTE_TIMEOUT_MS, PROVIDER_GENERATE_TOTAL_TIMEOUT_MS),
    { minMs: MIN_PROVIDER_TIMEOUT_MS, maxMs: PROVIDER_MAX_BEFORE_WARN_MS },
);

export const PROVIDER_WS_INTER_CHUNK_TIMEOUT_MS = resolveTimeoutMs(
    'MIXDOG_PROVIDER_WS_INTER_CHUNK_TIMEOUT_MS',
    STALL_ABORT_MS,
    { minMs: STALL_WARN_MS, maxMs: STALL_ABORT_MS },
);

export const PROVIDER_RETRY_BACKOFF_MS = Object.freeze([0, 1000, 2000, 4000, 8000]);
export const PROVIDER_RETRY_MAX_ATTEMPTS = PROVIDER_RETRY_BACKOFF_MS.length;
export const PROVIDER_RETRY_JITTER_RATIO = (() => {
    const raw = process.env.MIXDOG_PROVIDER_RETRY_JITTER_RATIO;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.min(n, 1);
    return 0.2;
})();

export function resolveAgentStallThresholds(role, env = process.env) {
    const cfg = role ? getHiddenRole(role) : null;
    const cfgAbort = cfg?.stallCap?.idleSeconds > 0 ? cfg.stallCap.idleSeconds : STALL_ABORT_S;
    const envOverride = envThresholdSeconds(env);
    const abort = envOverride != null ? envOverride : cfgAbort;
    // Mid-stream "slow" warning disabled — an agent stall now notifies ONLY at
    // the abort deadline (10 min default). warn === abort means the watchdog's
    // warn branch (verdict 'ok' && stale >= warn) can never fire before 'stall',
    // so the only notification a stalled agent worker emits is at the deadline.
    const warn = abort;
    // First-byte deadline: a request still in 'requesting' that never produced a
    // single SSE delta is hung, not slow-reasoning. Abort on this shorter deadline
    // so the lead is notified in minutes, not at the full mid-stream window.
    const firstByteAbort = Math.min(abort, DEFAULT_STALL_FIRST_BYTE_ABORT_S);
    return { warn, abort, firstByteAbort };
}

export function resolveAgentToolThresholdSeconds(role, thresholdSeconds) {
    const cfg = role ? getHiddenRole(role) : null;
    if (cfg?.stallCap?.toolRunningSeconds > 0) return cfg.stallCap.toolRunningSeconds;
    return thresholdSeconds;
}

export function providerTimeoutError(label, timeoutMs) {
    const err = new Error(`${label} timed out after ${timeoutMs}ms`);
    err.name = 'ProviderTimeoutError';
    err.code = 'EPROVIDERTIMEOUT';
    return err;
}

export function createTimeoutSignal(parentSignal, timeoutMs, label) {
    const ac = new AbortController();
    let timer = null;
    let parentListener = null;
    const cleanup = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (parentListener && parentSignal) {
            try { parentSignal.removeEventListener('abort', parentListener); } catch {}
            parentListener = null;
        }
    };
    const abort = (reason) => {
        try { ac.abort(reason); } catch {}
    };
    if (parentSignal) {
        parentListener = () => abort(parentSignal.reason);
        if (parentSignal.aborted) {
            parentListener();
        } else {
            parentSignal.addEventListener('abort', parentListener, { once: true });
        }
    }
    timer = setTimeout(() => abort(providerTimeoutError(label, timeoutMs)), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    return { signal: ac.signal, cleanup };
}

// Pass-through abort signal with NO wall-clock timer. Mirrors createTimeoutSignal's
// { signal, cleanup } shape so call sites can swap it in without other changes, but
// the returned signal aborts ONLY when the parent does (e.g. client disconnect /
// replaced-by-newer-request). Used for the streaming generation phase, where a fixed
// total-lifetime cap would false-abort a stream that is still emitting SSE deltas; the
// streaming phase is bounded instead by the per-attempt first-byte timeout, the parent
// signal, and the agent stall watchdog (STALL_ABORT_S, progress-based). cleanup()
// detaches the parent listener so no listener leaks on the (long-lived) parent signal.
export function createPassthroughSignal(parentSignal) {
    if (!parentSignal) return { signal: null, cleanup: () => {} };
    const ac = new AbortController();
    let parentListener = () => { try { ac.abort(parentSignal.reason); } catch {} };
    const cleanup = () => {
        if (parentListener && parentSignal) {
            try { parentSignal.removeEventListener('abort', parentListener); } catch {}
            parentListener = null;
        }
    };
    if (parentSignal.aborted) {
        parentListener();
    } else {
        parentSignal.addEventListener('abort', parentListener, { once: true });
    }
    return { signal: ac.signal, cleanup };
}
