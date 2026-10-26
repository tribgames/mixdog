import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync,
  renameSync, statSync, fstatSync,
} from 'fs';
import { appendFile, mkdir, readFile } from 'fs/promises';
import { writeFileAtomicAsync, writeFileAtomicSync } from '../../../../runtime/shared/atomic-file.mjs';
import { dirname, join } from 'path';
import { resolvePluginData } from '../../../../runtime/shared/plugin-paths.mjs';
import { readSection } from '../../../../runtime/shared/config.mjs';
import { withFileLock, withFileLockSync } from '../../../../runtime/shared/file-lock.mjs';
import { computeCostUsd, isInclusiveProvider } from '../../../../runtime/shared/llm/cost.mjs';

// Legacy store: one JSON document rewritten on every flush. Current store: an
// append-only JSONL (one event per line) compacted off the hot path.
const LEGACY_USAGE_FILE = 'gateway-usage.local.json';
const GATEWAY_USAGE_FILE = 'gateway-usage.local.jsonl';
const LEGACY_BACKUP_SUFFIX = '.migrated.bak';
const COMPACT_MIN_BYTES = 8 * 1024 * 1024;
// Background runners push several hundred turns a day through here, so a
// thousand rows covered barely a day of history. The daily rollup carries the
// long range, but the events are what a fresh range request re-reads in full
// detail, and they are also the only record for the day rolling up began.
const MAX_USAGE_EVENTS = 5000;
const USAGE_EVENT_TTL_MS = 35 * 24 * 60 * 60_000;
const USAGE_FLUSH_DELAY_MS = 500;
let routeSectionKey = null;
let routeSectionStartedAt = 0;
let pendingUsageEvents = [];
let usageFlushTimer = null;
// Settles once every async usage flush started so far has landed or failed.
let usageFlushTail = Promise.resolve();

function num(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const scale = 10 ** digits;
  return Math.round(n * scale) / scale;
}

function readJsonFile(file) {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function agentConfigSection() {
  const raw = readSection('agent') || {};
  return raw?.agent?.providers ? raw.agent : raw;
}

function gatewaySection() {
  return readSection('gateway') || {};
}

function providerSection(provider) {
  const agent = agentConfigSection();
  return agent?.providers?.[provider] && typeof agent.providers[provider] === 'object'
    ? agent.providers[provider]
    : {};
}

function cleanString(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || null;
}

function providerKind(provider) {
  const p = String(provider || '').toLowerCase();
  if (!p) return 'unknown';
  if (p.includes('oauth')) return 'oauth';
  if (p === 'mixdog-local') return 'local';
  return 'api';
}

export function defaultEffectiveContextWindowPercent(_provider) {
  // Gateway/statusline reports the full model boundary. Trigger headroom is a
  // Compact policy concern and must not shrink the displayed denominator.
  void _provider;
  return 100;
}

function routeIdentityKey(routeInfo = {}) {
  return [
    routeInfo.provider || '',
    routeInfo.model || '',
    routeInfo.effort || '',
    routeInfo.fast === true ? 'fast' : '',
  ].join('\u0001');
}

function ensureRouteSection(routeInfo = {}) {
  const key = routeIdentityKey(routeInfo);
  if (!key.trim()) return null;
  if (routeSectionKey !== key) {
    routeSectionKey = key;
    routeSectionStartedAt = Date.now();
  }
  return routeSectionStartedAt;
}

function shouldTrackDollarSpend(routeInfo = {}) {
  const kind = routeInfo.providerKind || providerKind(routeInfo.provider);
  return kind === 'api' || kind === 'quota-api';
}

// Boundary denominator for status percentages and usage telemetry.
// Order: explicit boundary (routeInfo or compact) → contextWindow → budgetWindow
// → rawContextWindow. autoCompactTokenLimit / compactLimitTokens are triggers
// only and are never read here.
export function compactBoundaryDenominator(routeInfo = {}, compact = null) {
  const fromRoute = num(
    routeInfo?.compactBoundaryTokens
      ?? routeInfo?.compact_boundary_tokens
      ?? routeInfo?.boundaryTokens,
    0,
  );
  const fromCompact = num(
    compact?.boundaryTokens
      ?? compact?.compactBoundaryTokens
      ?? compact?.compact_boundary_tokens,
    0,
  );
  const boundaryTokens = fromRoute > 0 ? fromRoute : fromCompact;
  const contextWindow = num(routeInfo?.contextWindow ?? compact?.contextWindow, 0);
  const budgetWindow = num(compact?.budgetWindow, 0);
  const rawContextWindow = num(routeInfo?.rawContextWindow ?? compact?.rawContextWindow, 0);
  if (boundaryTokens > 0) return boundaryTokens;
  if (contextWindow > 0) return contextWindow;
  if (budgetWindow > 0) return budgetWindow;
  return rawContextWindow > 0 ? rawContextWindow : 0;
}

function promptFootprintTokens(provider, usage) {
  const input = num(usage?.inputTokens, 0);
  const cacheRead = num(usage?.cachedTokens ?? usage?.cacheReadTokens, 0);
  const cacheWrite = num(usage?.cacheWriteTokens, 0);
  if (num(usage?.promptTokens, 0) > 0) return num(usage.promptTokens, 0);
  return isInclusiveProvider(provider) ? input : input + cacheRead + cacheWrite;
}

function usageCostUsd(routeInfo, providerOut) {
  const usage = providerOut?.usage || {};
  if (Number.isFinite(Number(usage?.costUsd))) return round(Number(usage.costUsd), 6);
  return computeCostUsd({
    provider: routeInfo?.provider,
    model: routeInfo?.model,
    pricingModel: providerOut?.pricingModel,
    kind: routeInfo?.providerKind || providerKind(routeInfo?.provider),
    requestServiceTier: providerOut?.requestServiceTier,
    serviceTier: cleanString(providerOut?.serviceTier) || cleanString(usage?.raw?.service_tier) || undefined,
    inputTokens: num(usage?.inputTokens, 0),
    outputTokens: num(usage?.outputTokens, 0),
    cacheReadTokens: num(usage?.cachedTokens ?? usage?.cacheReadTokens, 0),
    cacheWriteTokens: num(usage?.cacheWriteTokens, 0),
    cacheWrite1hTokens: num(usage?.cacheWrite1hTokens, 0),
  });
}

function contextUsageBoundary(routeInfo, compact = null) {
  return compactBoundaryDenominator(routeInfo, compact);
}

export function summarizeGatewayUsage(routeInfo, providerOut, compact = null, durationMs = null) {
  const u = providerOut?.usage || {};
  const routeSectionStartedAt = ensureRouteSection(routeInfo);
  const promptTokens = promptFootprintTokens(routeInfo?.provider, u);
  const boundaryTokens = contextUsageBoundary(routeInfo, compact);
  // Prefer the transcript-estimate footprint for the displayed pct: it is
  // monotonic and window-bounded, unlike provider input_tokens which can swing
  // wildly (and produce >1000% pct) on some providers (e.g. OpenAI gpt-5.5).
  // compact.afterTokens / beforeTokens = estimateMessagesTokens(working)+reserve.
  const estimateFootprintTokens = num(compact?.afterTokens, 0) || num(compact?.beforeTokens, 0);
  let contextUsedPct = null;
  if (boundaryTokens > 0) {
    if (estimateFootprintTokens > 0) {
      // Estimate-based numerator may legitimately exceed boundary -> real >100%.
      contextUsedPct = round(estimateFootprintTokens * 100 / boundaryTokens, 2);
    } else {
      // Fallback to provider tokens; clamp to a sane ceiling since these are
      // not reliably window-bounded.
      contextUsedPct = Math.min(100, round(promptTokens * 100 / boundaryTokens, 2));
    }
  }
  const costUsd = usageCostUsd(routeInfo, providerOut);
  const usageCompact = compact && typeof compact === 'object' ? { ...compact } : compact;
  return {
    at: Date.now(),
    provider: routeInfo?.provider,
    model: routeInfo?.model,
    providerKind: routeInfo?.providerKind || providerKind(routeInfo?.provider),
    routeKey: routeIdentityKey(routeInfo),
    routeSectionStartedAt,
    responseModel: cleanString(providerOut?.model) || routeInfo?.model || null,
    serviceTier: cleanString(providerOut?.serviceTier) || cleanString(u?.raw?.service_tier) || null,
    inputTokens: num(u.inputTokens, 0),
    outputTokens: num(u.outputTokens, 0),
    cacheReadTokens: num(u.cachedTokens ?? u.cacheReadTokens, 0),
    cacheWriteTokens: num(u.cacheWriteTokens, 0),
    promptTokens,
    costUsd,
    costSource: Number.isFinite(Number(u?.costUsd)) ? 'provider' : costUsd > 0 ? 'catalog' : 'none',
    contextUsedPct,
    compact: usageCompact,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null,
    rawUsageKeys: u?.raw && typeof u.raw === 'object' ? Object.keys(u.raw).sort() : [],
  };
}

function usageStorePath() {
  return join(resolvePluginData(), GATEWAY_USAGE_FILE);
}

function usageLockPath(file) {
  return `${file}.lock`;
}

function parseJsonlEvents(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === 'object') out.push(e);
    } catch {
      // A torn append (crash mid-write) is skipped, never fatal.
    }
  }
  return out;
}

// Idempotent, crash-safe legacy JSON -> JSONL migration, once per path per
// process. Serialized by the store lock; each step is an atomic rename:
//   1. events -> <store>.migrating.<pid>, renamed onto the JSONL store
//   2. legacy file renamed to a backup
// A crash between the steps leaves both files; the next run sees the JSONL
// store already present and only finishes step 2. Appenders always migrate
// first, so an existing JSONL store is never older than the legacy file.
const migratedPaths = new Set();
function ensureUsageStoreMigrated() {
  const store = usageStorePath();
  if (migratedPaths.has(store)) return;
  const legacy = join(dirname(store), LEGACY_USAGE_FILE);
  if (existsSync(legacy)) {
    try {
      withFileLockSync(usageLockPath(store), () => {
        if (!existsSync(legacy)) return;
        if (!existsSync(store)) {
          const raw = readJsonFile(legacy);
          const events = (Array.isArray(raw?.events) ? raw.events : []).slice(-MAX_USAGE_EVENTS);
          // Flushed before it is published: the store would otherwise be NUL
          // after a crash, losing the migrated history.
          writeFileAtomicSync(store, events.map(e => JSON.stringify(e) + '\n').join(''));
        }
        let backup = legacy + LEGACY_BACKUP_SUFFIX;
        if (existsSync(backup)) backup = `${legacy}.${Date.now()}${LEGACY_BACKUP_SUFFIX}`;
        renameSync(legacy, backup);
      });
    } catch {
      return; // retry on the next call; readers fall back to whatever exists
    }
  }
  migratedPaths.add(store);
}

// Incrementally updated in-memory view of the JSONL store. A refresh stats the
// file and reads only the bytes appended since the last refresh; a replaced
// (compacted) or truncated file triggers one full reload.
let usageView = { path: null, ino: null, offset: 0, events: [] };

function refreshUsageView() {
  const path = usageStorePath();
  let fd;
  try {
    fd = openSync(path, 'r');
    const st = fstatSync(fd);
    let view = usageView;
    if (view.path !== path || view.ino !== st.ino || st.size < view.offset) {
      view = usageView = { path, ino: st.ino, offset: 0, events: [] };
    }
    if (st.size > view.offset) {
      const buf = Buffer.allocUnsafe(st.size - view.offset);
      const n = readSync(fd, buf, 0, buf.length, view.offset);
      const end = buf.subarray(0, n).lastIndexOf(0x0a) + 1; // complete lines only
      if (end > 0) {
        view.offset += end;
        for (const e of parseJsonlEvents(buf.toString('utf8', 0, end))) view.events.push(e);
        if (view.events.length > MAX_USAGE_EVENTS * 2) view.events = view.events.slice(-MAX_USAGE_EVENTS);
      }
    }
    return usageView.events;
  } catch {
    usageView = { path: null, ino: null, offset: 0, events: [] };
    return usageView.events;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Bounded compaction: keep the newest MAX_USAGE_EVENTS lines. Runs in the
// background under the store lock (appenders take it too, so no append is lost).
let compactRunning = null; // the compaction in flight
let compactTimer = null; // a compaction scheduled to run
let compactStore = null;
function compactUsageStore(store) {
  compactRunning ??= runUsageCompaction(store).finally(() => {
    compactRunning = null;
  });
  return compactRunning;
}

async function runUsageCompaction(store) {
  try {
    await withFileLock(usageLockPath(store), async () => {
      const lines = (await readFile(store, 'utf8')).split('\n').filter(l => l.trim());
      if (lines.length <= MAX_USAGE_EVENTS * 1.5) return;
      await writeFileAtomicAsync(store, lines.slice(-MAX_USAGE_EVENTS).join('\n') + '\n');
    });
  } catch {
    // Compaction is best effort; the next flush retries.
  }
}

function maybeScheduleCompaction(store) {
  try {
    if (statSync(store).size < COMPACT_MIN_BYTES) return;
  } catch {
    return;
  }
  if (compactTimer) return;
  compactStore = store;
  compactTimer = setTimeout(() => {
    compactTimer = null;
    void compactUsageStore(store);
  }, 1000);
  compactTimer.unref?.();
}

function takePendingUsageBatch() {
  if (usageFlushTimer) {
    clearTimeout(usageFlushTimer);
    usageFlushTimer = null;
  }
  if (!pendingUsageEvents.length) return null;
  const eventsToWrite = pendingUsageEvents;
  pendingUsageEvents = [];
  // Leading newline terminates any torn line left by a crashed writer.
  return '\n' + eventsToWrite.map(e => JSON.stringify(e)).join('\n') + '\n';
}

// Normal flushes never block the loop: the lock wait and the append are
// asynchronous, and only the new events are serialized. Batches keep their
// order because withFileLock queues same-path callers in call order.
function flushGatewayUsageEvents() {
  const data = takePendingUsageBatch();
  if (!data) return usageFlushTail;
  ensureUsageStoreMigrated();
  const store = usageStorePath();
  const flush = withFileLock(usageLockPath(store), async () => {
    await mkdir(dirname(store), { recursive: true });
    await appendFile(store, data);
  }).then(() => maybeScheduleCompaction(store)).catch((error) => {
    // Local telemetry must never affect the routed model call, but a lost
    // batch is reported rather than settled as written.
    try {
      process.stderr.write(`[statusline] gateway usage events not saved: ${error?.message || error}\n`);
    } catch {}
  });
  usageFlushTail = Promise.all([usageFlushTail, flush]).then(() => {});
  return usageFlushTail;
}

// Process exit cannot await, so the last batch is written synchronously.
function flushGatewayUsageEventsSync() {
  const data = takePendingUsageBatch();
  if (!data) return;
  try {
    ensureUsageStoreMigrated();
    const store = usageStorePath();
    mkdirSync(dirname(store), { recursive: true });
    withFileLockSync(usageLockPath(store), () => appendFileSync(store, data));
  } catch {
    // Local telemetry must never affect the routed model call.
  }
}

/** Resolves once every recorded usage event has been handed to disk and the
 *  compaction those writes scheduled (run now instead of on its timer) or
 *  started has rewritten the store. */
export async function settleGatewayUsageWrites() {
  await flushGatewayUsageEvents();
  if (compactTimer) {
    clearTimeout(compactTimer);
    compactTimer = null;
    void compactUsageStore(compactStore);
  }
  await compactRunning;
}

function scheduleGatewayUsageFlush() {
  if (usageFlushTimer) return;
  usageFlushTimer = setTimeout(flushGatewayUsageEvents, USAGE_FLUSH_DELAY_MS);
  usageFlushTimer.unref?.();
}

try {
  process.on('beforeExit', flushGatewayUsageEvents);
  process.on('exit', flushGatewayUsageEventsSync);
} catch {
  // Embedded runtimes may not expose process lifecycle hooks.
}

function compactTelemetry(compact) {
  if (!compact || typeof compact !== 'object') return null;
  const out = {
    contextWindow: num(compact.contextWindow, null),
    compactLimitTokens: num(compact.compactLimitTokens, null),
    budgetWindow: num(compact.budgetWindow, null),
    beforeTokens: num(compact.beforeTokens, null),
    afterTokens: num(compact.afterTokens, null),
    reserveTokens: num(compact.reserveTokens, null),
    method: cleanString(compact.method) || null,
    compacted: compact.compacted === true,
  };
  if (compact.error) out.error = String(compact.error).slice(0, 240);
  if (compact.compactError) out.compactError = String(compact.compactError).slice(0, 240);
  return out;
}

function compactTransportTiming(timing) {
  if (!timing || typeof timing !== 'object') return null;
  const ms = value => Number.isFinite(Number(value))
    ? Math.max(0, Math.round(Number(value)))
    : null;
  const count = value => Number.isFinite(Number(value))
    ? Math.max(0, Math.round(Number(value)))
    : null;
  return {
    transport: cleanString(timing.transport) || null,
    outcome: cleanString(timing.outcome) || null,
    admissionQueueWaitMs: ms(timing.admissionQueueWaitMs),
    providerConcurrentRequests: count(timing.providerConcurrentRequests),
    providerQueuedRequests: count(timing.providerQueuedRequests),
    poolOwnerWaitMs: ms(timing.poolOwnerWaitMs),
    socketAcquireMs: ms(timing.socketAcquireMs),
    poolAcquireMs: ms(timing.poolAcquireMs),
    requestBuildSerializationMs: ms(timing.requestBuildSerializationMs),
    preResponseCreatedMs: ms(timing.preResponseCreatedMs),
    providerFirstEventMs: ms(timing.providerFirstEventMs),
    retryBackoffMs: ms(timing.retryBackoffMs),
    handshakeRetries: count(timing.handshakeRetries),
    acquireAttempts: count(timing.acquireAttempts),
    acquireMode: cleanString(timing.acquireMode) || null,
  };
}

export function recordGatewayUsageEvent(summary) {
  const event = {
    ts: summary?.at || Date.now(),
    provider: summary?.provider || null,
    model: summary?.model || null,
    providerKind: summary?.providerKind || providerKind(summary?.provider),
    routeKey: summary?.routeKey || null,
    routeSectionStartedAt: num(summary?.routeSectionStartedAt, 0) || null,
    responseModel: cleanString(summary?.responseModel) || null,
    serviceTier: cleanString(summary?.serviceTier) || null,
    inputTokens: num(summary?.inputTokens, 0),
    outputTokens: num(summary?.outputTokens, 0),
    cacheReadTokens: num(summary?.cacheReadTokens, 0),
    cacheWriteTokens: num(summary?.cacheWriteTokens, 0),
    promptTokens: num(summary?.promptTokens, 0),
    costUsd: round(summary?.costUsd || 0, 6) || 0,
    costSource: cleanString(summary?.costSource) || null,
    contextUsedPct: Number.isFinite(Number(summary?.contextUsedPct)) ? round(summary.contextUsedPct, 2) : null,
    durationMs: Number.isFinite(Number(summary?.durationMs)) ? Math.max(0, Math.round(summary.durationMs)) : null,
    requestKind: cleanString(summary?.requestKind) || null,
    // Effort this request actually ran at (auto effort may differ from the route's saved effort).
    effort: cleanString(summary?.effort) || null,
    sessionId: cleanString(summary?.sessionId) || null,
    sourceType: cleanString(summary?.sourceType) || null,
    sourceName: cleanString(summary?.sourceName) || null,
    toolCount: Number.isFinite(Number(summary?.toolCount)) ? Math.max(0, Math.round(summary.toolCount)) : null,
    systemCount: Number.isFinite(Number(summary?.systemCount)) ? Math.max(0, Math.round(summary.systemCount)) : null,
    messageCount: Number.isFinite(Number(summary?.messageCount)) ? Math.max(0, Math.round(summary.messageCount)) : null,
    chatMessageCount: Number.isFinite(Number(summary?.chatMessageCount)) ? Math.max(0, Math.round(summary.chatMessageCount)) : null,
    cacheStrategy: summary?.cacheStrategy && typeof summary.cacheStrategy === 'object'
      ? Object.fromEntries(Object.entries(summary.cacheStrategy)
        .map(([k, v]) => [cleanString(k), cleanString(v)])
        .filter(([k, v]) => k && v)
        .slice(0, 8))
      : null,
    rawUsageKeys: Array.isArray(summary?.rawUsageKeys)
      ? summary.rawUsageKeys.map(k => cleanString(k)).filter(Boolean).slice(0, 40)
      : [],
  };
  const compact = compactTelemetry(summary?.compact);
  if (compact) event.compact = compact;
  const transportTiming = compactTransportTiming(summary?.transportTiming);
  if (transportTiming) event.transportTiming = transportTiming;
  pendingUsageEvents.push(event);
  if (pendingUsageEvents.length >= 20) flushGatewayUsageEvents();
  else scheduleGatewayUsageFlush();
}

export function loadUsageEvents() {
  ensureUsageStoreMigrated();
  const events = refreshUsageView().slice(-MAX_USAGE_EVENTS);
  const cutoff = Date.now() - USAGE_EVENT_TTL_MS;
  return events.filter(e => num(e?.ts, 0) >= cutoff);
}

function labelForWindow(key, entry = {}) {
  const explicit = cleanString(entry.label);
  if (explicit) return explicit.toUpperCase();
  const s = String(key || '').toLowerCase().replace(/[-\s]+/g, '_');
  if (['five_hour', 'five_hours', '5h', '5_hour'].includes(s)) return '5H';
  if (['seven_day', 'seven_days', 'weekly', 'week', '7d', '7_day'].includes(s)) return '7D';
  if (['monthly', 'month', '30d', '30_day'].includes(s)) return 'M';
  if (['daily', 'day', '24h', '24_hour'].includes(s)) return '24H';
  return String(key || 'USE').toUpperCase();
}

function durationMsForWindow(key, entry = {}) {
  const direct = num(entry.durationMs ?? entry.windowMs, 0);
  if (direct > 0) return direct;
  const hours = num(entry.hours ?? entry.durationHours ?? entry.windowHours, 0);
  if (hours > 0) return hours * 60 * 60_000;
  const days = num(entry.days ?? entry.durationDays ?? entry.windowDays, 0);
  if (days > 0) return days * 24 * 60 * 60_000;
  const label = labelForWindow(key, entry);
  if (label === '5H') return 5 * 60 * 60_000;
  if (label === '7D') return 7 * 24 * 60 * 60_000;
  if (label === '24H') return 24 * 60 * 60_000;
  if (label === 'M') return 30 * 24 * 60 * 60_000;
  return 0;
}

function resetAtForWindow(key, entry = {}) {
  const raw = entry.resetAt ?? entry.resetsAt ?? entry.reset_at ?? entry.resets_at;
  const n = num(raw, 0);
  if (n > 0) return n < 10_000_000_000 ? n * 1000 : n;
  const duration = durationMsForWindow(key, entry);
  if (!(duration > 0)) return null;
  const now = Date.now();
  const start = Math.floor(now / duration) * duration;
  return start + duration;
}

function windowFromRaw(key, value) {
  const entry = value && typeof value === 'object' ? value : { used_percentage: value };
  const usedPct = num(entry.usedPct ?? entry.used_percentage ?? entry.percent ?? entry.used_percent ?? entry.percentage, NaN);
  const limitUsd = num(entry.limitUsd ?? entry.limit_usd ?? entry.budgetUsd ?? entry.budget_usd ?? entry.limit_usd_cents / 100, NaN);
  const usedUsd = num(entry.usedUsd ?? entry.used_usd ?? entry.spendUsd ?? entry.spend_usd ?? entry.costUsd ?? entry.cost_usd ?? entry.used_usd_cents / 100, NaN);
  const remainingUsd = num(entry.remainingUsd ?? entry.remaining_usd ?? entry.leftUsd ?? entry.left_usd ?? entry.balanceUsd ?? entry.balance_usd ?? entry.remaining_usd_cents / 100, NaN);
  const out = {
    label: labelForWindow(key, entry),
    source: cleanString(entry.source) || 'provider',
  };
  if (Number.isFinite(usedPct)) out.usedPct = round(usedPct, 2);
  if (Number.isFinite(limitUsd)) out.limitUsd = round(limitUsd, 4);
  if (Number.isFinite(usedUsd)) out.usedUsd = round(usedUsd, 4);
  if (Number.isFinite(remainingUsd)) out.remainingUsd = round(remainingUsd, 4);
  const resetAt = resetAtForWindow(key, entry);
  if (resetAt) out.resetAt = resetAt;
  return Object.keys(out).length > 2 ? out : null;
}

function normaliseWindowsFromObject(obj) {
  if (!obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) {
    return obj.map((entry, idx) => windowFromRaw(entry?.id || entry?.name || entry?.label || idx, entry)).filter(Boolean);
  }
  return Object.entries(obj).map(([key, value]) => windowFromRaw(key, value)).filter(Boolean);
}

function rawUsageWindows(rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object') return [];
  const direct = rawUsage.quotaWindows || rawUsage.quota_windows || rawUsage.usageWindows || rawUsage.usage_windows;
  const rate = rawUsage.rate_limits || rawUsage.rateLimits;
  const quota = rawUsage.quota || rawUsage.quotas || rawUsage.limits || rawUsage.budgets;
  return [
    ...normaliseWindowsFromObject(direct),
    ...normaliseWindowsFromObject(rate),
    ...normaliseWindowsFromObject(quota),
  ];
}

function providerDefaultWindows(routeInfo) {
  return [];
}

function configuredWindows(routeInfo) {
  let gateway = {};
  try { gateway = gatewaySection(); } catch { gateway = {}; }
  const providerCfg = routeInfo?.provider ? providerSection(routeInfo.provider) : {};
  return [
    ...normaliseWindowsFromObject(gateway.quotaWindows || gateway.usageWindows),
    ...normaliseWindowsFromObject(providerCfg.quotaWindows || providerCfg.usageWindows),
  ];
}

function applyLocalSpend(windows, routeInfo) {
  if (!windows.length) return [];
  const events = loadUsageEvents()
    .filter(e => (!routeInfo?.provider || e.provider === routeInfo.provider) && (!routeInfo?.model || e.model === routeInfo.model));
  const now = Date.now();
  return windows.map(w => {
    const duration = durationMsForWindow(w.label, w);
    const since = duration > 0 ? now - duration : 0;
    const usedUsd = events
      .filter(e => num(e.ts, 0) >= since)
      .reduce((sum, e) => sum + num(e.costUsd, 0), 0);
    const next = { ...w };
    if (num(w.limitUsd, 0) > 0) {
      next.usedUsd = round(usedUsd, 4);
      next.remainingUsd = round(Math.max(0, num(w.limitUsd, 0) - usedUsd), 4);
      next.usedPct = round(Math.min(100, usedUsd * 100 / num(w.limitUsd, 1)), 2);
      next.source = w.source || 'local-budget';
      if (!next.resetAt) next.resetAt = resetAtForWindow(w.label, w);
    }
    return next;
  });
}

function configuredBalance(routeInfo) {
  let gateway = {};
  try { gateway = gatewaySection(); } catch { gateway = {}; }
  const providerCfg = routeInfo?.provider ? providerSection(routeInfo.provider) : {};
  const raw = gateway.balance || gateway.budget || providerCfg.balance || providerCfg.budget || null;
  if (!raw || typeof raw !== 'object') return null;
  const budgetUsd = num(raw.budgetUsd ?? raw.limitUsd ?? raw.monthlyUsd ?? raw.amountUsd, NaN);
  if (!Number.isFinite(budgetUsd)) return null;
  const events = loadUsageEvents().filter(e => !routeInfo?.provider || e.provider === routeInfo.provider);
  const period = cleanString(raw.period) || '30d';
  const duration = durationMsForWindow(period, raw) || 30 * 24 * 60 * 60_000;
  const since = Date.now() - duration;
  const spentUsd = events
    .filter(e => num(e.ts, 0) >= since)
    .reduce((sum, e) => sum + num(e.costUsd, 0), 0);
  return {
    source: 'local-budget',
    period,
    budgetUsd: round(budgetUsd, 4),
    spentUsd: round(spentUsd, 4),
    remainingUsd: round(Math.max(0, budgetUsd - spentUsd), 4),
  };
}

function localRouteSpend(routeInfo) {
  if (!shouldTrackDollarSpend(routeInfo)) return null;
  const startedAt = ensureRouteSection(routeInfo);
  if (!startedAt) return null;
  const key = routeIdentityKey(routeInfo);
  const events = loadUsageEvents().filter(e =>
    (!routeInfo?.provider || e.provider === routeInfo.provider) &&
    (!routeInfo?.model || e.model === routeInfo.model) &&
    (e.routeKey ? e.routeKey === key : true) &&
    num(e.ts, 0) >= startedAt
  );
  const costUsd = events.reduce((sum, e) => sum + num(e.costUsd, 0), 0);
  if (!(costUsd > 0)) return null;
  return {
    label: 'SESS',
    source: 'local-route',
    period: 'session',
    startedAt,
    costUsd: round(costUsd, 6),
  };
}

export function buildGatewayLimits(routeInfo, providerOut = null, usageSnapshot = null) {
  const providerWindows = rawUsageWindows(providerOut?.usage?.raw);
  const snapshotWindows = Array.isArray(usageSnapshot?.quotaWindows) ? usageSnapshot.quotaWindows : [];
  const cfgWindows = configuredWindows(routeInfo);
  const defaultWindows = cfgWindows.length ? [] : providerDefaultWindows(routeInfo);
  const localWindows = applyLocalSpend([...cfgWindows, ...defaultWindows], routeInfo);
  return {
    quotaWindows: providerWindows.length ? providerWindows : snapshotWindows.length ? snapshotWindows : localWindows,
    balance: usageSnapshot?.balance || configuredBalance(routeInfo),
    routeSpend: localRouteSpend(routeInfo),
  };
}
