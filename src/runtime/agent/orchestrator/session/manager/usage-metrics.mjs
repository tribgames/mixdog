// Incremental + terminal usage-metrics accounting for sessions.
// Extracted verbatim from manager.mjs (behavior-preserving). Pure helpers plus
// per-session idempotency tracking for incremental usage persistence.
//
// Runtime coupling is injected: persistIterationMetrics needs the live
// _runtimeState map (owned by manager.mjs) to read the in-memory session and
// flag usageMetricsTurnIncremental. manager.mjs wires it via configureUsageMetricsRuntime().
import { providerInputExcludesCache } from '../../providers/registry.mjs';
import {
    loadSession,
    saveSessionAsync,
    parkSessionSnapshotForDrain,
    unparkSessionSnapshotForDrain,
    registerSessionPurgeHook,
} from '../store.mjs';

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
// While parked, the snapshot is ALSO registered with the store's own deferred
// map (parkSessionSnapshotForDrain), so the canonical drain — not a second
// exit hook — persists it under the shared epoch/lock/fence ordering.
const _pendingMetricsFlush = new Map();
const METRICS_SAVE_THROTTLE_MS = 500;

function _metricsSaveState(sessionId) {
    let state = _metricSaveState.get(sessionId);
    if (state && state.closed) {
        // A CLOSED state belongs to a previous incarnation of this id (hard
        // delete or close). It is never reused — and it must not block a
        // re-created session: drop it and mint a fresh one. The old object
        // stays non-current, so its in-flight callbacks remain inert.
        _metricSaveState.delete(sessionId);
        state = null;
    }
    if (!state) {
        state = { inFlight: false, dirty: false, lastFlushAt: 0, timer: null, closed: false, failCount: 0, drainHandle: null };
        _metricSaveState.set(sessionId, state);
    }
    return state;
}

// Park/unpark keep the module-local ref and the store's drain registration in
// lock-step. The park carries the generation observed when the delta was
// applied, so a lifecycle barrier landing later still fences it by ownership.
function _parkMetricsSnapshot(state, sessionId, session) {
    _pendingMetricsFlush.set(sessionId, session);
    state.drainHandle = parkSessionSnapshotForDrain(
        session,
        { expectedGeneration: session.generation },
        state.drainHandle,
    );
}

function _unparkMetricsSnapshot(state, sessionId) {
    // The shared map belongs to whichever state currently OWNS the id: an old
    // (closed) callback must never erase the snapshot a re-created session
    // parked under the same id.
    if (!_metricSaveState.has(sessionId) || _metricSaveState.get(sessionId) === state) {
        _pendingMetricsFlush.delete(sessionId);
    }
    if (!state?.drainHandle) return;
    unparkSessionSnapshotForDrain(state.drainHandle);
    state.drainHandle = null;
}

/**
 * Authoritative liveness of a save-state object. A hard delete (or a close)
 * marks the CURRENT state closed and drops it from the registry, so a callback
 * still holding that object must never re-park, re-arm a timer or re-flush —
 * not even for one microtask, which would be enough to re-create the file the
 * delete just unlinked.
 */
function _isMetricsStateCurrent(sessionId, state) {
    return !!state && state.closed !== true && _metricSaveState.get(sessionId) === state;
}

function _flushMetricsSave(session, sessionId, state = _metricSaveState.get(sessionId)) {
    if (!_isMetricsStateCurrent(sessionId, state)) {
        // Purged/closed while this flush was queued: leave no trace behind.
        _unparkMetricsSnapshot(state, sessionId);
        return;
    }
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    // The park STAYS for the whole in-flight lifecycle and carries this
    // snapshot's identity: the save — and every retry of it — runs under the
    // epoch and guarded options (expectedGeneration included) assigned when the
    // delta was first deferred. Minting fresh authority on a retry would let a
    // stale payload outrank a session save that landed in the meantime.
    _parkMetricsSnapshot(state, sessionId, session);
    const identity = state.drainHandle;
    state.dirty = false;
    state.inFlight = true;
    state.lastFlushAt = Date.now();
    // Set when the store's exit drain settles this write: the drain already
    // wrote the newest snapshot for the id and cleared its deferred handle, so
    // that settlement is a TERMINAL ownership transfer for this identity.
    let drainSettled = false;
    saveSessionAsync(
        session,
        identity?.opts ?? { expectedGeneration: session.generation },
        identity ? { epoch: identity.epoch, revision: identity.revision } : undefined,
    )
        .then(() => {
            if (!_isMetricsStateCurrent(sessionId, state)) return;
            state.failCount = 0;
            // Durable — release the identity, but ONLY when no newer delta
            // parked itself behind this write (that snapshot is not durable
            // yet and must stay in the canonical drain).
            if (!state.dirty) _unparkMetricsSnapshot(state, sessionId);
        })
        .catch((err) => {
            process.stderr.write(`[usage-metrics] iteration save failed: ${err?.message ?? err}\n`);
            if (err?.sessionStoreDrained === true) {
                // Drain owns durability now. Re-parking here would register a
                // NEW identity (fresh epoch) for an old payload, which could
                // then overwrite a save that lands after the drain; retrying
                // would do the same. Release the identity and stay inert.
                drainSettled = true;
                state.dirty = false;
                state.failCount = 0;
                _unparkMetricsSnapshot(state, sessionId);
                return;
            }
            // Hard delete / close settled this id while the write was in
            // flight: a re-park here would put a deferred entry (and with it a
            // drain-recreated file) back for a session that no longer exists.
            if (!_isMetricsStateCurrent(sessionId, state)) return;
            // A rejected save must not silently drop the delta already
            // applied in-memory — re-park it so the process-exit drain
            // and/or the retry below still see it.
            state.failCount += 1;
            state.dirty = true;
            // NEVER let the rejected closure overwrite a newer snapshot that
            // parked while this write was in flight: the latest parked ref
            // wins, under the same preserved identity.
            const latest = _pendingMetricsFlush.get(sessionId);
            _parkMetricsSnapshot(state, sessionId, latest ?? session);
        })
        .finally(() => {
            state.inFlight = false;
            if (drainSettled) return; // terminal: no repark, no retry, no timer
            if (!_isMetricsStateCurrent(sessionId, state)) {
                // dropMetricSeenState (close) or the hard-delete purge ran
                // while this save was in flight — do not resurrect per-session
                // state, timers or deferred entries.
                _unparkMetricsSnapshot(state, sessionId);
                if (_metricSaveState.get(sessionId) === state) _metricSaveState.delete(sessionId);
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
                _flushMetricsSave(latest, sessionId, state);
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
        _parkMetricsSnapshot(state, sessionId, session);
        return;
    }
    const elapsed = Date.now() - state.lastFlushAt;
    if (elapsed >= METRICS_SAVE_THROTTLE_MS) {
        _flushMetricsSave(session, sessionId, state);
        return;
    }
    state.dirty = true;
    _parkMetricsSnapshot(state, sessionId, session);
    if (!state.timer) {
        const t = setTimeout(() => {
            state.timer = null;
            if (!state.inFlight && _isMetricsStateCurrent(sessionId, state)) {
                const latest = _pendingMetricsFlush.get(sessionId) ?? session;
                _flushMetricsSave(latest, sessionId, state);
            }
        }, METRICS_SAVE_THROTTLE_MS - elapsed);
        if (t.unref) t.unref();
        state.timer = t;
    }
}

// NO second exit-flush path lives here on purpose. Process exit can land
// inside the throttle window, before the trailing timer ever calls
// saveSessionAsync — but the parked snapshot is registered with the store's
// own deferred map, so drainSessionStore() persists it in the canonical
// ordering (epoch rank, fresh cancellation guard, shared commit lock,
// ownership generation, landed-epoch fence, one global deadline). A
// sync-flush here would instead mint fresh write authority AFTER that drain
// and could overwrite a newer landed session or a lifecycle barrier.
//
// Hard delete is the mirror image: the store runs this module's own cleanup
// synchronously (timers cancelled, park dropped, state closed) before it
// unlinks the file, so no retry and no drain entry can resurrect it.
registerSessionPurgeHook((sessionId) => dropMetricSeenState(sessionId));

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
    _unparkMetricsSnapshot(state, sessionId);
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
    if (_lastTurn.mainUsageAvailable === false) {
        session.lastInputTokens = null;
        session.lastOutputTokens = null;
        session.lastCachedReadTokens = null;
        session.lastCacheWriteTokens = null;
        session.lastUncachedInputTokens = null;
        session.lastContextTokens = null;
        session.lastContextTokensUpdatedAt = Date.now();
        session.lastContextTokensStaleAfterCompact = true;
        return;
    }
    const _lastInputTokens = _lastTurn.mainInputTokens ?? _lastTurn.inputTokens ?? 0;
    const _lastCachedReadTokens = _lastTurn.mainCachedTokens ?? _lastTurn.cachedTokens ?? 0;
    const _lastCacheWriteTokens = _lastTurn.mainCacheWriteTokens ?? _lastTurn.cacheWriteTokens ?? 0;
    session.lastInputTokens = _lastInputTokens;
    session.lastOutputTokens = _lastTurn.mainOutputTokens ?? _lastTurn.outputTokens ?? 0;
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
    const {
        sessionId,
        iterationIndex,
        deltaInput,
        deltaOutput,
        deltaCachedRead,
        deltaCacheWrite,
        contextInputTokens = deltaInput,
        contextOutputTokens = deltaOutput,
        contextCachedReadTokens = deltaCachedRead,
        contextCacheWriteTokens = deltaCacheWrite,
        contextUsageAvailable = true,
        ts,
    } = delta;
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
        if (contextUsageAvailable === false) {
            session.lastInputTokens = null;
            session.lastOutputTokens = null;
            session.lastCachedReadTokens = null;
            session.lastCacheWriteTokens = null;
            session.lastUncachedInputTokens = null;
            session.lastContextTokens = null;
            session.lastContextTokensUpdatedAt = ts || Date.now();
            session.lastContextTokensStaleAfterCompact = true;
        } else {
            const contextUncachedInput = uncachedInputTokensForProvider(
                session.provider,
                contextInputTokens,
                contextCachedReadTokens,
                contextCacheWriteTokens,
            );
            session.lastInputTokens = contextInputTokens || 0;
            session.lastOutputTokens = contextOutputTokens || 0;
            session.lastCachedReadTokens = contextCachedReadTokens || 0;
            session.lastCacheWriteTokens = contextCacheWriteTokens || 0;
            session.lastUncachedInputTokens = contextUncachedInput;
        // Normalized last-call context footprint: how many prompt tokens the
        // model actually saw on the most-recent send, comparable ACROSS
        // providers. Anthropic reports input_tokens EXCLUDING cache (cache_read
        // is a separate field), so the cached portion must be added back to
        // reflect real context size; openai/grok/gemini already fold cached
        // tokens INTO the input count, so input alone is the footprint.
            const _inputExcludesCache = providerInputExcludesCache(session.provider);
            session.lastContextTokens = _inputExcludesCache
                ? (contextInputTokens || 0) + (contextCachedReadTokens || 0) + (contextCacheWriteTokens || 0)
                : (contextInputTokens || 0);
            session.lastContextTokensUpdatedAt = ts || Date.now();
            session.lastContextTokensStaleAfterCompact = false;
        }
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
