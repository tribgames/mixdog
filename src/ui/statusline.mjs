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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bold, colorEnabled, rgb } from './ansi.mjs';
import { displayModelName, shortenModelName } from './model-display.mjs';
import { createSessionStats } from './session-stats.mjs';
import { forEachSessionRuntime } from '../runtime/agent/orchestrator/session/manager.mjs';
import { listHiddenAgentNames } from '../runtime/agent/orchestrator/internal-agents.mjs';
import { getModelMetadataSync } from '../runtime/agent/orchestrator/providers/model-catalog.mjs';
import { readCachedOAuthUsageSnapshot } from '../runtime/agent/orchestrator/providers/oauth-usage.mjs';
import { readCachedOpenCodeGoUsageSnapshot } from '../runtime/agent/orchestrator/providers/opencode-go-usage.mjs';
import { buildGatewayLimits } from '../runtime/agent/orchestrator/providers/statusline-route-meta.mjs';
import { compactBoundaryForStatus, formatGatewayLimitSegments, loadGatewayStatus } from '../vendor/statusline/bin/statusline-route.mjs';
export { createSessionStats, applyUsageDelta } from './session-stats.mjs';

// Token window used to compute a fallback context% from our own session usage.
// The live gateway (when up) overrides this with the real route's window. This
// is only the last resort for unknown local models.
const FALLBACK_CONTEXT_WINDOW = 200000;
const statusText = rgb(198, 198, 198);
const statusSubtle = rgb(136, 136, 136);
const statusAccent = rgb(215, 119, 87);
const DEFAULT_MIXDOG_HOME = process.env.MIXDOG_HOME || join(homedir(), '.mixdog');
const DEFAULT_STANDALONE_DATA_DIR = join(DEFAULT_MIXDOG_HOME, 'data');

function sgr(code) {
  return colorEnabled() ? `\x1b[${code}m` : '';
}

const R = sgr('0');
const B = sgr('1');
const D = sgr('38;2;136;136;136');
const GRN = sgr('38;2;0;170;75');
const YLW = sgr('38;2;255;193;7');
const RED = sgr('38;2;220;70;88');
const CYN = sgr('38;2;136;136;136');
const GREY = sgr('38;2;136;136;136');
const SHELL_JOBS_SEGMENT_CACHE_MS = 1000;
const GATEWAY_QUOTA_STATUS_CACHE_MS = 500;
const WORKER_SPINNER_FRAMES = Object.freeze(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);
const WORKER_SPINNER_FRAME_MS = 160;
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
const DEFAULT_HIDDEN_STATUSLINE_AGENTS = Object.freeze(['explorer', 'cycle1-agent', 'cycle2-agent', 'cycle3-agent', 'scheduler-task', 'webhook-handler']);
let _shellJobsSegmentCache = { ownerPid: 0, at: 0, value: { count: 0, elapsedLabel: '' } };
let _gatewayQuotaStatusCache = { key: '', at: 0, value: null };
let _fallbackQuotaStatusCache = { key: '', at: 0, value: null };
let _hiddenStatuslineAgents = null;
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

function isConfirmedCurrentProcessSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const cachedAt = num(snapshot.cachedAt);
  return cachedAt > 0 && cachedAt >= STATUSLINE_PROCESS_STARTED_AT_MS;
}

function summarizeWorkerTags(workers, limit = 3) {
  const cleanLabels = [...new Set((Array.isArray(workers) ? workers : [])
    .map((worker) => String(worker?.tag || '').trim())
    .filter(Boolean))];
  if (cleanLabels.length <= limit) return cleanLabels.join(', ');
  return `${cleanLabels.slice(0, limit).join(', ')}, +${cleanLabels.length - limit}`;
}

function workerSpinnerFrame(now = Date.now()) {
  const index = Math.floor(now / WORKER_SPINNER_FRAME_MS) % WORKER_SPINNER_FRAMES.length;
  return WORKER_SPINNER_FRAMES[index] || WORKER_SPINNER_FRAMES[0];
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
function providerInputExcludesCache(provider) {
  return String(provider || '').toLowerCase().includes('anthropic');
}

function promptFootprintTokens(provider, stats) {
  const s = stats || createSessionStats();
  const explicit = num(s.promptTokens);
  if (explicit > 0) return explicit;
  const input = num(s.inputTokens);
  if (providerInputExcludesCache(provider)) {
    return input + num(s.cachedTokens) + num(s.cacheWriteTokens);
  }
  return input;
}

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

function currentContextTokens(provider, stats) {
  return activeContextNumerator(provider, stats);
}

function modelContextWindow(provider, model, explicitContextWindow = 0) {
  const explicit = num(explicitContextWindow);
  if (explicit > 0) return explicit;
  const metaWindow = num(getModelMetadataSync(model, provider)?.contextWindow);
  if (metaWindow > 0) return metaWindow;
  return FALLBACK_CONTEXT_WINDOW;
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

function normalizeAgentWorkerForStatusline(worker = {}) {
  const tag = String(worker.tag || worker.agent || worker.name || '').trim();
  if (!tag) return null;
  const statusText = String(worker.stage || worker.status || '').toLowerCase();
  const status = isTerminalBridgeStatus(statusText) ? 'idle' : 'running';
  return {
    tag,
    status,
    startedAtMs: timeMs(worker.startedAt || worker.startTime || worker.createdAt),
    agent: worker.agent || null,
    stage: worker.stage || worker.status || null,
    sessionId: worker.sessionId || null,
    provider: worker.provider || null,
    model: worker.model || null,
  };
}

function normalizeAgentJobForStatusline(job = {}) {
  const statusText = String(job.status || job.stage || '').toLowerCase();
  if (!statusText) return null;
  const taskId = String(job.task_id || job.taskId || '').trim();
  const tag = String(job.tag || job.agent || job.type || taskId || '').trim();
  if (!tag && !taskId) return null;
  const startedAtMs = timeMs(job.startedAt);
  const finishedAtMs = timeMs(job.finishedAt);
  if (isTerminalBridgeStatus(statusText) && finishedAtMs > 0) {
    return {
      tag,
      taskId,
      status: 'finished',
      finalStatus: statusText,
      startedAtMs,
      finishedAtMs,
      agent: job.agent || null,
      stage: job.stage || job.workerStatus || job.status || null,
      sessionId: job.sessionId || null,
      provider: job.provider || null,
      model: job.model || null,
    };
  }
  if (!/running/.test(statusText)) return null;
  return {
    tag,
    taskId,
    status: 'running',
    startedAtMs,
    agent: job.agent || null,
    stage: job.stage || job.workerStatus || job.status || null,
    sessionId: job.sessionId || null,
    provider: job.provider || null,
    model: job.model || null,
  };
}

function agentStatuslinePayload(agentWorkers = [], agentJobs = []) {
  const byTag = new Map();
  const finishedJobs = [];
  for (const worker of Array.isArray(agentWorkers) ? agentWorkers : []) {
    const row = normalizeAgentWorkerForStatusline(worker);
    if (row) byTag.set(row.tag, row);
  }
  for (const job of Array.isArray(agentJobs) ? agentJobs : []) {
    const row = normalizeAgentJobForStatusline(job);
    if (!row) continue;
    if (row.status === 'finished') {
      finishedJobs.push(row);
      continue;
    }
    const prev = byTag.get(row.tag);
    byTag.set(row.tag, { ...(prev || {}), ...row, status: 'running' });
  }
  const workers = [...byTag.values()];
  return {
    workers,
    finishedJobs: finishedJobs.sort((a, b) => (b.finishedAtMs || 0) - (a.finishedAtMs || 0)),
    sessions: {
      roles: workers.filter((w) => w.status !== 'idle').map((w) => w.tag),
      workers,
    },
  };
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
  const quotaSegments = quotaStatus
    ? formatGatewayLimitSegments(quotaStatus, { COLS: cols, D, R, GRN, YLW, RED, colourPct, epochMsToHHMM })
    : [];
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
  const l1 = l1Parts.join(sep) || 'mixdog';
  const l2 = l2Parts.join(sep);
  return l2 ? `${l1}\n${l2}` : l1;
}

function terminalColumns() {
  const cols = Number(process.stdout?.columns);
  return Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : 120;
}

function dataDir() {
  return process.env.MIXDOG_DATA_DIR || DEFAULT_STANDALONE_DATA_DIR;
}

function loadGatewayQuotaStatus({
  provider, model, effort, fast, contextWindow, rawContextWindow, autoCompactTokenLimit = 0,
  sessionId, activeContextTokens, clientHostPid,
} = {}) {
  const key = [
    String(provider || ''),
    String(model || ''),
    String(effort || ''),
    fast === true ? 'fast' : '',
    String(sessionId || ''),
    String(clientHostPid || ''),
    Math.floor((Number(activeContextTokens) || 0) / 1024),
  ].join('\0');
  const now = Date.now();
  if (_gatewayQuotaStatusCache.key === key && now - _gatewayQuotaStatusCache.at < GATEWAY_QUOTA_STATUS_CACHE_MS) {
    return _gatewayQuotaStatusCache.value;
  }
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
    if (!status) {
      _gatewayQuotaStatusCache = { key, at: now, value };
      return value;
    }
    const statusProvider = String(status.provider || '').trim();
    const cliProvider = String(provider || '').trim();
    if (cliProvider && statusProvider && statusProvider !== cliProvider) {
      _gatewayQuotaStatusCache = { key, at: now, value };
      return value;
    }
    const statusModel = String(status.model || '').trim();
    const cliModel = String(model || '').trim();
    if (cliModel && statusModel && statusModel !== cliModel) {
      _gatewayQuotaStatusCache = { key, at: now, value };
      return value;
    }
    value = status;
  } catch {
    value = null;
  }
  _gatewayQuotaStatusCache = { key, at: now, value };
  return value;
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
  let snapshot = null;
  try {
    snapshot = readCachedOAuthUsageSnapshot({
      provider: normalizedProvider,
      model: String(model || '').trim(),
      providerKind: providerKindForQuota(normalizedProvider),
    }, { allowStale: true });
  } catch {
    snapshot = null;
  }
  if (isConfirmedCurrentProcessSnapshot(snapshot)) {
    _oauthUsageArmedProviders.add(normalizedProvider);
    return true;
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
  const routeInfo = {
    provider: normalizedProvider,
    model: String(model || '').trim(),
    providerKind: providerKindForQuota(normalizedProvider),
  };
  let usageSnapshot = null;
  if (normalizedProvider === 'opencode-go') {
    usageSnapshot = readCachedOpenCodeGoUsageSnapshot();
    if (!usageSnapshot) {
      _fallbackQuotaStatusCache = { key: cacheKey, at: cacheNow, value: null };
      return null;
    }
  } else if (normalizedProvider.includes('oauth')) {
    try {
      usageSnapshot = readCachedOAuthUsageSnapshot(routeInfo, { allowStale: true });
    } catch {}
  }
  // Boot guard: do not render previous-launch usage before the current runtime
  // has captured at least one snapshot. Once a snapshot is captured in this
  // process, keep it visible while idle even if refreshes are delayed.
  if (usageSnapshot) {
    const cachedAt = num(usageSnapshot.cachedAt, 0);
    if (!cachedAt || cachedAt < STATUSLINE_PROCESS_STARTED_AT_MS) {
      usageSnapshot = { ...usageSnapshot, quotaWindows: [] };
    }
  }
  try {
    const limits = buildGatewayLimits(routeInfo, null, usageSnapshot);
    if (!limits?.quotaWindows?.length && !limits?.balance && !limits?.routeSpend) {
      _fallbackQuotaStatusCache = { key: cacheKey, at: cacheNow, value: null };
      return null;
    }
    const value = {
      ...routeInfo,
      quotaWindows: limits.quotaWindows || [],
      balance: limits.balance || null,
      routeSpend: limits.routeSpend || null,
    };
    _fallbackQuotaStatusCache = { key: cacheKey, at: cacheNow, value };
    return value;
  } catch {
    _fallbackQuotaStatusCache = { key: cacheKey, at: cacheNow, value: null };
    return null;
  }
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

function formatModelSegment({ provider, model, effort, fast, cols }) {
  const raw = String(model || '').trim();
  const meta = getModelMetadataSync(raw, provider) || {};
  const displayHint = String(meta.displayName || meta.display || meta.name || '').trim();
  const modelName = shortenModelName(displayModelName(raw, provider, displayHint), cols);
  const bits = [`${B}${modelName}${R}`];
  if (effort) bits.push(`${B}${String(effort).toUpperCase()}${R}`);
  if (fast === true) bits.push(`${B}FAST${R}`);
  return bits.join(` ${D}·${R} `);
}

/** Display label for context % (clamped to 100); raw pct still drives bar/color thresholds. */
export function contextPctDisplayLabel(ctxPct) {
  const pct = Number(ctxPct);
  if (!Number.isFinite(pct) || pct <= 0) return '0';
  if (pct > 0 && pct < 1) return String(Math.round(pct * 10) / 10);
  return String(Math.floor(Math.min(100, pct)));
}

function formatContextSegment(ctxPct, cols) {
  const raw = Number(ctxPct);
  const pct = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  const barPct = clampPct(pct);
  const fill = pct >= 90 ? RED : pct >= 70 ? YLW : GRN;
  const label = contextPctDisplayLabel(pct);
  // Keep a full-width bar wherever there is room for one. Below 80 cols the bar
  // is dropped (label-only) so the footer never overflows a narrow terminal;
  // at 80+ it stays a fixed 14 cells instead of shrinking to 8, which read as
  // too small/cramped on mid-width terminals.
  const cells = cols >= 80 ? 14 : 0;
  if (!cells) return `${fill}${label}%${R}`;
  const bar = makeBar(barPct, cells);
  const filled = bar.replace(/░/g, '');
  const empty = bar.replace(/▓/g, '');
  return `${fill}${filled}${R}${D}${empty}${R} ${label}%`;
}

function makeBar(pct, cells) {
  let filled = Math.floor((Number(pct) || 0) * cells / 100);
  if (filled < 0) filled = 0;
  if (filled > cells) filled = cells;
  if (pct >= 1 && filled === 0) filled = 1;
  return '▓'.repeat(filled) + '░'.repeat(cells - filled);
}

function colourPct(p) {
  if (p >= 90) return `${RED}${p}%${R}`;
  if (p >= 70) return `${YLW}${p}%${R}`;
  return `${GRN}${p}%${R}`;
}

function epochMsToHHMM(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function classifyAgentWorkers(workers = []) {
  const maintenance = [];
  const runningWorkers = [];
  const seenMaintenance = new Set();
  const seenRunning = new Set();
  for (const w of Array.isArray(workers) ? workers : []) {
    const tag = String(w?.tag || '').trim();
    if (!tag) continue;
    const maint = hiddenWorkerLabel(w);
    if (maint) {
      if (w.status !== 'idle' && !seenMaintenance.has(maint)) {
        seenMaintenance.add(maint);
        maintenance.push(`${GRN}↻${R} ${B}${maint}${R}`);
      }
      continue;
    }
    if (w.status !== 'idle' && !seenRunning.has(tag)) {
      seenRunning.add(tag);
      runningWorkers.push(w);
    }
  }
  return { maintenance, runningWorkers };
}

function hiddenWorkerLabel(worker = {}) {
  const agent = String(worker?.agent || '').trim();
  const tag = String(worker?.tag || '').trim();
  return maintenanceLabel(agent) || (!agent ? maintenanceLabel(tag) : '');
}

function hiddenStatuslineAgents() {
  if (_hiddenStatuslineAgents) return _hiddenStatuslineAgents;
  const agents = new Set(DEFAULT_HIDDEN_STATUSLINE_AGENTS);
  try {
    for (const agent of listHiddenAgentNames()) {
      const clean = String(agent || '').trim();
      if (clean) agents.add(clean);
    }
  } catch {}
  _hiddenStatuslineAgents = agents;
  return agents;
}

function isActiveHiddenStatus(statusText) {
  return /^(connecting|requesting|streaming|tool_running|running)$/i.test(String(statusText || '').trim());
}

function activeHiddenAgentWorkers({ sessionId = '', clientHostPid = 0 } = {}) {
  const agents = hiddenStatuslineAgents();
  const ownerPid = positiveInt(clientHostPid);
  const ownerSessionId = String(sessionId || '').trim();
  const rows = [];
  try {
    for (const [runtimeSessionId, entry] of forEachSessionRuntime() || []) {
      if (!entry || entry.closed === true) continue;
      const session = entry.session || null;
      if (!session || session.closed === true) continue;
      const agent = String(session?.agent || '').trim();
      if (!agent || !agents.has(agent)) continue;
      const id = session?.id || runtimeSessionId || null;
      if (ownerSessionId && id === ownerSessionId) continue;
      const sessionOwnerId = String(session?.ownerSessionId || '').trim();
      if (sessionOwnerId && ownerSessionId && sessionOwnerId !== ownerSessionId) continue;
      const pid = positiveInt(session?.clientHostPid);
      if (ownerPid && pid && pid !== ownerPid) continue;
      const stage = String(entry.stage || session?.stage || session?.status || '').trim().toLowerCase();
      const status = String(session?.status || stage || '').trim().toLowerCase();
      if (!isActiveHiddenStatus(stage || status)) continue;
      rows.push({
        tag: String(session?.agentTag || `${agent}:${id || rows.length}`).trim(),
        agent,
        status: 'running',
        stage: stage || status || 'running',
        sessionId: id,
        provider: session?.provider || null,
        model: session?.model || null,
      });
    }
  } catch {}
  return rows;
}

function isTerminalBridgeStatus(statusText) {
  return /idle|done|complete|success|closed|error|fail|cancel|killed|timeout/.test(String(statusText || '').toLowerCase());
}

function timeMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  const n = Date.parse(String(value || ''));
  return Number.isFinite(n) ? n : 0;
}

function maintenanceLabel(tag) {
  switch (tag) {
    case 'cycle1-agent': return 'cycle1';
    case 'cycle2-agent': return 'cycle2';
    case 'cycle3-agent': return 'cycle3';
    case 'scheduler-task': return 'scheduler';
    case 'webhook-handler': return 'webhook';
    case 'explorer': return 'explorer';
    default: return '';
  }
}

function shellJobsStatus({ clientHostPid } = {}) {
  const ownerPid = positiveInt(clientHostPid);
  const empty = { count: 0, elapsedLabel: '' };
  if (!ownerPid) return empty;
  const now = Date.now();
  if (_shellJobsSegmentCache.ownerPid === ownerPid && now - _shellJobsSegmentCache.at < SHELL_JOBS_SEGMENT_CACHE_MS) {
    return _shellJobsSegmentCache.value || empty;
  }
  let value = empty;
  try {
    const dir = join(dataDir(), 'shell-jobs');
    if (!existsSync(dir)) {
      _shellJobsSegmentCache = { ownerPid, at: now, value };
      return value;
    }
    const names = readdirSync(dir);
    const done = new Set(names.filter((n) => n.endsWith('.done')).map((n) => n.slice(0, -5)));
    const ownerByJob = new Map();
    for (const n of names) {
      const i = n.lastIndexOf('.owner-');
      if (i > 0) {
        const pid = positiveInt(n.slice(i + 7));
        if (pid) ownerByJob.set(n.slice(0, i), pid);
      }
    }
    const ids = names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -5))
      .filter((id) => !done.has(id) && ownerByJob.get(id) === ownerPid)
      .sort((a, b) => jobStampMs(b) - jobStampMs(a))
      .slice(0, 30);
    let count = 0;
    let oldestMs = Infinity;
    for (const id of ids) {
      const p = join(dir, `${id}.json`);
      let detail;
      try { detail = JSON.parse(readFileSync(p, 'utf-8')); } catch { continue; }
      if (!isShellJobAlive(detail, p, dir, id)) continue;
      count++;
      try {
        const st = statSync(p);
        if (st.mtimeMs < oldestMs) oldestMs = st.mtimeMs;
      } catch {}
    }
    if (!count) {
      _shellJobsSegmentCache = { ownerPid, at: now, value };
      return value;
    }
    const elapsedLabel = Number.isFinite(oldestMs) ? formatElapsed(Date.now() - oldestMs) : '';
    value = { count, elapsedLabel };
  } catch {
    value = empty;
  }
  _shellJobsSegmentCache = { ownerPid, at: now, value };
  return value;
}

function isShellJobAlive(detail, detailPath, dir, id) {
  const pid = positiveInt(detail?.pid);
  if (!pid) return false;
  try {
    const st = statSync(detailPath);
    const timeoutMs = Number(detail?.timeoutMs);
    const enforced = detail?.timeoutEnforced === true || existsSync(join(dir, `${id}.enforced`));
    if (enforced && Number.isFinite(timeoutMs) && timeoutMs > 0 && Date.now() - st.mtimeMs > timeoutMs + 30 * 60_000) {
      return false;
    }
  } catch {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

function jobStampMs(id) {
  const m = /^job_(\d+)/.exec(String(id || ''));
  return m ? Number(m[1]) : 0;
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

// Byte-identical replica of src/tui/time-format.mjs formatDuration() with
// DEFAULT options (no mostSignificantOnly / hideTrailingZeros), wrapped to drop
// sub-1s like formatElapsed there. Output shape: '' (<1s), `Xs`, `Xm Ys`,
// `Xh Ym Zs`, `Xd Yh Zm`. statusline.mjs is a standalone UI module that should
// not depend on the React/ink TUI tree, so the algorithm is replicated rather
// than imported. Used for ALL L2 elapsed (Agents/Explore/Search/Shell).
function formatElapsed(ms) {
  if (!Number.isFinite(Number(ms))) return '';
  const value = Math.max(0, Number(ms) || 0);
  if (value < 60_000) {
    if (value < 1_000) return '';
    return `${Math.floor(value / 1000)}s`;
  }
  const days = Math.floor(value / 86_400_000);
  const hours = Math.floor((value % 86_400_000) / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
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

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clampPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/** Human-friendly token count: 1234 -> 1.2k. */
function fmt(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(Math.round(v));
  if (v < 1_000_000) {
    const k = Math.round(v / 1000);
    return k >= 1000 ? '1M' : `${k}k`;
  }
  return (v / 1_000_000).toFixed(1) + 'M';
}
