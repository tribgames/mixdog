import { getHiddenAgent } from './internal-agents.mjs';

const SECOND_MS = 1000;
const MIN_PROVIDER_TIMEOUT_MS = 30_000;

const STALL_TICK_MS = 15_000;
const DEFAULT_STALL_WARN_S = 300;
const DEFAULT_STALL_ABORT_S = 600;
// First-byte (no-stream-delta) abort for the agent stall watchdog. A wedged
// socket can sit at stage=requesting with zero server events. The 30s deadline
// trialed here false-aborted slow high-reasoning first bytes (e.g. gpt-5.5
// XHIGH, which can legitimately think >30s before the first delta) and, paired
// with dispatch auto-retry, produced premature aborts + duplicate re-dispatches.
// Auto-retry is now removed, so a single
// attempt must get a generous first-byte window: 300s (5 min). Env-overridable.
const DEFAULT_STALL_FIRST_BYTE_ABORT_S = (() => {
    const raw = process.env.MIXDOG_STALL_FIRST_BYTE_ABORT_S;
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return Math.min(Math.max(n, 5), 600);
    return 300;
})();

function envThresholdSeconds(env = process.env) {
    const raw = env.STALL_TIMEOUT_S;
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

function resolveBaseStallThresholds(env = process.env) {
    const abort = envThresholdSeconds(env) ?? DEFAULT_STALL_ABORT_S;
    const warn = abort > DEFAULT_STALL_WARN_S ? DEFAULT_STALL_WARN_S : Math.floor(abort / 2);
    return { warn, abort };
}

const _baseThresholds = resolveBaseStallThresholds();
const STALL_WARN_S = _baseThresholds.warn;
export const STALL_ABORT_S = _baseThresholds.abort;
const STALL_WARN_MS = STALL_WARN_S * SECOND_MS;
const STALL_ABORT_MS = STALL_ABORT_S * SECOND_MS;

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
    60_000,
    { minMs: MIN_PROVIDER_TIMEOUT_MS, maxMs: PROVIDER_MAX_BEFORE_WARN_MS },
);

export const PROVIDER_GENERATE_TOTAL_TIMEOUT_MS = resolveTimeoutMs(
    'MIXDOG_PROVIDER_GENERATE_TOTAL_TIMEOUT_MS',
    PROVIDER_MAX_BEFORE_WARN_MS,
    { minMs: PROVIDER_FIRST_BYTE_TIMEOUT_MS, maxMs: PROVIDER_MAX_BEFORE_WARN_MS },
);

const PROVIDER_NONSTREAM_TOTAL_TIMEOUT_MS = resolveTimeoutMs(
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

// Stream idle watchdog is ON by default. Earlier it was OFF (reference-agent
// parity) on the theory that a short inter-chunk timer would false-abort slow
// high-reasoning streams — but every provider's SSE loop resets the idle timer
// on EVERY chunk, including content-free keepalives (Anthropic `:ping`,
// OpenAI/compat reasoning_content deltas, Gemini chunks). So a live
// extended-thinking stream keeps the timer fresh; only a genuinely silent
// socket (no bytes at all for the whole window) trips it. With the watchdog
// OFF, such a wedged socket sat until the 600s agent stall backstop, which the
// trace logs showed as the dominant mid-stream hang (sse_parse_ms p99 ~183s,
// max ~411s). Defaulting ON with a generous 120s window cuts that tail ~5x
// while leaving genuine reasoning pauses (kept alive by keepalive frames)
// untouched. Force OFF with MIXDOG_ENABLE_STREAM_WATCHDOG=0.
const _sseWatchdogRaw = process.env.MIXDOG_ENABLE_STREAM_WATCHDOG;
export const PROVIDER_SSE_IDLE_WATCHDOG_ENABLED = _sseWatchdogRaw === undefined || _sseWatchdogRaw === ''
    ? true
    : (_sseWatchdogRaw === '1' || _sseWatchdogRaw === 'true' || _sseWatchdogRaw === 'yes');

export const PROVIDER_SSE_IDLE_TIMEOUT_MS = resolveTimeoutMs(
    'MIXDOG_PROVIDER_SSE_IDLE_TIMEOUT_MS',
    120_000,
    { minMs: 10_000, maxMs: STALL_WARN_MS },
);

// Semantic (last-meaningful-event) idle window. Distinct name from the
// transport-byte SSE idle so provider loops can key their mid-stream abort off
// SEMANTIC progress (message/content/tool deltas) rather than raw keepalive
// bytes (Anthropic `:ping`, comment frames). A truly silent stream — one that
// emits no semantic event for this window — trips it; a live extended-thinking
// stream (which emits thinking deltas) stays alive. Default 120s, floor 10s,
// env-overridable and disablable via MIXDOG_ENABLE_STREAM_WATCHDOG=0.
export const PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS = resolveTimeoutMs(
    ['MIXDOG_PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS', 'MIXDOG_PROVIDER_SSE_IDLE_TIMEOUT_MS'],
    // 2026-07-05 trace audit: effort-mode (output_config.effort) sonnet-5
    // streams deliver NO deltas during the thinking phase — the whole
    // thinking+text body flushes at the end (44/47 slow turns had
    // stream_total-ttft < 2s; silent-window token rate a steady ~92 tok/s,
    // i.e. live generation, not a wedge). Successful turns topped out at
    // ttft 171s while 13 kills sat at exactly ~183s fetch→fetch — the old
    // 180s window was beheading every turn whose silent thinking ran past
    // it, then retrying the whole thinking run from zero. Raised to the
    // policy ceiling (STALL_WARN - tick ≈ 285s); the agent stall watchdog
    // (worker 300s) remains the true-wedge backstop just above it.
    PROVIDER_MAX_BEFORE_WARN_MS,
    { minMs: 10_000, maxMs: STALL_WARN_MS },
);

// Named terminal error for a mid-stream SEMANTIC idle abort. Distinct from a
// user cancel (signal.aborted): the retry-classifier treats this as a terminal
// STREAM FAILURE so the owner (Lead) receives a failure notification instead of
// the task hanging. The message keeps "timed out after …ms of inactivity" so
// the SSE mid-stream classifier's text match (sse_idle_timeout) still fires,
// and code 'ESTREAMSTALL' routes it through the transient/notify path.
export function streamStalledError(label, timeoutMs, { emittedToolCall = false } = {}) {
    const err = new Error(`${label} stream timed out after ${timeoutMs}ms of inactivity`);
    err.name = 'StreamStalledError';
    err.code = 'ESTREAMSTALL';
    err.streamStalled = true;
    // Double-dispatch guard (reviewer High): once a tool call has already been
    // emitted this turn (including a recovered text-leaked call), retrying the
    // request would RE-RUN that side-effecting tool. Mark such a stall
    // unsafe-to-retry so withRetry() throws it straight through to the terminal
    // notify path instead of replaying the turn. A stall BEFORE any tool emit is
    // still safely retryable (nothing has executed yet).
    if (emittedToolCall) err.unsafeToRetry = true;
    return err;
}

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

// WS pool liveness (ping/pong) — closes the gap between a socket going
// half-open (peer gone / TLS wedge) and the semantic-idle watchdog noticing
// (120s). Node `ws` send() is fire-and-forget, so a dead pooled socket
// silently blackholes response.create frames until a downstream timeout. An
// idle pooled socket is pinged on this cadence; a reused socket that has been
// quiet longer than the stale window is ping-probed before hand-out.
// Gated OFF by default for reference-CLI parity — they do not ping model
// sockets. Enable with MIXDOG_PROVIDER_WS_PING_ENABLED=1. When disabled, no
// liveness interval is armed and the acquire-reuse ping probe is skipped (the
// non-OPEN eviction scan still runs); lastAliveAt stamping is harmless.
const _wsPingRaw = process.env.MIXDOG_PROVIDER_WS_PING_ENABLED;
export const PROVIDER_WS_PING_ENABLED = _wsPingRaw === '1' || _wsPingRaw === 'true' || _wsPingRaw === 'yes';

export const PROVIDER_WS_PING_INTERVAL_MS = resolveTimeoutMs(
    'MIXDOG_PROVIDER_WS_PING_INTERVAL_MS',
    30_000,
    { minMs: 5_000, maxMs: PROVIDER_MAX_BEFORE_WARN_MS },
);

// Missed-pong grace: after a ping, the pong must land within this bound or the
// socket is treated as dead (closed + evicted). Doubles as the short probe
// bound on the acquire-reuse path so a busy caller is never handed a wedged
// socket.
export const PROVIDER_WS_PONG_TIMEOUT_MS = resolveTimeoutMs(
    'MIXDOG_PROVIDER_WS_PONG_TIMEOUT_MS',
    5_000,
    { minMs: 1_000, maxMs: 60_000 },
);

// Activity freshness window: a pooled socket with observed activity (pong /
// release) newer than this is assumed live and skips the acquire-reuse probe.
export const PROVIDER_WS_LIVENESS_STALE_MS = resolveTimeoutMs(
    'MIXDOG_PROVIDER_WS_LIVENESS_STALE_MS',
    30_000,
    { minMs: 5_000, maxMs: PROVIDER_MAX_BEFORE_WARN_MS },
);

// Single inter-chunk idle timer (300s), matching the upstream WS provider's
// default stream idle timeout. Mixdog resets one idle timer on every received
// WS frame (openai-oauth-ws messageHandler resets on every parsed event). There
// is deliberately no separate "first-meaningful" watchdog — a live stream
// (including server-side reasoning ACKed via response.created) keeps this timer
// fresh, and only true socket silence trips it. Env-tunable.
export const PROVIDER_WS_INTER_CHUNK_TIMEOUT_MS = resolveTimeoutMs(
    'MIXDOG_PROVIDER_WS_INTER_CHUNK_TIMEOUT_MS',
    300_000,
    { minMs: MIN_PROVIDER_TIMEOUT_MS, maxMs: STALL_ABORT_MS },
);

// First-MEANINGFUL-frame watchdog (WS). The inter-chunk timer resets on EVERY
// received frame (keepalive/metadata/rate_limits keep the socket "alive"), so a
// server that ACKs response.create with only keepalive/metadata frames — never
// a response.created or a content/tool delta — resets provider idle forever and
// the pre-response first-byte window never wins. This distinct timer is cleared
// ONLY by a MEANINGFUL response event (response.created or the first content /
// tool-arg delta); keepalive/metadata frames do NOT touch it. On expiry the
// stream is treated as stalled (streamStalledError → existing retry/fallback).
// Kept comfortably below the agent stall first-byte abort (300s default) so the
// provider layer catches the wedge before the agent watchdog does. Env-tunable.
export const PROVIDER_WS_FIRST_MEANINGFUL_TIMEOUT_MS = resolveTimeoutMs(
    'MIXDOG_PROVIDER_WS_FIRST_MEANINGFUL_TIMEOUT_MS',
    60_000,
    { minMs: 10_000, maxMs: STALL_WARN_MS },
);

// WS semantic idle uses the same default ceiling as OpenAI HTTP/SSE semantic
// idle. This is semantic progress only (not the WS inter-chunk byte timer), so
// reasoning/text/tool deltas reset it while metadata cannot. Keep the default
// at PROVIDER_MAX_BEFORE_WARN_MS (~285s), strictly below the 300s worker
// watchdog, rather than rounding it to 300s.
export const PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS = resolveTimeoutMs(
    ['MIXDOG_PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS', 'MIXDOG_PROVIDER_WS_OUTPUT_IDLE_TIMEOUT_MS'],
    PROVIDER_MAX_BEFORE_WARN_MS,
    { minMs: 10_000, maxMs: PROVIDER_MAX_BEFORE_WARN_MS },
);

// First retry has a small floor (250ms) instead of 0ms: an immediate reissue on
// a transient 5xx burst lets parallel workers thundering-herd the backend in
// lockstep (jitter alone can't decluster a 0ms base). Subsequent steps keep the
// exponential schedule. Env-tunable via the providers' retryJitterRatio.
export const PROVIDER_RETRY_BACKOFF_MS = Object.freeze([250, 1000, 2000, 4000, 8000]);
export const PROVIDER_RETRY_MAX_ATTEMPTS = PROVIDER_RETRY_BACKOFF_MS.length;
export const PROVIDER_RETRY_JITTER_RATIO = (() => {
    const raw = process.env.MIXDOG_PROVIDER_RETRY_JITTER_RATIO;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.min(n, 1);
    return 0.2;
})();

// Public workflow agents are not in agents.json (that file only defines hidden
// roles), so they historically always fell back to the 600s default. A wedged
// anthropic SSE stream (HTTP 200 then zero deltas — observed 2026-07-03 on a
// sonnet-5 worker, twice in a row) then holds the owner for the full 10 min.
// Scoped workers/reviewers should be reaped faster; lead keeps the generous
// default because interactive xhigh turns legitimately think for minutes.
const WORKFLOW_AGENT_STALL_ABORT_S = {
    'worker': 300,
    'reviewer': 300,
    'debugger': 420,
    'heavy-worker': 420,
    'maintainer': 300,
    'explore': 240,
    'web-researcher': 300,
};

export function resolveAgentStallThresholds(agent, env = process.env) {
    const cfg = agent ? getHiddenAgent(agent) : null;
    const roleAbort = WORKFLOW_AGENT_STALL_ABORT_S[String(agent || '')] || null;
    const cfgAbort = cfg?.stallCap?.idleSeconds > 0
        ? cfg.stallCap.idleSeconds
        : (roleAbort || STALL_ABORT_S);
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

export function resolveAgentToolThresholdSeconds(agent, thresholdSeconds) {
    const cfg = agent ? getHiddenAgent(agent) : null;
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
