// Incremental + terminal usage-metrics accounting for sessions.
// Pure helpers plus per-session idempotency tracking for incremental usage
// persistence.
//
// Runtime coupling is injected: persistIterationMetrics needs the live
// _runtimeState map (owned by manager.mjs) to read the in-memory session and
// flag usageMetricsTurnIncremental. manager.mjs wires it via configureUsageMetricsRuntime().
import { providerInputExcludesCache } from '../../providers/registry.mjs';
import { reasoningUsage, combineReasoningUsage } from '../../../../shared/llm/reasoning-usage.mjs';
import { foldUsageReadout } from '../../../../shared/usage-readout-totals.mjs';
import { emitSessionActivityChange } from '../../../../shared/session-activity-signal.mjs';
import { loadSession, saveSession, registerSessionPurgeHook } from '../store.mjs';

// Per-session idempotency tracking: sessionId → Set of seen
// turn:epoch:iteration:source keys.
const _metricSeenIter = new Map();

// A hard delete drops the session's idempotency state with it. The store's
// own delete takes any debounced copy of the session and fences the id, so no
// metrics save recreates it.
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
  const prevLastIdx = typeof session.lastIterationIndex === 'number' ? session.lastIterationIndex : null;
  if (
    (delta.usageMetricsEpoch == null || !Number.isFinite(Number(delta.usageMetricsEpoch))) &&
    prevLastIdx !== null &&
    Number.isFinite(idx) &&
    idx < prevLastIdx
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
 * Providers that report whole-context occupancy instead of a prompt count
 * (Cursor checkpoint usedTokens) still produce a measured gauge reading. The
 * prompt/cache split stays unknown (null), never zero, so billing lanes and
 * cache-rate displays do not invent numbers.
 */
function applyMeasuredContextOccupancy(session, contextTokens, outputTokens, ts) {
  const occupancy = Number(contextTokens);
  if (!Number.isFinite(occupancy) || occupancy <= 0) return false;
  session.lastInputTokens = null;
  session.lastOutputTokens = Number(outputTokens) || 0;
  session.lastCachedReadTokens = null;
  session.lastCacheWriteTokens = null;
  session.lastUncachedInputTokens = null;
  session.lastContextTokens = Math.round(occupancy);
  session.lastContextTokensUpdatedAt = ts || Date.now();
  session.lastContextTokensStaleAfterCompact = false;
  return true;
}

/**
 * Apply terminal ask usage to session totals. Skips lifetime totals when incremental
 * per-iteration persistence already counted this turn (askSession path).
 */
export function applyAskTerminalUsageTotals(session, result, options = {}) {
  if (!session) return;
  if (!result?.usage) {
    session.reasoningUsage = {
      ...reasoningUsage(session.reasoningUsage),
      reasoningTokensComplete: false,
    };
    return;
  }
  if (options.skipTotalsIfIncremental !== true) {
    accumulateSessionUsage(session, {
      deltaInput: result.usage.inputTokens || 0,
      deltaOutput: result.usage.outputTokens || 0,
      deltaToolCalls: result.toolCallsTotal || 0,
      ...reasoningUsage(result.usage),
      deltaCachedRead: result.usage.cachedTokens || 0,
      deltaCacheWrite: result.usage.cacheWriteTokens || 0,
    });
  }
  const lastTurn = result.lastTurnUsage || result.usage || {};
  const contextInput = lastTurn.contextInputTokens ?? lastTurn.inputTokens;
  const measuredInput = Number(contextInput) || 0;
  const measuredCache = providerInputExcludesCache(session.provider)
    ? (Number(lastTurn.cachedTokens) || 0) + (Number(lastTurn.cacheWriteTokens) || 0)
    : 0;
  if (
    measuredInput + measuredCache <= 0 &&
    applyMeasuredContextOccupancy(session, lastTurn.contextTokens, lastTurn.outputTokens)
  ) {
    return;
  }
  if (measuredInput + measuredCache <= 0) {
    clearLastContextTokens(session);
    return;
  }
  setLastContextTokens(session, {
    input: contextInput ?? 0,
    output: lastTurn.outputTokens ?? 0,
    cachedRead: lastTurn.contextCachedTokens ?? lastTurn.cachedTokens ?? 0,
    cacheWrite: lastTurn.cacheWriteTokens ?? 0,
    outputInWindow: lastTurn.contextInputTokens != null,
  });
}

// No usable prompt split for the last call: the window snapshot is unknown
// until the next measured send.
function clearLastContextTokens(session, ts) {
  session.lastInputTokens = null;
  session.lastOutputTokens = null;
  session.lastCachedReadTokens = null;
  session.lastCacheWriteTokens = null;
  session.lastUncachedInputTokens = null;
  session.lastContextTokens = null;
  session.lastContextTokensUpdatedAt = ts || Date.now();
  session.lastContextTokensStaleAfterCompact = true;
}

// The last call's prompt split plus its normalized context footprint: how
// many prompt tokens the model actually saw on the most-recent send,
// comparable ACROSS providers. Anthropic reports input_tokens EXCLUDING
// cache (cache_read is a separate field), so the cached portion must be
// added back to reflect real context size; openai/grok/gemini already fold
// cached tokens INTO the input count, so input alone is the footprint.
// `outputInWindow`: the input is the context's prompt part and the generated
// output is in the window too (a billed input that repeats hop input, Gemini
// long decode), so the footprint adds it as the compaction pressure does.
function setLastContextTokens(session, { input, output, cachedRead, cacheWrite, outputInWindow = false, ts }) {
  session.lastInputTokens = input;
  session.lastOutputTokens = output;
  session.lastCachedReadTokens = cachedRead;
  session.lastCacheWriteTokens = cacheWrite;
  session.lastUncachedInputTokens = uncachedInputTokensForProvider(session.provider, input, cachedRead, cacheWrite);
  session.lastContextTokens =
    (providerInputExcludesCache(session.provider) ? input + cachedRead + cacheWrite : input) +
    (outputInWindow ? output : 0);
  session.lastContextTokensUpdatedAt = ts || Date.now();
  session.lastContextTokensStaleAfterCompact = false;
}

// Cumulative session totals. Cache totals are additive fields, default 0 on
// legacy sessions; both are undefined-safe so the schema migrates lazily as
// new iterations land. Keeps live + terminal aggregates in lock-step
// (loop.mjs already includes cached_read / cache_write in its terminal
// usage rollup).
function accumulateSessionUsage(session, delta) {
  const { deltaInput, deltaOutput, deltaCachedRead, deltaCacheWrite } = delta;
  // Old sessions have spend but no reasoning counters. Their past usage must
  // remain unknown, even after the first newly measured response arrives.
  const hadUsage = session.reasoningUsage || session.totalInputTokens > 0 || session.totalOutputTokens > 0;
  session.reasoningUsage = hadUsage ? combineReasoningUsage(session.reasoningUsage, delta) : reasoningUsage(delta);
  const deltaUncachedInput =
    delta.deltaUncachedInput != null
      ? Number(delta.deltaUncachedInput) || 0
      : uncachedInputTokensForProvider(session.provider, deltaInput, deltaCachedRead, deltaCacheWrite);
  session.totalInputTokens = (session.totalInputTokens || 0) + (deltaInput || 0);
  session.totalOutputTokens = (session.totalOutputTokens || 0) + (deltaOutput || 0);
  session.totalToolCalls = (session.totalToolCalls || 0) + (delta.deltaToolCalls || 0);
  session.tokensCumulative = (session.tokensCumulative || 0) + (deltaInput || 0) + (deltaOutput || 0);
  session.totalCachedReadTokens = (session.totalCachedReadTokens || 0) + (deltaCachedRead || 0);
  session.totalCacheWriteTokens = (session.totalCacheWriteTokens || 0) + (deltaCacheWrite || 0);
  session.totalUncachedInputTokens = (session.totalUncachedInputTokens || 0) + deltaUncachedInput;
}

// Window snapshot updated per iteration so agent type=list reflects the
// most-recent provider-reported input size even for short dispatches that
// finish before askSession's terminal save lands.
function recordLastContextTokens(session, context) {
  const {
    contextInputTokens,
    contextOutputTokens,
    contextCachedReadTokens,
    contextCacheWriteTokens,
    contextMeasuredTokens,
    contextOutputInWindow,
    ts,
  } = context;
  const inputExcludesCache = providerInputExcludesCache(session.provider);
  const measuredPrompt =
    (Number(contextInputTokens) || 0) +
    (inputExcludesCache ? (Number(contextCachedReadTokens) || 0) + (Number(contextCacheWriteTokens) || 0) : 0);
  if (measuredPrompt <= 0 && applyMeasuredContextOccupancy(session, contextMeasuredTokens, contextOutputTokens, ts)) {
    // Occupancy reading applied; no prompt split to record.
    return;
  }
  if (measuredPrompt <= 0) {
    clearLastContextTokens(session, ts);
    return;
  }
  setLastContextTokens(session, {
    input: contextInputTokens || 0,
    output: contextOutputTokens || 0,
    cachedRead: contextCachedReadTokens || 0,
    cacheWrite: contextCacheWriteTokens || 0,
    outputInWindow: contextOutputInWindow === true,
    ts,
  });
}

/**
 * Persist incremental usage delta immediately after each provider.send iteration.
 * Idempotency key `sessionId:turnId:epoch:iterationIndex:source` scopes retries
 * per ask, compaction epoch, iteration, and usage source.
 */
// The window reading an iteration delta carries; each context field defaults
// to the delta's own token counts.
function iterationContext(delta) {
  const {
    contextInputTokens = delta.deltaInput,
    contextOutputTokens = delta.deltaOutput,
    contextCachedReadTokens = delta.deltaCachedRead,
    contextCacheWriteTokens = delta.deltaCacheWrite,
    contextMeasuredTokens = null,
    contextOutputInWindow = false,
    ts,
  } = delta;
  return {
    contextInputTokens,
    contextOutputTokens,
    contextCachedReadTokens,
    contextCacheWriteTokens,
    contextMeasuredTokens,
    contextOutputInWindow,
    ts,
  };
}

export async function persistIterationMetrics(delta) {
  if (!delta?.sessionId) return;
  const { sessionId, iterationIndex, ts } = delta;
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
    accumulateSessionUsage(session, delta);
    // The composer readout's session-cumulative cache hit and speed: one fold
    // per model call of this session (every tool-loop iteration), replaced
    // immutably so a consumer can tell by identity that it changed. Sessions
    // saved before this field began at their first call after it.
    session.usageReadout = foldUsageReadout(session.usageReadout, delta, delta.requestMs);
    recordLastContextTokens(session, iterationContext(delta));
    // The Agents pool shows each agent's running totals from this live
    // counter: it re-reads on this pulse instead of the next throttled save.
    emitSessionActivityChange(sessionId);
  }
  session.lastIterationIndex = iterationIndex;
  session.updatedAt = ts || Date.now();
  // The store's debounced save coalesces the per-iteration writes into one
  // record of what changed; the terminal save at turn end and the exit drain
  // both cover the last of them. A copy issued for an older ownership is
  // dropped by its generation.
  saveSession(session, { expectedGeneration: session.generation });
}
