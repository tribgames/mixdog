/**
 * src/ui/statusline.mjs — per-turn footer status line.
 *
 * The bottom statusline is rendered from CLI-native state. This module is the
 * normalizing boundary: TUI/REPL state comes in, L1/L2 text comes out.
 *
 * `createSessionStats()` returns a small accumulator the REPL feeds from the
 * engine's `onUsageDelta` callback. Gateway quota/balance helpers are still
 * reused as read-only data sources, but display identity always belongs to the
 * CLI route passed here.
 */
import { readCachedOAuthUsageSnapshot } from '../runtime/agent/orchestrator/providers/oauth-usage.mjs';
import { readCachedOpenCodeGoUsageSnapshot } from '../runtime/agent/orchestrator/providers/opencode-go-usage.mjs';
import { buildGatewayLimits } from '../runtime/agent/orchestrator/providers/statusline-route-meta.mjs';
import { compactBoundaryForStatus, formatGatewayLimitSegments, loadGatewayStatus } from '../vendor/statusline/bin/statusline-route.mjs';
import { createSessionStats } from './session-stats.mjs';
import {
  FALLBACK_CONTEXT_WINDOW, statusSubtle,
  R, B, D, GRN, YLW, RED,
  terminalColumns, modelContextWindow, formatModelSegment,
  formatContextSegment, colourPct, epochMsToHHMM,
  num, formatElapsed,
} from './statusline-format.mjs';
import { shellJobsStatus, memoryCycleStatus } from './statusline-segments.mjs';
import {
  summarizeWorkerTags, agentStatuslinePayload, classifyAgentWorkers, activeHiddenAgentWorkers,
} from './statusline-agents.mjs';
export { createSessionStats, applyUsageDelta } from './session-stats.mjs';
// Facade re-exports: keep these public symbols resolving from statusline.mjs.
export { contextPctDisplayLabel } from './statusline-format.mjs';

const GATEWAY_QUOTA_STATUS_CACHE_MS = 500;
// Render-path sync-fs guard: loadGatewayStatus() / readCached*UsageSnapshot()
// below still read files synchronously (vendored/provider modules), but that
// work must never run on the 500ms render tick's own call stack. Both
// gateway-status and fallback-quota lookups below are stale-while-revalidate:
// the render call returns the last cached value immediately and defers the
// actual sync read to a separate macrotask (setImmediate), guarded so only
// one refresh per cache is ever in flight at a time. Visible cache cadence
// (500ms) is unchanged.
const WORKER_SPINNER_FRAMES = Object.freeze(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);
// L2 segment spinner: reuses the original WORKER_SPINNER_FRAMES dot glyphs (no
// separate glyph list) but spins them at a faster 120ms step than the worker
// spinner's 160ms. l2SpinnerFrame() indexes straight into WORKER_SPINNER_FRAMES.
const L2_SPINNER_FRAME_MS = 120;
// Keep the last known usage snapshot visible while idle. The runtime still
// refreshes OAuth usage in the background, but if that refresh is delayed or
// fails, the statusline should not blink/drop the usage segment; it should hold
// the last captured 5H/7D values from THIS process until a newer snapshot
// replaces them. Snapshots from a previous launch stay hidden during boot so the
// statusline starts empty until the current session captures usage once.
const STATUSLINE_PROCESS_STARTED_AT_MS = Date.now() - Math.floor((Number(process.uptime?.()) || 0) * 1000);
let _gatewayQuotaStatusCache = { key: '', routeKey: '', at: 0, value: null };
let _fallbackQuotaStatusCache = { key: '', at: 0, value: null };
// Holds the last non-empty rendered L1 quota/usage segments per provider+route
// key, but ONLY for providers that have actually armed the OAuth boot latch
// (_oauthUsageArmedProviders) — non-OAuth providers (which oauthUsageSegmentReady
// also returns true for, since they are never gated) must keep their exact
// prior empty/null behavior, unaffected by this hold. Once armed and at least
// one non-empty quota segment set has been rendered for a route, a transient
// resolution failure (cache miss / gateway hiccup) that would otherwise
// collapse quotaSegments to [] instead re-uses the last held segments, so the
// L1 segment does not blink out. Replaced only when a newer non-empty result
// lands for the SAME key. The key includes sessionId + clientHostPid because
// rendered segments can embed session-scoped routeSpend — without those, a new
// session sharing provider/model/effort/fast could reuse a stale prior
// session's spend. Capped at a small LRU size so long-running processes that
// cycle through many sessions/routes don't grow this map unbounded.
const _lastNonEmptyQuotaSegmentsByKey = new Map();
const LAST_NON_EMPTY_QUOTA_SEGMENTS_CACHE_MAX = 8;

function quotaSegmentsHoldKey({ provider, model, effort, fast, sessionId, clientHostPid } = {}) {
  return [
    String(provider || '').trim().toLowerCase(),
    String(model || '').trim(),
    String(effort || '').trim(),
    fast === true ? 'fast' : '',
    String(sessionId || ''),
    String(clientHostPid || ''),
  ].join('\0');
}

function rememberNonEmptyQuotaSegments(key, segments) {
  // Delete-then-set to bump this key to most-recently-used position (Map
  // iterates in insertion order), then evict the oldest entry if over cap.
  _lastNonEmptyQuotaSegmentsByKey.delete(key);
  _lastNonEmptyQuotaSegmentsByKey.set(key, segments);
  if (_lastNonEmptyQuotaSegmentsByKey.size > LAST_NON_EMPTY_QUOTA_SEGMENTS_CACHE_MAX) {
    const oldestKey = _lastNonEmptyQuotaSegmentsByKey.keys().next().value;
    _lastNonEmptyQuotaSegmentsByKey.delete(oldestKey);
  }
}
// Option A boot gate: the L1 usage/quota segment stays fully empty until THIS
// process has captured its FIRST confirmed (current-process) OAuth usage
// snapshot for THAT provider. The latch is monotonic PER PROVIDER — once a
// provider arms it stays on for the process lifetime, so its segment turns on
// exactly once (single clean transition) and then holds. This suppresses the
// early gateway active-instance quota/balance (from another owning process,
// which is NOT process-start guarded) and any stale/in-progress reads before
// the first confirmed snapshot lands. Keyed per provider (not per global) so an
// in-process route switch (openai-oauth → anthropic-oauth / grok-oauth) re-gates
// the new provider until ITS own confirmed snapshot exists — otherwise the new
// provider's stale fallback balance (Credit $…) could leak prematurely.
const _oauthUsageArmedProviders = new Set();
// Guards the background arm-check (readCachedOAuthUsageSnapshot sync read)
// so oauthUsageSegmentReady() never runs it inline on the render call stack,
// and so at most one in-flight check per provider is scheduled at a time.
const _oauthArmCheckInFlight = new Set();
// Guards the background fallbackQuotaStatus() refresh (sync snapshot reads)
// so at most one refresh is ever in flight across render ticks.
let _fallbackQuotaRefreshInFlight = false;

function isConfirmedCurrentProcessSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const cachedAt = num(snapshot.cachedAt);
  return cachedAt > 0 && cachedAt >= STATUSLINE_PROCESS_STARTED_AT_MS;
}

function l2SpinnerFrame(now = Date.now()) {
  const index = Math.floor(now / L2_SPINNER_FRAME_MS) % WORKER_SPINNER_FRAMES.length;
  return WORKER_SPINNER_FRAMES[index] || WORKER_SPINNER_FRAMES[0];
}

/**
 * Build the status-line JSON the vendored renderer reads, from our REPL
 * state. Only the fields `renderStatusLine()` actually consumes are emitted:
 *   - display_name              → model name (L1)
 *   - effort.level              → effort string
 *   - context_window.*          → context% bar (used_percentage + raw tokens
 *                                 so the lib's activeContextTokens() also works)
 *   - session_id                → gateway session lookup
 * model / context% / effort / 5H-7D are overridden by the live gateway via
 * loadGatewayStatus() when it's running; these are the standalone fallbacks.
 */
function activeContextNumerator(provider, stats) {
  const s = stats || createSessionStats();
  const source = String(s.currentContextSource || '').toLowerCase();
  const estimated = num(s.currentEstimatedContextTokens);
  if (estimated > 0) return estimated;
  if (source === 'estimated') return 0;
  if (source === 'last_api_request') {
    const apiUsed = num(s.currentContextTokens);
    if (apiUsed > 0) return apiUsed;
  }
  const explicit = num(s.currentContextTokens ?? s.contextTokens);
  if (explicit > 0) return explicit;
  return 0;
}

function displayContextBoundary({
  contextWindow = 0,
  displayContextWindow = 0,
  rawContextWindow = 0,
  compactBoundaryTokens = 0,
  autoCompactTokenLimit = 0,
  compact = null,
} = {}) {
  const boundarySeed = num(compactBoundaryTokens) > 0
    ? num(compactBoundaryTokens)
    : (num(displayContextWindow) > 0 ? num(displayContextWindow) : num(contextWindow));
  const boundary = compactBoundaryForStatus({
    contextWindow: boundarySeed,
    rawContextWindow: num(rawContextWindow),
    autoCompactTokenLimit: num(autoCompactTokenLimit),
  }, compact);
  if (Number.isFinite(boundary) && boundary > 0) return boundary;
  return modelContextWindow('', '', boundarySeed);
}

function resolveContextUsedPct({
  provider = '',
  model = '',
  stats = null,
  contextWindow = 0,
  displayContextWindow = 0,
  rawContextWindow = 0,
  compactBoundaryTokens = 0,
  autoCompactTokenLimit = 0,
  gatewayStatus = null,
} = {}) {
  const numerator = activeContextNumerator(provider, stats);
  const compact = gatewayStatus?.lastUsage?.compact || null;
  const boundary = displayContextBoundary({
    contextWindow,
    displayContextWindow,
    rawContextWindow,
    compactBoundaryTokens,
    autoCompactTokenLimit,
    compact,
  });
  // Trigger-as-denominator: when a sub-boundary compaction trigger
  // (boundary - buffer) is known, context % is measured against IT so the
  // gauge reads 100% exactly when auto-compact fires instead of stalling at
  // ~90% of the boundary window. The gateway's own pct is computed against
  // the boundary denominator, so it is bypassed in that case.
  const trigger = num(autoCompactTokenLimit);
  const triggerDenominator = trigger > 0 && (!(boundary > 0) || trigger < boundary);
  if (triggerDenominator && numerator > 0) {
    return (numerator / trigger) * 100;
  }
  const gatewayRawPct = gatewayStatus?.contextUsedPct;
  if (
    gatewayStatus
    && gatewayRawPct !== null
    && gatewayRawPct !== undefined
  ) {
    const gatewayPct = Number(gatewayRawPct);
    if (Number.isFinite(gatewayPct)) return gatewayPct;
  }
  if (boundary > 0) return (numerator / boundary) * 100;
  return 0;
}

/**
 * Render the L1/L2 statusline footer from CLI state.
 *
 * ASYNC only because gateway quota helpers may touch the filesystem. On ANY
 * error we fall back to a minimal one-line footer so the REPL never sees a
 * throw.
 *
 * @param {object} opts
 * @param {string} opts.provider
 * @param {string} opts.model
 * @param {string} opts.cwd
 * @param {object} opts.stats — createSessionStats() accumulator
 * @param {string} [opts.sessionId]
 * @returns {Promise<string>}
 */
export async function renderStatusline({
  provider = '', model = '', effort = '', fast = false, cwd = '', stats, sessionId,
  contextWindow = 0, displayContextWindow = 0, rawContextWindow = 0,
  compactBoundaryTokens = 0, autoCompactTokenLimit = 0,
  agentWorkers = [], agentJobs = [], activeTools = null, clientHostPid = process.pid,
} = {}) {
  const displayArgs = {
    contextWindow, displayContextWindow, rawContextWindow, compactBoundaryTokens, autoCompactTokenLimit,
  };
  try {
    return renderNativeStatusline({
      provider, model, effort, fast, cwd, stats, sessionId, agentWorkers, agentJobs, activeTools, clientHostPid,
      ...displayArgs,
    });
  } catch {
    return fallbackLine({ provider, model, effort, fast, cwd, stats, ...displayArgs });
  }
}

// --- helpers -----------------------------------------------------------------

function renderNativeStatusline({
  provider = '', model = '', effort = '', fast = false, stats, sessionId,
  contextWindow = 0, displayContextWindow = 0, rawContextWindow = 0,
  compactBoundaryTokens = 0, autoCompactTokenLimit = 0,
  agentWorkers = [], agentJobs = [], activeTools = null, clientHostPid = process.pid,
} = {}) {
  const cols = terminalColumns();
  const s = stats || createSessionStats();
  const contextTokens = activeContextNumerator(provider, s);
  const routeContextWindow = num(displayContextWindow) > 0 ? num(displayContextWindow) : num(contextWindow);
  const gatewayStatus = loadGatewayQuotaStatus({
    provider, model, effort, fast,
    contextWindow: routeContextWindow,
    rawContextWindow,
    autoCompactTokenLimit,
    sessionId,
    activeContextTokens: contextTokens,
    clientHostPid,
  });
  const ctxPct = resolveContextUsedPct({
    provider,
    model,
    stats: s,
    contextWindow,
    displayContextWindow,
    rawContextWindow,
    compactBoundaryTokens,
    autoCompactTokenLimit,
    gatewayStatus,
  });

  const sep = ` ${D}│${R} `;
  const l1Parts = [];
  const l2Parts = [];
  const addL1 = (seg) => { if (seg) l1Parts.push(seg); };
  const addL2 = (seg) => { if (seg) l2Parts.push(seg); };

  addL1(formatModelSegment({ provider, model, effort, fast, cols }));
  addL1(formatContextSegment(ctxPct, cols));

  // Option A boot gate: for OAuth routes, render NOTHING for the usage/quota
  // segment until this process has captured its first confirmed (current-
  // process) OAuth usage snapshot. This suppresses the startup jitter where the
  // gateway active-instance quota windows (not process-start guarded) and the
  // boot-guarded OAuth cache windows would otherwise pop in/merge at different
  // ticks. Model + context% always render (built above). Non-OAuth routes are
  // unaffected. Once armed, the latch holds for the process lifetime so the
  // segment turns on exactly once and then holds the last known value as today.
  const usageReady = oauthUsageSegmentReady({ provider, model });
  const quotaStatus = usageReady
    ? mergeQuotaStatus(gatewayStatus, fallbackQuotaStatus({ provider, model }))
    : null;
  let quotaSegments = quotaStatus
    ? formatGatewayLimitSegments(quotaStatus, { COLS: cols, D, R, GRN, YLW, RED, colourPct, epochMsToHHMM })
    : [];
  // Only apply the hold to providers that actually armed the OAuth boot latch.
  // oauthUsageSegmentReady() also returns true for non-OAuth providers (they
  // are never gated), so gate the hold itself on _oauthUsageArmedProviders to
  // keep non-OAuth empty/null behavior byte-for-byte unchanged.
  const normalizedHoldProvider = String(provider || '').trim().toLowerCase();
  if (usageReady && _oauthUsageArmedProviders.has(normalizedHoldProvider)) {
    const holdKey = quotaSegmentsHoldKey({ provider, model, effort, fast, sessionId, clientHostPid });
    if (quotaSegments.length) {
      rememberNonEmptyQuotaSegments(holdKey, quotaSegments);
    } else {
      const held = _lastNonEmptyQuotaSegmentsByKey.get(holdKey);
      if (held && held.length) quotaSegments = held;
    }
  }
  for (const seg of quotaSegments) addL1(seg);

  const agentPayload = agentStatuslinePayload([
    ...(Array.isArray(agentWorkers) ? agentWorkers : []),
    ...activeHiddenAgentWorkers({ sessionId, clientHostPid }),
  ], agentJobs);
  const { runningWorkers } = classifyAgentWorkers(agentPayload.workers);
  const shellStatus = shellJobsStatus({ clientHostPid });

  const spinnerNow = Date.now();
  const sp = l2SpinnerFrame(spinnerNow);
  const spin = `${GRN}${sp}${R}`;
  const elapsedSuffix = (label) => (label ? ` ${D}·${R} ${label}` : '');
  // Segment order: Running Agents → Exploring → Searching → Running Shells.
  if (runningWorkers.length) {
    const n = runningWorkers.length;
    const label = `Running ${n} Agent${n === 1 ? '' : 's'}`;
    const tagSummary = summarizeWorkerTags(runningWorkers);
    const tags = tagSummary ? ` ${D}(${R}${B}${tagSummary}${R}${D})${R}` : '';
    const oldestStart = runningWorkers.reduce((min, w) => {
      const t = num(w?.startedAtMs);
      return t > 0 && t < min ? t : min;
    }, Infinity);
    const elapsed = Number.isFinite(oldestStart) ? formatElapsed(Date.now() - oldestStart) : '';
    addL2(`${spin} ${B}${label}${R}${tags}${elapsedSuffix(elapsed)}`);
  }
  const tools = activeTools && typeof activeTools === 'object' ? activeTools : {};
  const exploreInfo = tools.explore || null;
  const searchInfo = tools.search || null;
  if (exploreInfo && num(exploreInfo.count) > 0) {
    const elapsed = num(exploreInfo.startedAt) > 0 ? formatElapsed(Date.now() - num(exploreInfo.startedAt)) : '';
    addL2(`${spin} ${B}Exploring${R}${elapsedSuffix(elapsed)}`);
  }
  if (searchInfo && num(searchInfo.count) > 0) {
    const elapsed = num(searchInfo.startedAt) > 0 ? formatElapsed(Date.now() - num(searchInfo.startedAt)) : '';
    addL2(`${spin} ${B}Searching${R}${elapsedSuffix(elapsed)}`);
  }
  if (shellStatus.count > 0) {
    const n = shellStatus.count;
    const label = `Running ${n} Shell${n === 1 ? '' : 's'}`;
    addL2(`${spin} ${B}${label}${R}${elapsedSuffix(shellStatus.elapsedLabel)}`);
  }
  // Memory cycle segment — single unified "Memory" wording for all states:
  // running -> "⠋ Memory · 12s". Backlog is intentionally NOT rendered
  // (owner preference: cycle-health WARN logs cover it); nothing when idle.
  const memStatus = memoryCycleStatus();
  if (memStatus?.kind === 'running') {
    const elapsed = formatElapsed(Date.now() - memStatus.startedAt);
    addL2(`${spin} ${B}Memory${R}${elapsedSuffix(elapsed)}`);
  }
  const l1 = l1Parts.join(sep) || 'mixdog';
  const l2 = l2Parts.join(sep);
  return l2 ? `${l1}\n${l2}` : l1;
}

let _gatewayQuotaRefreshInFlight = false;

function loadGatewayQuotaStatus({
  provider, model, effort, fast, contextWindow, rawContextWindow, autoCompactTokenLimit = 0,
  sessionId, activeContextTokens, clientHostPid,
} = {}) {
  // Route identity: which route this cached value belongs to. Serving a stale
  // value across a routeKey change would leak the previous provider/model's
  // quota into the new route, so mismatches return null instead.
  const routeKey = [
    String(provider || ''),
    String(model || ''),
    String(effort || ''),
    fast === true ? 'fast' : '',
    String(sessionId || ''),
    String(clientHostPid || ''),
  ].join('\0');
  // Freshness key: same route, but any of these changing should trigger a
  // refresh (stale value still serveable meanwhile — same route identity).
  const key = [
    routeKey,
    String(contextWindow ?? ''),
    String(rawContextWindow ?? ''),
    String(autoCompactTokenLimit ?? ''),
    Math.floor((Number(activeContextTokens) || 0) / 1024),
  ].join('\0');
  const now = Date.now();
  const fresh = _gatewayQuotaStatusCache.key === key && now - _gatewayQuotaStatusCache.at < GATEWAY_QUOTA_STATUS_CACHE_MS;
  if (fresh) {
    return _gatewayQuotaStatusCache.value;
  }
  // Stale-while-revalidate: serve the last cached value for THIS render call
  // only if it belongs to the SAME route, and kick a background refresh off
  // the render call stack. Guarded so concurrent render ticks never queue
  // more than one refresh at a time.
  if (!_gatewayQuotaRefreshInFlight) {
    _gatewayQuotaRefreshInFlight = true;
    setImmediate(() => {
      let value = null;
      try {
        const status = loadGatewayStatus({
          sessionId,
          activeContextTokens,
          clientHostPid,
          currentRoute: {
            provider,
            model,
            effort,
            fast,
            contextWindow,
            rawContextWindow,
            autoCompactTokenLimit,
          },
        });
        const statusProvider = String(status?.provider || '').trim();
        const cliProvider = String(provider || '').trim();
        const statusModel = String(status?.model || '').trim();
        const cliModel = String(model || '').trim();
        if (status && !(cliProvider && statusProvider && statusProvider !== cliProvider)
          && !(cliModel && statusModel && statusModel !== cliModel)) {
          value = status;
        }
      } catch {
        value = null;
      }
      _gatewayQuotaStatusCache = { key, routeKey, at: Date.now(), value };
      _gatewayQuotaRefreshInFlight = false;
    });
  }
  return _gatewayQuotaStatusCache.routeKey === routeKey ? _gatewayQuotaStatusCache.value : null;
}

// Option A boot gate. Returns true once THIS process has captured its first
// confirmed (current-process) OAuth usage snapshot for THIS provider, and stays
// true afterwards (monotonic, per-provider latch). Non-OAuth providers are never
// gated (they have no async usage fetch on this path). Keyed on provider only:
// the OAuth cache lookup is provider-keyed and snapshots are stored provider-
// wide (oauth-usage.mjs writes a provider-only key + uses newestProviderSnapshot
// fallback), so per-provider arming matches the data granularity — a model
// switch within one provider shares the same provider-wide snapshot. The latch
// reads the same cache `fallbackQuotaStatus()` consumes so it flips in lock-step
// with the data actually becoming renderable — no extra delay, single clean
// transition.
function oauthUsageSegmentReady({ provider, model } = {}) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  if (!normalizedProvider.includes('oauth')) return true;
  if (_oauthUsageArmedProviders.has(normalizedProvider)) return true;
  // Not yet armed: never do the sync snapshot read on this render call. Kick
  // one background check (guarded per-provider) and keep returning false
  // (today's pre-arm behavior) until it flips the latch.
  if (!_oauthArmCheckInFlight.has(normalizedProvider)) {
    _oauthArmCheckInFlight.add(normalizedProvider);
    setImmediate(() => {
      try {
        const snapshot = readCachedOAuthUsageSnapshot({
          provider: normalizedProvider,
          model: String(model || '').trim(),
          providerKind: providerKindForQuota(normalizedProvider),
        }, { allowStale: true });
        if (isConfirmedCurrentProcessSnapshot(snapshot)) {
          _oauthUsageArmedProviders.add(normalizedProvider);
        }
      } catch {
        /* stay unarmed; next tick retries */
      } finally {
        _oauthArmCheckInFlight.delete(normalizedProvider);
      }
    });
  }
  return false;
}

function fallbackQuotaStatus({ provider, model } = {}) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  if (!normalizedProvider) return null;
  const cacheKey = `${normalizedProvider}\0${String(model || '').trim()}`;
  const cacheNow = Date.now();
  if (_fallbackQuotaStatusCache.key === cacheKey && cacheNow - _fallbackQuotaStatusCache.at < GATEWAY_QUOTA_STATUS_CACHE_MS) {
    return _fallbackQuotaStatusCache.value;
  }
  // Stale-while-revalidate: serve last cached value for this render call
  // (same provider+model only — a route switch must not leak the previous
  // route's balance/spend), refresh (sync snapshot reads included) off the
  // render call stack.
  if (!_fallbackQuotaRefreshInFlight) {
    _fallbackQuotaRefreshInFlight = true;
    setImmediate(() => {
      const routeInfo = {
        provider: normalizedProvider,
        model: String(model || '').trim(),
        providerKind: providerKindForQuota(normalizedProvider),
      };
      let value = null;
      try {
        let usageSnapshot = null;
        if (normalizedProvider === 'opencode-go') {
          usageSnapshot = readCachedOpenCodeGoUsageSnapshot();
        } else if (normalizedProvider.includes('oauth')) {
          try {
            usageSnapshot = readCachedOAuthUsageSnapshot(routeInfo, { allowStale: true });
          } catch {}
        }
        if (normalizedProvider === 'opencode-go' && !usageSnapshot) {
          value = null;
        } else {
          // Boot guard: do not render previous-launch usage before the current
          // runtime has captured at least one snapshot. Once captured in this
          // process, keep it visible while idle even if refreshes are delayed.
          if (usageSnapshot) {
            const cachedAt = num(usageSnapshot.cachedAt, 0);
            if (!cachedAt || cachedAt < STATUSLINE_PROCESS_STARTED_AT_MS) {
              usageSnapshot = { ...usageSnapshot, quotaWindows: [] };
            }
          }
          const limits = buildGatewayLimits(routeInfo, null, usageSnapshot);
          if (limits?.quotaWindows?.length || limits?.balance || limits?.routeSpend) {
            value = {
              ...routeInfo,
              quotaWindows: limits.quotaWindows || [],
              balance: limits.balance || null,
              routeSpend: limits.routeSpend || null,
            };
          }
        }
      } catch {
        value = null;
      }
      _fallbackQuotaStatusCache = { key: cacheKey, at: Date.now(), value };
      _fallbackQuotaRefreshInFlight = false;
    });
  }
  return _fallbackQuotaStatusCache.key === cacheKey ? _fallbackQuotaStatusCache.value : null;
}

function providerKindForQuota(provider) {
  const p = String(provider || '').toLowerCase();
  if (p === 'opencode-go') return 'quota-api';
  if (p.includes('oauth')) return 'oauth';
  if (p === 'ollama' || p === 'lmstudio') return 'local';
  return 'api';
}

function mergeQuotaStatus(primary, fallback) {
  if (!primary) return fallback || null;
  if (!fallback) return primary;
  return {
    ...fallback,
    ...primary,
    quotaWindows: Array.isArray(primary.quotaWindows) && primary.quotaWindows.length
      ? primary.quotaWindows
      : (fallback.quotaWindows || []),
    balance: primary.balance || fallback.balance || null,
    routeSpend: primary.routeSpend || fallback.routeSpend || null,
    providerKind: primary.providerKind || fallback.providerKind || providerKindForQuota(primary.provider || fallback.provider),
  };
}

/** Minimal one-line footer used when the vendored renderer is unavailable. */
export function fallbackStatusline({
  provider = '', model = '', effort = '', fast = false, cwd = '', stats, contextWindow = 0,
  displayContextWindow = 0, rawContextWindow = 0, compactBoundaryTokens = 0, autoCompactTokenLimit = 0,
} = {}) {
  return fallbackLine({
    provider, model, effort, fast, cwd, stats, contextWindow, displayContextWindow,
    rawContextWindow, compactBoundaryTokens, autoCompactTokenLimit,
  });
}

function fallbackLine({
  provider = '', model = '', effort = '', fast = false, cwd = '', stats, contextWindow = 0,
  displayContextWindow = 0, rawContextWindow = 0, compactBoundaryTokens = 0, autoCompactTokenLimit = 0,
} = {}) {
  const s = stats || createSessionStats();
  const cols = terminalColumns();
  const ctxPct = resolveContextUsedPct({
    provider,
    model,
    stats: s,
    contextWindow,
    displayContextWindow,
    rawContextWindow,
    compactBoundaryTokens,
    autoCompactTokenLimit,
    gatewayStatus: null,
  });
  const sep = ` ${D}│${R} `;
  const parts = [
    formatModelSegment({ provider, model, effort, fast, cols }),
    formatContextSegment(ctxPct, cols),
  ].filter(Boolean);
  if (!parts.length) return statusSubtle('> mixdog');
  return parts.join(sep);
}
