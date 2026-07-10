// Incremental + terminal usage-metrics accounting for sessions.
// Extracted verbatim from manager.mjs (behavior-preserving). Pure helpers plus
// per-session idempotency tracking for incremental usage persistence.
//
// Runtime coupling is injected: persistIterationMetrics needs the live
// _runtimeState map (owned by manager.mjs) to read the in-memory session and
// flag usageMetricsTurnIncremental. manager.mjs wires it via configureUsageMetricsRuntime().
import { providerInputExcludesCache } from '../../providers/registry.mjs';
import { loadSession, saveSessionAsync, _saveSessionSync } from '../store.mjs';

// Per-session idempotency tracking: sessionId → Set of seen
// turn:epoch:iteration:source keys.
const _metricSeenIter = new Map();

// ── Mid-turn save coalescing ──────────────────────────────────────────────
// saveSessionAsync structured-clones the ENTIRE session on the main thread
// per postMessage call (store.mjs saveSessionAsync). Calling it after EVERY
// provider.send iteration is the cost this coalesces away: in-memory session
// mutation above still happens every iteration (durability of the data is
// unaffected — only how often it hits saveSessionAsync's postMessage clone).
// sessionId → { inFlight, dirty, lastFlushAt, timer }
const _metricSaveState = new Map();
// sessionId → live session ref awaiting a still-deferred (timer-pending)
// flush. Only populated for the window between "delta applied, save not yet
// posted to the worker" and the actual saveSessionAsync call — once a save
// is posted, store.mjs's own _saveWorkerPending covers process-exit drain.
const _pendingMetricsFlush = new Map();
const METRICS_SAVE_THROTTLE_MS = 500;

function _metricsSaveState(sessionId) {
    let state = _metricSaveState.get(sessionId);
    if (!state) {
        state = { inFlight: false, dirty: false, lastFlushAt: 0, timer: null, closed: false, failCount: 0 };
        _metricSaveState.set(sessionId, state);
    }
    return state;
}

function _flushMetricsSave(session, sessionId) {
    const state = _metricsSaveState(sessionId);
    if (state.closed) return;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    _pendingMetricsFlush.delete(sessionId);
    state.dirty = false;
    state.inFlight = true;
    state.lastFlushAt = Date.now();
    saveSessionAsync(session, { expectedGeneration: session.generation })
        .then(() => {
            state.failCount = 0;
        })
        .catch((err) => {
            process.stderr.write(`[usage-metrics] iteration save failed: ${err?.message ?? err}\n`);
            // A rejected save must not silently drop the delta already
            // applied in-memory — re-park it so the process-exit drain
            // and/or the retry below still see it.
            state.failCount += 1;
            state.dirty = true;
            _pendingMetricsFlush.set(sessionId, session);
        })
        .finally(() => {
            state.inFlight = false;
            if (state.closed) {
                // dropMetricSeenState ran while this save was in flight —
                // do not resurrect per-session state/timers post-close.
                _metricSaveState.delete(sessionId);
                _pendingMetricsFlush.delete(sessionId);
                return;
            }
            // A newer delta (or the rejection re-park above) landed while
            // this save was in flight — flush once more so it is never
            // stranded. Always take the LATEST parked session, not the
            // (possibly stale/pre-detach-resume) closure `session` — a
            // newer delta may have parked a fresher session/generation.
            // failCount cap: a persistently failing save (broken dir/disk)
            // must not spin reject→re-park→retry forever with no backoff.
            // The session stays parked in _pendingMetricsFlush, so a later
            // _scheduleMetricsSave (next iteration) or the process-exit
            // drain still gets a shot at persisting it.
            if (state.dirty && state.failCount <= 3) {
                const latest = _pendingMetricsFlush.get(sessionId) ?? session;
                _flushMetricsSave(latest, sessionId);
            }
        });
}

/**
 * Coalesce mid-turn metric saves: an in-flight guard collapses overlapping
 * saves into one trailing flush, and a >=500ms per-session throttle caps
 * how often a completed save re-triggers another. The idempotency Set above
 * still updates per-iteration regardless of whether this call ends up
 * actually posting to the worker this tick.
 */
function _scheduleMetricsSave(session, sessionId) {
    const state = _metricsSaveState(sessionId);
    if (state.closed) return;
    if (state.inFlight) {
        state.dirty = true;
        _pendingMetricsFlush.set(sessionId, session);
        return;
    }
    const elapsed = Date.now() - state.lastFlushAt;
    if (elapsed >= METRICS_SAVE_THROTTLE_MS) {
        _flushMetricsSave(session, sessionId);
        return;
    }
    state.dirty = true;
    _pendingMetricsFlush.set(sessionId, session);
    if (!state.timer) {
        const t = setTimeout(() => {
            state.timer = null;
            if (!state.inFlight && !state.closed) {
                const latest = _pendingMetricsFlush.get(sessionId) ?? session;
                _flushMetricsSave(latest, sessionId);
            }
        }, METRICS_SAVE_THROTTLE_MS - elapsed);
        if (t.unref) t.unref();
        state.timer = t;
    }
}

// Process exit can land inside the throttle window, before the trailing
// timer above ever calls saveSessionAsync (which would otherwise register
// with store.mjs's own drainSessionStore-covered worker queue). Sync-flush
// any such still-deferred session here so a normal-completion turn that
// happens to exit mid-throttle never loses the latest iteration delta.
process.on('exit', () => {
    for (const [sessionId, session] of _pendingMetricsFlush) {
        try { _saveSessionSync(session, { expectedGeneration: session.generation }); }
        catch { /* best-effort: process is exiting */ }
    }
    _pendingMetricsFlush.clear();
});

// Injected accessor for manager's _runtimeState. Defaults to a no-op lookup so
// the pure helpers remain usable (and unit-testable) before wiring.
let _getRuntimeEntry = () => null;

/** Wire the live runtime-state accessor from manager.mjs. */
export function configureUsageMetricsRuntime({ getRuntimeEntry } = {}) {
    if (typeof getRuntimeEntry === 'function') _getRuntimeEntry = getRuntimeEntry;
}

/** Drop the per-session metric-idempotency Set (called on session close). */
export function dropMetricSeenState(sessionId) {
    if (!sessionId) return;
    _metricSeenIter.delete(sessionId);
    const state = _metricSaveState.get(sessionId);
    if (state) {
        state.closed = true;
        if (state.timer) { clearTimeout(state.timer); state.timer = null; }
        // Only delete the map entry when nothing is in flight — an in-flight
        // save's own .finally (guarded by state.closed above) performs the
        // cleanup itself once it settles, so a stray concurrent call cannot
        // recreate a fresh (non-closed) entry via _metricsSaveState() while
        // that write is still outstanding.
        if (!state.inFlight) _metricSaveState.delete(sessionId);
    }
    _pendingMetricsFlush.delete(sessionId);
}

/** Monotonic per-session ask/turn id for incremental usage idempotency. */
export function bumpUsageMetricsTurnId(session) {
    if (!session || typeof session !== 'object') return 0;
    const next = (Number(session.usageMetricsTurnId) || 0) + 1;
    session.usageMetricsTurnId = next;
    const seen = _metricSeenIter.get(session.id);
    if (seen) seen.clear();
    return next;
}

export function resolveUsageMetricsTurnId(session, delta = {}) {
    if (delta.usageMetricsTurnId != null && Number.isFinite(Number(delta.usageMetricsTurnId))) {
        return Number(delta.usageMetricsTurnId);
    }
    return Number(session?.usageMetricsTurnId) || 0;
}

/** Advance loop metrics epoch when agentLoop resets its iteration counter (post-compact). */
export function bumpUsageMetricsEpoch(session) {
    if (!session || typeof session !== 'object') return 0;
    const next = (Number(session.usageMetricsEpoch) || 0) + 1;
    session.usageMetricsEpoch = next;
    return next;
}

/**
 * Resolve usage-metrics epoch for idempotency (exported for regression smoke).
 * Prefers session.usageMetricsEpoch (bumped in loop on compact reset) and optional
 * delta.usageMetricsEpoch; falls back to iteration regression when loop did not bump.
 */
export function resolveUsageMetricsEpoch(session, delta = {}) {
    if (!session) return 0;
    let epoch = Number(session.usageMetricsEpoch) || 0;
    if (delta.usageMetricsEpoch != null && Number.isFinite(Number(delta.usageMetricsEpoch))) {
        epoch = Math.max(epoch, Number(delta.usageMetricsEpoch));
    }
    const idx = Number(delta.iterationIndex);
    const prevLastIdx = typeof session.lastIterationIndex === 'number'
        ? session.lastIterationIndex
        : null;
    if (
        (delta.usageMetricsEpoch == null || !Number.isFinite(Number(delta.usageMetricsEpoch)))
        && prevLastIdx !== null
        && Number.isFinite(idx)
        && idx < prevLastIdx
    ) {
        epoch += 1;
    }
    return epoch;
}

export function usageMetricsSourceKey(delta = {}) {
    const raw = delta.source ?? delta.usageSource;
    if (raw == null || raw === '') return 'provider_send';
    return String(raw);
}

/** Idempotency key for incremental usage persistence (exported for regression smoke). */
export function usageMetricsIdempotencyKey(sessionId, session, delta = {}) {
    const turnId = resolveUsageMetricsTurnId(session, delta);
    const epoch = resolveUsageMetricsEpoch(session, delta);
    const source = usageMetricsSourceKey(delta);
    return `${sessionId}:${turnId}:${epoch}:${delta.iterationIndex}:${source}`;
}

export function uncachedInputTokensForProvider(provider, inputTokens, cachedReadTokens = 0, cacheWriteTokens = 0) {
    const input = Number(inputTokens) || 0;
    if (input <= 0) return 0;
    // Anthropic-style providers report input_tokens excluding cache reads; OpenAI
    // Responses/Gemini-style providers report input_tokens inclusive of cached
    // prefix tokens. Keep both views so UI can show the real context footprint
    // and the fresh/new token portion without mistaking cache hits for a cache
    // break.
    if (providerInputExcludesCache(provider)) return input + (Number(cacheWriteTokens) || 0);
    return Math.max(input - (Number(cachedReadTokens) || 0) - (Number(cacheWriteTokens) || 0), 0);
}

/**
 * Apply terminal ask usage to session totals. Skips lifetime totals when incremental
 * per-iteration persistence already counted this turn (askSession path).
 */
export function applyAskTerminalUsageTotals(session, result, options = {}) {
    if (!session || !result?.usage) return;
    const skipTotals = options.skipTotalsIfIncremental === true;
    if (!skipTotals) {
        const inputTokens = result.usage.inputTokens || 0;
        const outputTokens = result.usage.outputTokens || 0;
        const cachedTokens = result.usage.cachedTokens || 0;
        const cacheWriteTokens = result.usage.cacheWriteTokens || 0;
        const uncachedInputTokens = uncachedInputTokensForProvider(session.provider, inputTokens, cachedTokens, cacheWriteTokens);
        session.totalInputTokens = (session.totalInputTokens || 0) + inputTokens;
        session.totalOutputTokens = (session.totalOutputTokens || 0) + outputTokens;
        session.tokensCumulative = (session.tokensCumulative || 0)
            + inputTokens
            + outputTokens;
        session.totalCachedReadTokens = (session.totalCachedReadTokens || 0) + cachedTokens;
        session.totalCacheWriteTokens = (session.totalCacheWriteTokens || 0) + cacheWriteTokens;
        session.totalUncachedInputTokens = (session.totalUncachedInputTokens || 0) + uncachedInputTokens;
    }
    const _lastTurn = result.lastTurnUsage || result.usage || {};
    const _lastInputTokens = _lastTurn.inputTokens || 0;
    const _lastCachedReadTokens = _lastTurn.cachedTokens || 0;
    const _lastCacheWriteTokens = _lastTurn.cacheWriteTokens || 0;
    session.lastInputTokens = _lastInputTokens;
    session.lastOutputTokens = _lastTurn.outputTokens || 0;
    session.lastCachedReadTokens = _lastCachedReadTokens;
    session.lastCacheWriteTokens = _lastCacheWriteTokens;
    session.lastUncachedInputTokens = uncachedInputTokensForProvider(
        session.provider,
        _lastInputTokens,
        _lastCachedReadTokens,
        _lastCacheWriteTokens,
    );
    const _inputExcludesCache = providerInputExcludesCache(session.provider);
    session.lastContextTokens = _inputExcludesCache
        ? _lastInputTokens + _lastCachedReadTokens + _lastCacheWriteTokens
        : _lastInputTokens;
    session.lastContextTokensUpdatedAt = Date.now();
    session.lastContextTokensStaleAfterCompact = false;
}

/**
 * Persist incremental usage delta immediately after each provider.send iteration.
 * Idempotency key `sessionId:turnId:epoch:iterationIndex:source` scopes retries
 * per ask, compaction epoch, iteration, and usage source.
 */
export async function persistIterationMetrics(delta) {
    if (!delta || !delta.sessionId) return;
    const { sessionId, iterationIndex, deltaInput, deltaOutput, deltaCachedRead, deltaCacheWrite, ts } = delta;
    const runtimeEntry = _getRuntimeEntry(sessionId);
    const session = runtimeEntry?.session ?? loadSession(sessionId);
    if (!session || session.closed) return;
    const epoch = resolveUsageMetricsEpoch(session, delta);
    if (epoch !== (Number(session.usageMetricsEpoch) || 0)) {
        session.usageMetricsEpoch = epoch;
    }
    let seen = _metricSeenIter.get(sessionId);
    if (!seen) {
        seen = new Set();
        _metricSeenIter.set(sessionId, seen);
    }
    const ikey = usageMetricsIdempotencyKey(sessionId, session, delta);
    const isReplay = seen.has(ikey);
    seen.add(ikey);
    if (!isReplay) {
        if (runtimeEntry) runtimeEntry.usageMetricsTurnIncremental = true;
        const deltaUncachedInput = delta.deltaUncachedInput != null
            ? Number(delta.deltaUncachedInput) || 0
            : uncachedInputTokensForProvider(session.provider, deltaInput, deltaCachedRead, deltaCacheWrite);
        session.totalInputTokens = (session.totalInputTokens || 0) + (deltaInput || 0);
        session.totalOutputTokens = (session.totalOutputTokens || 0) + (deltaOutput || 0);
        session.tokensCumulative = (session.tokensCumulative || 0) + (deltaInput || 0) + (deltaOutput || 0);
        // Cache totals — additive fields, default 0 on legacy sessions; both
        // are undefined-safe so the schema migrates lazily as new iterations
        // land. Keeps live + terminal aggregates in lock-step (loop.mjs already
        // includes cached_read / cache_write in its terminal usage rollup).
        session.totalCachedReadTokens = (session.totalCachedReadTokens || 0) + (deltaCachedRead || 0);
        session.totalCacheWriteTokens = (session.totalCacheWriteTokens || 0) + (deltaCacheWrite || 0);
        session.totalUncachedInputTokens = (session.totalUncachedInputTokens || 0) + deltaUncachedInput;
        // Window snapshot updated per iteration so agent type=list reflects the
        // most-recent provider-reported input size even for short dispatches
        // that finish before askSession's terminal save lands.
        session.lastInputTokens = deltaInput || 0;
        session.lastOutputTokens = deltaOutput || 0;
        session.lastCachedReadTokens = deltaCachedRead || 0;
        session.lastCacheWriteTokens = deltaCacheWrite || 0;
        session.lastUncachedInputTokens = deltaUncachedInput;
        // Normalized last-call context footprint: how many prompt tokens the
        // model actually saw on the most-recent send, comparable ACROSS
        // providers. Anthropic reports input_tokens EXCLUDING cache (cache_read
        // is a separate field), so the cached portion must be added back to
        // reflect real context size; openai/grok/gemini already fold cached
        // tokens INTO the input count, so input alone is the footprint.
        const _inputExcludesCache = providerInputExcludesCache(session.provider);
        session.lastContextTokens = _inputExcludesCache
            ? (deltaInput || 0) + (deltaCachedRead || 0) + (deltaCacheWrite || 0)
            : (deltaInput || 0);
        session.lastContextTokensUpdatedAt = ts || Date.now();
        session.lastContextTokensStaleAfterCompact = false;
    }
    session.lastIterationIndex = iterationIndex;
    session.updatedAt = ts || Date.now();
    // Coalesced mid-turn persistence (see _scheduleMetricsSave above): an
    // in-flight guard + >=500ms per-session throttle collapse the per-
    // iteration saveSessionAsync postMessage/clone cost. The idempotency Set
    // update above already happened unconditionally this call, so a
    // throttled/skipped flush here never loses delta accounting — only the
    // disk-write cadence changes. Terminal save at turn end (askSession) and
    // the exit drain above both still cover the last pending delta.
    _scheduleMetricsSave(session, sessionId);
}
