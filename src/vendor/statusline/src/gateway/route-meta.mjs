import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { resolvePluginData } from '../../../../runtime/shared/plugin-paths.mjs';
import { readSection } from '../../../../runtime/shared/config.mjs';
import { updateJsonAtomicSync } from '../../../../runtime/shared/atomic-file.mjs';
import { computeCostUsd, isInclusiveProvider } from '../../../../runtime/shared/llm/cost.mjs';
import { getModelMetadataSync } from '../../../../runtime/agent/orchestrator/providers/model-catalog.mjs';
import {
  estimateMessagesTokens,
  estimateRequestReserveTokens,
} from '../../../../runtime/agent/orchestrator/session/context-utils.mjs';
import { CLAUDE_CURRENT_MODE } from './claude-current.mjs';

const GATEWAY_USAGE_FILE = 'gateway-usage.local.json';
const MAX_USAGE_EVENTS = 1000;
const USAGE_EVENT_TTL_MS = 35 * 24 * 60 * 60_000;
const USAGE_FLUSH_DELAY_MS = 500;
let routeSectionKey = null;
let routeSectionStartedAt = 0;
let pendingUsageEvents = [];
let usageFlushTimer = null;

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

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
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

function gatewayPresets() {
  const agent = agentConfigSection();
  return Array.isArray(agent?.presets) ? agent.presets : [];
}

function cleanString(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || null;
}

function cleanBool(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'fast', 'priority'].includes(s)) return true;
    if (['0', 'false', 'no', 'off', 'none'].includes(s)) return false;
  }
  return null;
}

function providerKind(provider) {
  const p = String(provider || '').toLowerCase();
  if (!p) return 'unknown';
  if (p === 'opencode-go') return 'quota-api';
  if (p.includes('oauth')) return 'oauth';
  if (p === 'ollama' || p === 'lmstudio') return 'local';
  return 'api';
}

function boundedPercent(value, fallback = null) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0 && n <= 100) return n;
  return fallback;
}

function defaultEffectiveContextWindowPercent(_provider) {
  // Gateway-routed models use catalog/provider context metadata (LiteLLM,
  // models.dev, or native provider catalogs). Reserve a small universal
  // headroom for output/tool/system tokens while keeping the raw model window
  // visible separately.
  return 90;
}

function effectiveContextWindowPercent(provider, info = {}, seed = {}) {
  return boundedPercent(
    seed.effectiveContextWindowPercent
      ?? seed.effective_context_window_percent
      ?? info.effectiveContextWindowPercent
      ?? info.effective_context_window_percent,
    defaultEffectiveContextWindowPercent(provider),
  );
}

function effectiveContextWindow(rawContextWindow, percent) {
  const raw = num(rawContextWindow, 0);
  if (!(raw > 0)) return null;
  const pct = boundedPercent(percent, 100);
  return Math.max(1, Math.floor(raw * pct / 100));
}

function autoCompactTokenLimit(provider, rawContextWindow, contextWindow, info = {}, seed = {}) {
  // routeInfo.autoCompactTokenLimit is an EXPLICIT auto-compaction limit only.
  // It must NOT be derived from the effective/raw context window: the runtime
  // (manager.mjs resolveSessionContextMeta / loop.mjs resolveWorkerCompactPolicy)
  // treats autoCompactTokenLimit as the compaction trigger. Deriving it from the
  // full boundary makes autoTriggerTokens == boundary, collapses the compaction
  // buffer to 0, and auto-compaction only fires once the window is already full
  // (where semantic compact overflows and the turn is lost). The boundary/window
  // fallback that status + gateway env still need lives in compactBoundaryForRoute
  // / autoCompactWindowForRoute, which read contextWindow/rawContextWindow
  // directly. Return null when there is no explicit provider/catalog/seed limit.
  const explicit = num(
    seed.autoCompactTokenLimit
      ?? seed.auto_compact_token_limit
      ?? info.autoCompactTokenLimit
      ?? info.auto_compact_token_limit,
    0,
  );
  if (!(explicit > 0)) return null;
  // An explicit limit is only a real auto-compaction trigger when it sits
  // STRICTLY BELOW the boundary/window. A legacy seed/info value equal to or
  // above the boundary is a derived full-window artifact — returning
  // Math.min(explicit, derived) would still surface the boundary, which the
  // runtime then treats as the trigger and collapses the compaction buffer.
  // Drop those to null so display + downstream fall back to boundary − buffer.
  const derived = num(contextWindow, 0) || num(rawContextWindow, 0);
  if (derived > 0) return explicit < derived ? explicit : null;
  // No boundary known: keep the positive explicit value (cannot be proven to
  // be a full-window artifact), but never derive one.
  return explicit;
}

// Test-only export of the explicit-vs-derived auto-compact-limit resolver
// (see scripts/compact-trigger-migration-smoke.mjs).
export const _autoCompactTokenLimit = autoCompactTokenLimit;

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

function presetLabel(p) {
  return cleanString(p?.name) || cleanString(p?.id) || null;
}

function findPresetForRoute(provider, model, gateway) {
  const presets = gatewayPresets().filter(p => p?.provider === provider && p?.model === model);
  if (!presets.length) return null;
  if (cleanString(gateway?.mode) === CLAUDE_CURRENT_MODE) {
    const effort = cleanString(gateway?.effort ?? gateway?.displayEffort);
    const fast = cleanBool(gateway?.fast);
    if (effort || fast !== null) {
      const exact = presets.find(p =>
        (!effort || cleanString(p.effort) === effort) &&
        (fast === null || cleanBool(p.fast) === fast)
      );
      if (exact) return exact;
    }
    return presets.length === 1 ? presets[0] : null;
  }
  const presetId = cleanString(gateway?.presetId);
  const presetName = cleanString(gateway?.presetName);
  if (presetId || presetName) {
    const exact = presets.find(p =>
      (presetId && p.id === presetId) ||
      (presetName && (p.name === presetName || p.id === presetName))
    );
    if (exact) return exact;
  }
  const effort = cleanString(gateway?.effort ?? gateway?.displayEffort);
  const fast = cleanBool(gateway?.fast);
  if (effort || fast !== null) {
    const exact = presets.find(p =>
      (!effort || cleanString(p.effort) === effort) &&
      (fast === null || cleanBool(p.fast) === fast)
    );
    if (exact) return exact;
  }
  return presets.length === 1 ? presets[0] : null;
}

function loadCachedModel(provider, model) {
  const files = [
    `${provider}-models.json`,
    provider === 'openai-oauth' ? 'openai-oauth-models.json' : null,
    provider === 'anthropic-oauth' ? 'anthropic-oauth-models.json' : null,
    provider === 'grok-oauth' ? 'grok-oauth-models.json' : null,
  ].filter(Boolean);
  const dataDir = resolvePluginData();
  for (const name of files) {
    const raw = readJsonFile(join(dataDir, name));
    const models = Array.isArray(raw?.models) ? raw.models : Array.isArray(raw) ? raw : [];
    const found = models.find(m => (m?.id || m?.name || m?.slug) === model);
    if (found) return found;
  }
  return null;
}

function modelInfoFromProvider(providerObj, model) {
  try {
    const info = providerObj?.getCachedModelInfo?.(model);
    return info && typeof info === 'object' ? info : null;
  } catch {
    return null;
  }
}

function displayForModel(provider, model, info) {
  const display = cleanString(info?.display) || cleanString(info?.displayName) || cleanString(info?.name);
  if (display) return display;
  if (provider === 'anthropic-oauth') {
    const m = String(model || '').match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i);
    if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}.${m[3]}`;
  }
  return model || '';
}

function mergeModelInfo(provider, model, providerObj) {
  const fromProvider = modelInfoFromProvider(providerObj, model);
  const fromCache = loadCachedModel(provider, model);
  const fromCatalog = getModelMetadataSync(model, provider);
  return {
    ...(fromCatalog || {}),
    ...(fromCache || {}),
    ...(fromProvider || {}),
  };
}

export function readGatewayRouteInfo(seed = {}, providerObj = null) {
  let gateway = {};
  try { gateway = gatewaySection(); } catch { gateway = {}; }
  const mode = cleanString(seed.mode) || cleanString(gateway.mode);
  const inheritClaudeCurrent = mode === CLAUDE_CURRENT_MODE;
  const seedProvider = cleanString(seed.provider ?? seed.defaultProvider);
  const seedModel = cleanString(seed.model ?? seed.defaultModel);
  const provider = cleanString(process.env.MIXDOG_GATEWAY_PROVIDER)
    || seedProvider
    || cleanString(gateway.defaultProvider);
  const model = cleanString(process.env.MIXDOG_GATEWAY_MODEL)
    || seedModel
    || cleanString(gateway.defaultModel);
  if (!provider || !model) return { provider, model, mode };

  const routeGateway = {
    ...gateway,
    ...(seed?.presetId ? { presetId: seed.presetId } : {}),
    ...(seed?.presetName ? { presetName: seed.presetName } : {}),
    ...(seed?.effort || seed?.displayEffort ? { effort: seed.effort ?? seed.displayEffort } : {}),
    ...(hasOwn(seed, 'fast') ? { fast: seed.fast } : {}),
  };
  const seedGateway = inheritClaudeCurrent
    ? {
      mode,
      effort: seed.effort ?? seed.displayEffort ?? gateway.effort ?? gateway.displayEffort,
      fast: seed.fast ?? gateway.fast,
    }
    : routeGateway;
  const preset = findPresetForRoute(provider, model, seedGateway);
  const effort = cleanString(process.env.MIXDOG_GATEWAY_EFFORT)
    || cleanString(seed.effort ?? seed.displayEffort)
    || cleanString(gateway.effort ?? gateway.displayEffort)
    || cleanString(preset?.effort);
  const fast = cleanBool(process.env.MIXDOG_GATEWAY_FAST)
    ?? cleanBool(seed.fast)
    ?? cleanBool(gateway.fast)
    ?? cleanBool(preset?.fast)
    ?? false;
  const info = mergeModelInfo(provider, model, providerObj);
  const rawContextWindow = num(info?.contextWindow ?? info?.maxContextWindow ?? info?.max_input_tokens, 0)
    || num(seed.contextWindow, 0);
  const effectivePercent = effectiveContextWindowPercent(provider, info, seed);
  const contextWindow = effectiveContextWindow(rawContextWindow, effectivePercent);
  const compactLimit = autoCompactTokenLimit(provider, rawContextWindow, contextWindow, info, seed);
  const outputTokens = num(info?.outputTokens ?? info?.maxOutputTokens ?? info?.max_output_tokens, 0);

  return {
    mode,
    provider,
    model,
    requestedModel: cleanString(seed.requestedModel) || null,
    providerKind: providerKind(provider),
    modelDisplay: cleanString(seed.modelDisplay) || displayForModel(provider, model, info),
    presetId: inheritClaudeCurrent ? cleanString(preset?.id) : cleanString(seed.presetId) || cleanString(gateway.presetId) || cleanString(preset?.id),
    presetName: inheritClaudeCurrent ? presetLabel(preset) : cleanString(seed.presetName) || cleanString(gateway.presetName) || presetLabel(preset),
    effort,
    fast,
    thinkingBudgetTokens: num(seed.thinkingBudgetTokens, null),
    contextWindow: contextWindow > 0 ? contextWindow : null,
    rawContextWindow: rawContextWindow > 0 ? rawContextWindow : null,
    effectiveContextWindowPercent: effectivePercent,
    autoCompactTokenLimit: compactLimit,
    outputTokens: outputTokens > 0 ? outputTokens : null,
    inputCostPerM: info?.inputCostPerM ?? null,
    outputCostPerM: info?.outputCostPerM ?? null,
    cacheReadCostPerM: info?.cacheReadCostPerM ?? null,
    cacheWriteCostPerM: info?.cacheWriteCostPerM ?? null,
    serviceTier: cleanString(info?.defaultServiceTier) || null,
  };
}

function compactBoundaryForRoute(routeInfo = {}, compact = null) {
  const compactLimit = num(routeInfo?.autoCompactTokenLimit ?? compact?.compactLimitTokens, 0);
  const contextWindow = num(routeInfo?.contextWindow ?? compact?.contextWindow, 0);
  const budgetWindow = num(compact?.budgetWindow, 0);
  const rawContextWindow = num(routeInfo?.rawContextWindow ?? compact?.rawContextWindow, 0);
  if (compactLimit > 0 && contextWindow > 0) return Math.min(compactLimit, contextWindow);
  if (compactLimit > 0) return compactLimit;
  if (budgetWindow > 0 && contextWindow > 0) return Math.min(budgetWindow, contextWindow);
  if (budgetWindow > 0) return budgetWindow;
  if (contextWindow > 0) return contextWindow;
  return rawContextWindow > 0 ? rawContextWindow : 0;
}

// Single source of truth for the value synced to host env
// CLAUDE_CODE_AUTO_COMPACT_WINDOW. BOTH the --enable-time write
// (scripts/gateway-model.mjs) and the runtime sync (src/gateway/server.mjs)
// must derive the window the SAME way, or they disagree on the value written to
// settings.json. Prefer the explicit compact limit, bounded by the effective
// context window, then fall back to context/raw metadata. Returns a positive
// integer, or null when unknown.
export function autoCompactWindowForRoute(routeInfo) {
  const n = compactBoundaryForRoute(routeInfo);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function gatewaySendOptions(routeInfo, extra = {}) {
  const opts = {};
  if (routeInfo?.thinkingBudgetTokens) opts.thinkingBudgetTokens = routeInfo.thinkingBudgetTokens;
  if (routeInfo?.effort) opts.effort = routeInfo.effort;
  if (routeInfo?.fast === true) opts.fast = true;
  if (routeInfo?.outputTokens) opts.maxOutputTokens = routeInfo.outputTokens;
  if (extra?.sessionId) opts.sessionId = extra.sessionId;
  return opts;
}

export function prepareGatewayMessages(messages, tools, routeInfo, _log = () => {}, opts = {}) {
  const working = messages;
  const contextWindow = num(routeInfo?.contextWindow, 0);
  const compactLimit = num(routeInfo?.autoCompactTokenLimit, 0);
  const budgetWindow = compactBoundaryForRoute(routeInfo);
  const reserveTokens = estimateRequestReserveTokens(tools);
  const beforeTokens = estimateMessagesTokens(working) + reserveTokens;
  const lastPromptTokens = num(opts?.lastPromptTokens, 0);
  const cacheCold = opts?.cacheCold === true;
  const afterTokens = estimateMessagesTokens(working) + reserveTokens;
  const compact = {
    contextWindow: contextWindow > 0 ? contextWindow : null,
    compactLimitTokens: compactLimit > 0 ? compactLimit : null,
    budgetWindow: budgetWindow > 0 ? budgetWindow : null,
    beforeTokens,
    afterTokens,
    reserveTokens,
    lastPromptTokens: lastPromptTokens || null,
    cacheCold,
    method: 'none',
    compacted: false,
  };
  if (budgetWindow > 0 && afterTokens > budgetWindow) compact.overflow = true;
  return {
    messages: working,
    compact,
  };
}

function promptFootprintTokens(provider, usage) {
  const input = num(usage?.inputTokens, 0);
  const cacheRead = num(usage?.cachedTokens ?? usage?.cacheReadTokens, 0);
  const cacheWrite = num(usage?.cacheWriteTokens, 0);
  if (num(usage?.promptTokens, 0) > 0) return num(usage.promptTokens, 0);
  return isInclusiveProvider(provider) ? input : input + cacheRead + cacheWrite;
}

function usageCostUsd(routeInfo, usage) {
  if (Number.isFinite(Number(usage?.costUsd))) return round(Number(usage.costUsd), 6);
  return computeCostUsd({
    provider: routeInfo?.provider,
    model: routeInfo?.model,
    inputTokens: num(usage?.inputTokens, 0),
    outputTokens: num(usage?.outputTokens, 0),
    cacheReadTokens: num(usage?.cachedTokens ?? usage?.cacheReadTokens, 0),
    cacheWriteTokens: num(usage?.cacheWriteTokens, 0),
  });
}

function contextUsageBoundary(routeInfo, compact = null) {
  const contextWindow = num(routeInfo?.contextWindow ?? compact?.contextWindow, 0);
  const budgetWindow = num(compact?.budgetWindow, 0);
  const rawContextWindow = num(routeInfo?.rawContextWindow ?? compact?.rawContextWindow, 0);
  if (contextWindow > 0) return contextWindow;
  if (budgetWindow > 0) return budgetWindow;
  return rawContextWindow > 0 ? rawContextWindow : compactBoundaryForRoute(routeInfo, compact);
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
  const costUsd = usageCostUsd(routeInfo, u);
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

function flushGatewayUsageEvents() {
  if (usageFlushTimer) {
    clearTimeout(usageFlushTimer);
    usageFlushTimer = null;
  }
  if (!pendingUsageEvents.length) return;
  const eventsToWrite = pendingUsageEvents;
  pendingUsageEvents = [];
  const cutoff = Date.now() - USAGE_EVENT_TTL_MS;
  try {
    updateJsonAtomicSync(usageStorePath(), (curRaw) => {
      const cur = curRaw && typeof curRaw === 'object' ? curRaw : {};
      const events = Array.isArray(cur.events) ? cur.events : [];
      const kept = events
        .filter(e => num(e?.ts, 0) >= cutoff)
        .slice(-MAX_USAGE_EVENTS + eventsToWrite.length);
      kept.push(...eventsToWrite);
      return { version: 1, updatedAt: Date.now(), events: kept.slice(-MAX_USAGE_EVENTS) };
    }, { compact: true, fsync: false, fsyncDir: false });
  } catch {
    // Local telemetry must never affect the routed model call.
  }
}

function scheduleGatewayUsageFlush() {
  if (usageFlushTimer) return;
  usageFlushTimer = setTimeout(flushGatewayUsageEvents, USAGE_FLUSH_DELAY_MS);
  usageFlushTimer.unref?.();
}

try {
  process.on('beforeExit', flushGatewayUsageEvents);
  process.on('exit', flushGatewayUsageEvents);
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
    sessionId: cleanString(summary?.sessionId) || null,
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
  pendingUsageEvents.push(event);
  if (pendingUsageEvents.length >= 20) flushGatewayUsageEvents();
  else scheduleGatewayUsageFlush();
}

function loadUsageEvents() {
  const raw = readJsonFile(usageStorePath());
  const events = Array.isArray(raw?.events) ? raw.events : [];
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

export function gatewayAdvertFields(routeInfo, usageSummary = null, limits = null) {
  ensureRouteSection(routeInfo);
  const fields = {
    gateway_route_mode: routeInfo?.mode || null,
    gateway_provider: routeInfo?.provider || null,
    gateway_provider_kind: routeInfo?.providerKind || providerKind(routeInfo?.provider),
    gateway_model: routeInfo?.model || null,
    gateway_model_display: routeInfo?.modelDisplay || routeInfo?.model || null,
    gateway_context_window: routeInfo?.contextWindow || null,
    gateway_raw_context_window: routeInfo?.rawContextWindow || routeInfo?.contextWindow || null,
    gateway_effective_context_window_percent: routeInfo?.effectiveContextWindowPercent || null,
    gateway_auto_compact_token_limit: routeInfo?.autoCompactTokenLimit || null,
    gateway_output_tokens: routeInfo?.outputTokens || null,
    gateway_preset_id: routeInfo?.presetId || null,
    gateway_preset_name: routeInfo?.presetName || null,
    gateway_effort: routeInfo?.effort || null,
    gateway_fast: routeInfo?.fast === true,
    gateway_updated_at: Date.now(),
  };
  if (usageSummary) {
    fields.gateway_context_used_pct = usageSummary.contextUsedPct;
    fields.gateway_last_usage = usageSummary;
  }
  if (limits?.quotaWindows?.length) fields.gateway_quota_windows = limits.quotaWindows;
  if (limits?.balance) fields.gateway_balance = limits.balance;
  if (limits?.routeSpend) fields.gateway_route_spend = limits.routeSpend;
  return fields;
}
