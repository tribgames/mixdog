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
import { formatGatewayLimitSegments, loadGatewayStatus } from '../vendor/statusline/bin/statusline-route.mjs';
import { createSessionStats } from './session-stats.mjs';
import { measuredContextUsage } from './context-measurement.mjs';
import {
  statusSubtle,
  R,
  B,
  D,
  GRN,
  YLW,
  RED,
  terminalColumns,
  formatModelSegment,
  formatContextSegment,
  colourPct,
  epochMsToHHMM,
  num,
  formatElapsed,
} from './statusline-format.mjs';
import { shellJobsStatus, memoryCycleStatus } from './statusline-segments.mjs';
import {
  agentStatuslinePayload,
  classifyAgentWorkers,
  activeHiddenAgentWorkers,
  agentWebSearchStatus,
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
    String(provider || '')
      .trim()
      .toLowerCase(),
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

// Monotonic hysteresis for the quota/usage segment. Once a value has rendered
// (held), a new non-empty result replaces it ONLY when it is at least as fresh
// or is confirmed own-instance live data. This stops the 5H/7D values flapping
// when another mixdog instance overwrites the shared active-instance/usage cache
// with an OLDER snapshot: metricsMatch flips false, the source alternates to a
// provider-wide cache snapshot captured at a different time, and without this
// gate the two sources would oscillate tick-to-tick.
//   - nothing displayed yet .................. accept
//   - incoming is own-instance live data ..... accept (always wins)
//   - either side lacks a comparable asOf .... accept (preserves prior behavior)
//   - displayed value is own live data ....... accept only a STRICTLY newer snapshot
//   - both shared-cache snapshots ............ accept same-or-newer asOf
function acceptQuotaSnapshot(held, incoming) {
  if (!held) return true;
  if (incoming?.owned) return true;
  const incomingAsOf = num(incoming?.asOf);
  const heldAsOf = num(held.asOf);
  if (!incomingAsOf || !heldAsOf) return true;
  if (held.owned) return incomingAsOf > heldAsOf;
  return incomingAsOf >= heldAsOf;
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

function activeContextNumerator(_provider, stats) {
  return measuredContextUsage({ stats }).used;
}

export function resolveContextUsedPct({
  provider: _provider = '',
  model: _model = '',
  stats = null,
  contextWindow = 0,
  displayContextWindow = 0,
  rawContextWindow = 0,
  compactBoundaryTokens: _compactBoundaryTokens = 0,
  autoCompactTokenLimit: _autoCompactTokenLimit = 0,
  gatewayStatus: _gatewayStatus = null,
} = {}) {
  return measuredContextUsage({ stats, contextWindow, displayContextWindow, rawContextWindow }).percent;
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
  provider = '',
  model = '',
  effort = '',
  fast = false,
  cwd = '',
  stats,
  sessionId,
  contextWindow = 0,
  displayContextWindow = 0,
  rawContextWindow = 0,
  compactBoundaryTokens = 0,
  autoCompactTokenLimit = 0,
  agentWorkers = [],
  agentJobs = [],
  activeTools = null,
  clientHostPid = process.pid,
} = {}) {
  const displayArgs = {
    contextWindow,
    displayContextWindow,
    rawContextWindow,
    compactBoundaryTokens,
    autoCompactTokenLimit,
  };
  try {
    return renderNativeStatusline({
      provider,
      model,
      effort,
      fast,
      cwd,
      stats,
      sessionId,
      agentWorkers,
      agentJobs,
      activeTools,
      clientHostPid,
      ...displayArgs,
    });
  } catch {
    return fallbackLine({ provider, model, effort, fast, cwd, stats, ...displayArgs });
  }
}

// --- helpers -----------------------------------------------------------------

function renderNativeStatusline({
  provider = '',
  model = '',
  effort = '',
  fast = false,
  stats,
  sessionId,
  contextWindow = 0,
  displayContextWindow = 0,
  rawContextWindow = 0,
  compactBoundaryTokens = 0,
  autoCompactTokenLimit = 0,
  agentWorkers = [],
  agentJobs = [],
  activeTools = null,
  clientHostPid = process.pid,
} = {}) {
  const cols = terminalColumns();
  const s = stats || createSessionStats();
  const { gatewayStatus, ctxPct } = statuslineContext({
    provider,
    model,
    effort,
    fast,
    stats: s,
    sessionId,
    contextWindow,
    displayContextWindow,
    rawContextWindow,
    compactBoundaryTokens,
    autoCompactTokenLimit,
    clientHostPid,
  });

  const sep = ` ${D}│${R} `;
  const l1Parts = [
    formatModelSegment({ provider, model, effort, fast, cols }),
    formatContextSegment(ctxPct, cols, s.currentContextSource),
    ...quotaSegmentsFor({ provider, model, effort, fast, sessionId, clientHostPid, gatewayStatus, cols }),
  ].filter(Boolean);
  const l2Parts = activitySegments({ sessionId, clientHostPid, agentWorkers, agentJobs, activeTools });
  const l1 = l1Parts.join(sep) || 'mixdog';
  const l2 = l2Parts.join(sep);
  return l2 ? `${l1}\n${l2}` : l1;
}

// Option A boot gate: for OAuth routes, render NOTHING for the usage/quota
// segment until this process has captured its first confirmed (current-
// process) OAuth usage snapshot. This suppresses the startup jitter where the
// gateway active-instance quota windows (not process-start guarded) and the
// boot-guarded OAuth cache windows would otherwise pop in/merge at different
// ticks. Model + context% always render. Non-OAuth routes are unaffected.
// Once armed, the latch holds for the process lifetime so the segment turns
// on exactly once and then holds the last known value as today.
function quotaSegmentsFor({ provider, model, effort, fast, sessionId, clientHostPid, gatewayStatus, cols }) {
  const usageReady = oauthUsageSegmentReady({ provider, model });
  const quotaStatus = usageReady ? mergeQuotaStatus(gatewayStatus, fallbackQuotaStatus({ provider, model })) : null;
  const quotaSegments = quotaStatus
    ? formatGatewayLimitSegments(quotaStatus, { COLS: cols, D, R, GRN, YLW, RED, colourPct, epochMsToHHMM })
    : [];
  // Only apply the hold to providers that actually armed the OAuth boot latch.
  // oauthUsageSegmentReady() also returns true for non-OAuth providers (they
  // are never gated), so gate the hold itself on _oauthUsageArmedProviders to
  // keep non-OAuth empty/null behavior byte-for-byte unchanged.
  const normalizedHoldProvider = String(provider || '')
    .trim()
    .toLowerCase();
  if (!usageReady || !_oauthUsageArmedProviders.has(normalizedHoldProvider)) return quotaSegments;
  const holdKey = quotaSegmentsHoldKey({ provider, model, effort, fast, sessionId, clientHostPid });
  const held = _lastNonEmptyQuotaSegmentsByKey.get(holdKey);
  if (!quotaSegments.length) return held?.segments?.length ? held.segments : quotaSegments;
  // Monotonic replace: keep the currently displayed value unless the new
  // one is same-or-newer, or is confirmed own-instance live data.
  const incoming = {
    asOf: num(quotaStatus?.quotaWindowsAsOf),
    owned: quotaStatus?.quotaWindowsOwned === true,
  };
  if (acceptQuotaSnapshot(held, incoming)) {
    rememberNonEmptyQuotaSegments(holdKey, { segments: quotaSegments, asOf: incoming.asOf, owned: incoming.owned });
    return quotaSegments;
  }
  return held?.segments?.length ? held.segments : quotaSegments;
}

// Gateway quota for the current route (cached, refreshed off the render tick)
// and the context percentage it feeds into.
function statuslineContext({
  provider,
  model,
  effort,
  fast,
  stats,
  sessionId,
  contextWindow,
  displayContextWindow,
  rawContextWindow,
  compactBoundaryTokens,
  autoCompactTokenLimit,
  clientHostPid,
}) {
  const contextTokens = activeContextNumerator(provider, stats);
  const routeContextWindow = num(displayContextWindow) > 0 ? num(displayContextWindow) : num(contextWindow);
  const gatewayStatus = loadGatewayQuotaStatus({
    provider,
    model,
    effort,
    fast,
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
    stats,
    contextWindow,
    displayContextWindow,
    rawContextWindow,
    compactBoundaryTokens,
    autoCompactTokenLimit,
    gatewayStatus,
  });
  return { gatewayStatus, ctxPct };
}

// Second statusline row. Segment order: Running Agents → Running Shells →
// Web Searching → Memory. (activeTools.web_search counts WEB searches —
// category 'Web Research' — not local file search, which is intentionally
// not surfaced.)
function activitySegments({ sessionId, clientHostPid, agentWorkers, agentJobs, activeTools }) {
  const agentPayload = agentStatuslinePayload(
    [...(Array.isArray(agentWorkers) ? agentWorkers : []), ...activeHiddenAgentWorkers({ sessionId, clientHostPid })],
    agentJobs
  );
  const { runningWorkers } = classifyAgentWorkers(agentPayload.workers);
  // Shell segment scope: one host process can own MANY sessions' jobs (the
  // desktop pools every pane's engine; the daemon hosts every
  // terminal's session), so the owner-wide aggregate would show one
  // terminal's running shell on every other terminal. Render this session's
  // own jobs whenever we know which session we are; only a session-less
  // caller (plain statusline shim) keeps the process aggregate.
  const shellScope = String(sessionId ?? '').trim();
  const shellStatus = shellScope
    ? shellJobsStatus({ clientHostPid, sessionId: shellScope })
    : shellJobsStatus({ clientHostPid });

  const parts = [];
  const spin = `${GRN}${l2SpinnerFrame(Date.now())}${R}`;
  const elapsedSuffix = (label) => (label ? ` ${D}·${R} ${label}` : '');
  const segment = (label, elapsed) => parts.push(`${spin} ${B}${label}${R}${elapsedSuffix(elapsed)}`);
  if (runningWorkers.length) {
    const n = runningWorkers.length;
    segment(`Running ${n} Agent${n === 1 ? '' : 's'}`, agentsElapsed(runningWorkers));
  }
  if (shellStatus.count > 0) {
    const n = shellStatus.count;
    segment(`Running ${n} Shell${n === 1 ? '' : 's'}`, shellStatus.elapsedLabel);
  }
  const webSearch = webSearchActivity(activeTools, { sessionId, clientHostPid });
  if (webSearch.count > 0) segment('Web Searching', webSearch.elapsed);
  // Memory cycle segment — single unified "Memory" wording for all states:
  // running -> "⠋ Memory · 12s". Backlog is intentionally NOT rendered
  // (owner preference: cycle-health WARN logs cover it); nothing when idle.
  const memStatus = memoryCycleStatus();
  if (memStatus?.kind === 'running') segment('Memory', formatElapsed(Date.now() - memStatus.startedAt));
  return parts;
}

// Elapsed label from the oldest running worker's start.
function agentsElapsed(runningWorkers) {
  const oldestStart = runningWorkers.reduce((min, w) => {
    const t = num(w?.startedAtMs);
    return t > 0 && t < min ? t : min;
  }, Infinity);
  return Number.isFinite(oldestStart) ? formatElapsed(Date.now() - oldestStart) : '';
}

// Web Searching = lead's own web searches (activeTools.web_search) PLUS any
// spawned agent sub-session whose current tool call is a web search
// (agentWebSearchStatus reads the live session-runtime map). Earliest start
// wins for the elapsed label.
function webSearchActivity(activeTools, { sessionId, clientHostPid }) {
  const tools = activeTools && typeof activeTools === 'object' ? activeTools : {};
  const webSearchInfo = tools.web_search || null;
  const agentSearch = agentWebSearchStatus({ sessionId, clientHostPid });
  const count = (webSearchInfo ? num(webSearchInfo.count) : 0) + num(agentSearch.count);
  const starts = [webSearchInfo ? num(webSearchInfo.startedAt) : 0, num(agentSearch.startedAt)].filter((v) => v > 0);
  const start = starts.length ? Math.min(...starts) : 0;
  return { count, elapsed: start > 0 ? formatElapsed(Date.now() - start) : '' };
}

let _gatewayQuotaRefreshInFlight = false;

function loadGatewayQuotaStatus({
  provider,
  model,
  effort,
  fast,
  contextWindow,
  rawContextWindow,
  autoCompactTokenLimit = 0,
  sessionId,
  activeContextTokens,
  clientHostPid,
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
  const fresh =
    _gatewayQuotaStatusCache.key === key && now - _gatewayQuotaStatusCache.at < GATEWAY_QUOTA_STATUS_CACHE_MS;
  if (fresh) {
    return _gatewayQuotaStatusCache.value;
  }
  // Stale-while-revalidate: serve the last cached value for THIS render call
  // only if it belongs to the SAME route, and kick a background refresh off
  // the render call stack. Guarded so concurrent render ticks never queue
  // more than one refresh at a time.
  if (!_gatewayQuotaRefreshInFlight) {
    _gatewayQuotaRefreshInFlight = true;
    setImmediate(() =>
      refreshGatewayQuotaStatus(
        { key, routeKey },
        {
          sessionId,
          activeContextTokens,
          clientHostPid,
          currentRoute: { provider, model, effort, fast, contextWindow, rawContextWindow, autoCompactTokenLimit },
        }
      )
    );
  }
  return _gatewayQuotaStatusCache.routeKey === routeKey ? _gatewayQuotaStatusCache.value : null;
}

function refreshGatewayQuotaStatus({ key, routeKey }, request) {
  let value = null;
  try {
    const status = loadGatewayStatus(request);
    if (gatewayStatusMatchesRoute(status, request.currentRoute)) value = status;
  } catch {
    value = null;
  }
  _gatewayQuotaStatusCache = { key, routeKey, at: Date.now(), value };
  _gatewayQuotaRefreshInFlight = false;
}

// A status whose provider or model disagrees with the CLI's route is not this
// route's quota.
function gatewayStatusMatchesRoute(status, { provider, model }) {
  if (!status) return false;
  const statusProvider = String(status.provider || '').trim();
  const cliProvider = String(provider || '').trim();
  const statusModel = String(status.model || '').trim();
  const cliModel = String(model || '').trim();
  return (
    !(cliProvider && statusProvider && statusProvider !== cliProvider) &&
    !(cliModel && statusModel && statusModel !== cliModel)
  );
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
  const normalizedProvider = String(provider || '')
    .trim()
    .toLowerCase();
  if (!normalizedProvider.includes('oauth')) return true;
  if (_oauthUsageArmedProviders.has(normalizedProvider)) return true;
  // Not yet armed: never do the sync snapshot read on this render call. Kick
  // one background check (guarded per-provider) and keep returning false
  // (today's pre-arm behavior) until it flips the latch.
  if (!_oauthArmCheckInFlight.has(normalizedProvider)) {
    _oauthArmCheckInFlight.add(normalizedProvider);
    setImmediate(() => {
      try {
        const snapshot = readCachedOAuthUsageSnapshot(
          {
            provider: normalizedProvider,
            model: String(model || '').trim(),
            providerKind: providerKindForQuota(normalizedProvider),
          },
          { allowStale: true }
        );
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
  const normalizedProvider = String(provider || '')
    .trim()
    .toLowerCase();
  if (!normalizedProvider) return null;
  const cacheKey = `${normalizedProvider}\0${String(model || '').trim()}`;
  const cacheNow = Date.now();
  if (
    _fallbackQuotaStatusCache.key === cacheKey &&
    cacheNow - _fallbackQuotaStatusCache.at < GATEWAY_QUOTA_STATUS_CACHE_MS
  ) {
    return _fallbackQuotaStatusCache.value;
  }
  // Stale-while-revalidate: serve last cached value for this render call
  // (same provider+model only — a route switch must not leak the previous
  // route's balance/spend), refresh (sync snapshot reads included) off the
  // render call stack.
  if (!_fallbackQuotaRefreshInFlight) {
    _fallbackQuotaRefreshInFlight = true;
    setImmediate(() => refreshFallbackQuotaStatus(cacheKey, normalizedProvider, model));
  }
  return _fallbackQuotaStatusCache.key === cacheKey ? _fallbackQuotaStatusCache.value : null;
}

function refreshFallbackQuotaStatus(cacheKey, normalizedProvider, model) {
  const routeInfo = {
    provider: normalizedProvider,
    model: String(model || '').trim(),
    providerKind: providerKindForQuota(normalizedProvider),
  };
  let value = null;
  try {
    value = fallbackQuotaValue(routeInfo, normalizedProvider);
  } catch {
    value = null;
  }
  _fallbackQuotaStatusCache = { key: cacheKey, at: Date.now(), value };
  _fallbackQuotaRefreshInFlight = false;
}

// Quota/balance/spend from the provider's cached usage snapshot, or null when
// the route reports nothing worth a segment.
function fallbackQuotaValue(routeInfo, normalizedProvider) {
  let usageSnapshot = null;
  if (normalizedProvider === 'opencode-go') {
    usageSnapshot = readCachedOpenCodeGoUsageSnapshot();
  } else if (normalizedProvider.includes('oauth')) {
    try {
      usageSnapshot = readCachedOAuthUsageSnapshot(routeInfo, { allowStale: true });
    } catch {}
  }
  if (normalizedProvider === 'opencode-go' && !usageSnapshot) return null;
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
  if (!(limits?.quotaWindows?.length || limits?.balance || limits?.routeSpend)) return null;
  return {
    ...routeInfo,
    quotaWindows: limits.quotaWindows || [],
    // Shared provider-wide OAuth usage cache snapshot: not owned by
    // this instance. asOf = the snapshot's cachedAt for hysteresis.
    quotaWindowsAsOf: num(usageSnapshot?.cachedAt),
    quotaWindowsOwned: false,
    balance: limits.balance || null,
    routeSpend: limits.routeSpend || null,
  };
}

function providerKindForQuota(provider) {
  const p = String(provider || '').toLowerCase();
  if (p === 'opencode-go') return 'quota-api';
  if (p.includes('oauth')) return 'oauth';
  if (p === 'mixdog-local') return 'local';
  return 'api';
}

function mergeQuotaStatus(primary, fallback) {
  if (!primary) return fallback || null;
  if (!fallback) return primary;
  const usePrimaryWindows = Array.isArray(primary.quotaWindows) && primary.quotaWindows.length;
  return {
    ...fallback,
    ...primary,
    quotaWindows: usePrimaryWindows ? primary.quotaWindows : fallback.quotaWindows || [],
    // Keep asOf/owned aligned with whichever windows won, so the hysteresis gate
    // compares against the timestamp of the value actually being rendered.
    quotaWindowsAsOf: usePrimaryWindows ? num(primary.quotaWindowsAsOf) : num(fallback.quotaWindowsAsOf),
    quotaWindowsOwned: usePrimaryWindows ? primary.quotaWindowsOwned === true : fallback.quotaWindowsOwned === true,
    balance: primary.balance || fallback.balance || null,
    routeSpend: primary.routeSpend || fallback.routeSpend || null,
    providerKind:
      primary.providerKind || fallback.providerKind || providerKindForQuota(primary.provider || fallback.provider),
  };
}

function fallbackLine({
  provider = '',
  model = '',
  effort = '',
  fast = false,
  cwd: _cwd = '',
  stats,
  contextWindow = 0,
  displayContextWindow = 0,
  rawContextWindow = 0,
  compactBoundaryTokens = 0,
  autoCompactTokenLimit = 0,
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
    formatContextSegment(ctxPct, cols, s.currentContextSource),
  ].filter(Boolean);
  if (!parts.length) return statusSubtle('> mixdog');
  return parts.join(sep);
}
