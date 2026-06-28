import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CLAUDE_CURRENT_MODE,
  isMixdogModelSelection,
  readClaudeCodeCurrentRoute,
} from '../src/gateway/claude-current.mjs';
import {
  normalizeClientHostPid,
  readLatestGatewayHostRoute,
  readGatewaySessionRoute,
} from '../src/gateway/session-routes.mjs';

function positiveInt(value) {
  const n = parseInt(String(value || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Keep the last known OAuth usage snapshot visible while idle. Live refreshes
// replace it when available, but a delayed/failed refresh must not make the
// statusline usage segment disappear. Previous-launch snapshots stay hidden
// during boot until the current process captures usage once.
const STATUSLINE_PROCESS_STARTED_AT_MS = Date.now() - Math.floor((Number(process.uptime?.()) || 0) * 1000);
function isPidAlive(pid) {
  const n = positiveInt(pid);
  if (!n) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

function runtimeRoot() {
  return process.env.MIXDOG_RUNTIME_ROOT
    ? path.resolve(process.env.MIXDOG_RUNTIME_ROOT)
    : path.join(os.tmpdir(), 'mixdog');
}

function claudeConfigDir() {
  return process.env.MIXDOG_CONFIG_DIR || path.join(os.homedir(), '.mixdog');
}

function pluginDataDir() {
  return process.env.MIXDOG_DATA_DIR || path.join(process.env.MIXDOG_HOME || path.join(os.homedir(), '.mixdog'), 'data');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function num(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (n === 0) return '$0';
  if (n >= 10) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function compactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  if (Math.abs(n) >= 10) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(1);
  return n.toFixed(2);
}

function pctOf(value, total) {
  const v = Number(value);
  const t = Number(total);
  if (!Number.isFinite(v) || !Number.isFinite(t) || t <= 0) return null;
  return Math.round(v * 10000 / t) / 100;
}

function cleanString(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || '';
}

// Mirror of route-meta.mjs providerKind(): classify a provider id into a kind
// bucket. statusline-route.mjs derives its own status snapshot and calls this
// the same way route-meta does, but never imported/defined it, so any route
// status build threw `providerKind is not defined`.
function providerKind(provider) {
  const p = String(provider || '').toLowerCase();
  if (!p) return 'unknown';
  if (p === 'opencode-go') return 'quota-api';
  if (p.includes('oauth')) return 'oauth';
  if (p === 'ollama' || p === 'lmstudio') return 'local';
  return 'api';
}

function slugSegment(value) {
  const s = cleanString(value);
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function targetAliasId(target) {
  const base = slugSegment(target?.presetId)
    || slugSegment(target?.presetName)
    || (slugSegment(target?.provider) && slugSegment(target?.model)
      ? [slugSegment(target.provider), slugSegment(target.model), slugSegment(target.effort), target.fast === true ? 'fast' : null].filter(Boolean).join('-')
      : '');
  return base ? `mixdog/${base}` : '';
}

function resolveConfiguredModelTarget(cfg, rawModel) {
  const stripped = cleanString(rawModel).replace(/\[[^\]]+\]\s*$/, '');
  if (!stripped) return null;
  const lower = stripped.toLowerCase();
  const agent = cfg?.agent && typeof cfg.agent === 'object' ? cfg.agent : {};
  const providers = agent.providers && typeof agent.providers === 'object' ? agent.providers : {};
  const presets = Array.isArray(agent.presets) ? agent.presets : [];
  for (const p of presets) {
    if (!p || typeof p !== 'object' || !p.provider || !p.model) continue;
    const providerEntry = providers[p.provider];
    if (providerEntry && typeof providerEntry === 'object' && providerEntry.enabled === false) continue;
    const target = {
      provider: p.provider,
      model: p.model,
      presetId: p.id || null,
      presetName: p.name || null,
      effort: p.effort || null,
      fast: p.fast === true,
    };
    const alias = targetAliasId(target).toLowerCase();
    if ((alias && lower === alias) || lower === String(target.model).toLowerCase()) return target;
  }
  return null;
}

function explicitMixdogRequestedModel(options = {}) {
  const route = options?.currentRoute && typeof options.currentRoute === 'object'
    ? options.currentRoute
    : null;
  const requested = cleanString(route?.requestedModel) || cleanString(route?.model);
  return isMixdogModelSelection(requested) ? requested : '';
}

function settingsMixdogRequestedModel() {
  const settings = readJson(path.join(claudeConfigDir(), 'settings.json'));
  const settingsModel = cleanString(settings?.model);
  return isMixdogModelSelection(settingsModel) ? settingsModel : '';
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

function boundedPercent(value, fallback = null) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0 && n <= 100) return n;
  return fallback;
}

function defaultEffectiveContextWindowPercent(_provider) {
  return 95;
}

function routeContextMeta(provider, info = {}, inherited = {}) {
  const rawContextWindow = num(
    inherited.rawContextWindow
      ?? inherited.raw_context_window
      ?? info.contextWindow
      ?? info.maxContextWindow
      ?? info.max_input_tokens
      ?? inherited.contextWindow,
    null,
  );
  const effectiveContextWindowPercent = boundedPercent(
    inherited.effectiveContextWindowPercent
      ?? inherited.effective_context_window_percent
      ?? info.effectiveContextWindowPercent
      ?? info.effective_context_window_percent,
    defaultEffectiveContextWindowPercent(provider),
  );
  const contextWindow = rawContextWindow
    ? Math.max(1, Math.floor(rawContextWindow * boundedPercent(effectiveContextWindowPercent, 100) / 100))
    : null;
  const explicitCompactLimit = num(
    inherited.autoCompactTokenLimit
      ?? inherited.auto_compact_token_limit
      ?? info.autoCompactTokenLimit
      ?? info.auto_compact_token_limit,
    null,
  );
  const derivedCompactLimit = contextWindow || rawContextWindow || null;
  const autoCompactTokenLimit = explicitCompactLimit && derivedCompactLimit
    ? Math.min(explicitCompactLimit, derivedCompactLimit)
    : explicitCompactLimit ?? derivedCompactLimit;
  return {
    contextWindow,
    rawContextWindow,
    effectiveContextWindowPercent,
    autoCompactTokenLimit,
  };
}

function compactBoundaryForStatus(routeInfo = {}, compact = null) {
  const compactLimit = num(routeInfo?.autoCompactTokenLimit ?? compact?.compactLimitTokens, 0);
  const contextWindow = num(routeInfo?.contextWindow ?? compact?.contextWindow, 0);
  const budgetWindow = num(compact?.budgetWindow, 0);
  const rawContextWindow = num(routeInfo?.rawContextWindow ?? compact?.rawContextWindow, 0);
  if (contextWindow > 0) return contextWindow;
  if (budgetWindow > 0) return budgetWindow;
  if (compactLimit > 0) return compactLimit;
  return rawContextWindow > 0 ? rawContextWindow : null;
}

function sessionIdFromTranscriptPath(transcriptPath) {
  const base = path.basename(String(transcriptPath || ''));
  return base.endsWith('.jsonl') ? base.slice(0, -6) : '';
}

function gatewaySessionStatusFileName(sessionId, clientHostPid = null) {
  const sid = cleanString(sessionId).replace(/[^0-9A-Za-z._-]/g, '');
  if (!sid) return null;
  const pid = normalizeClientHostPid(clientHostPid);
  return pid ? `${sid}--host-${pid}.json` : `${sid}.json`;
}

function gatewaySessionStatus(sessionId, clientHostPid = null) {
  const name = gatewaySessionStatusFileName(sessionId, clientHostPid);
  if (!name) return null;
  return readJson(path.join(runtimeRoot(), 'gateway-session-status', name));
}

function sessionRouteFor(gateway, sessionId, clientHostPid = null) {
  const sid = cleanString(sessionId);
  if (!sid) return { route: gateway, sessionScoped: false };
  const route = readGatewaySessionRoute(sid, { clientHostPid, fallbackLegacy: true })
    || readLatestGatewayHostRoute(clientHostPid, { excludeSessionId: sid });
  if (!route || typeof route !== 'object') return { route: gateway, sessionScoped: false };
  const provider = cleanString(route.defaultProvider || route.provider);
  const model = cleanString(route.defaultModel || route.model);
  if (!provider || !model) return { route: gateway, sessionScoped: false };
  return { route: {
    ...(gateway || {}),
    ...route,
    defaultProvider: provider,
    defaultModel: model,
  }, sessionScoped: true };
}

function routeOwnsModelDisplay(gateway, sessionScoped = false) {
  const mode = cleanString(gateway?.mode);
  return mode === CLAUDE_CURRENT_MODE || (!sessionScoped && cleanString(gateway?.modelDisplay));
}

function loadCachedModel(provider, model) {
  const files = [
    `${provider}-models.json`,
    provider === 'openai-oauth' ? 'openai-oauth-models.json' : null,
    provider === 'anthropic-oauth' ? 'anthropic-oauth-models.json' : null,
    provider === 'grok-oauth' ? 'grok-oauth-models.json' : null,
  ].filter(Boolean);
  for (const name of files) {
    const raw = readJson(path.join(pluginDataDir(), name));
    const models = Array.isArray(raw?.models) ? raw.models : Array.isArray(raw) ? raw : [];
    const found = models.find(m => (m?.id || m?.name || m?.slug) === model);
    if (found) return found;
  }
  return null;
}

function cachedQuotaWindowsFallback(provider, model) {
  // OAuth quota is provider/account-scoped, not model-scoped. Prefer the
  // current route key, then provider-wide cache, then the freshest same-provider
  // route entry so a model switch keeps showing quota before the next live fetch.
  if (!provider || !model) return [];
  try {
    const cachePath = path.join(pluginDataDir(), 'gateway-oauth-usage-cache.json');
    const cache = readJson(cachePath);
    const routes = cache && typeof cache.routes === 'object' ? cache.routes : null;
    if (!routes) return [];
    const routeKey = `${String(provider).toLowerCase()}${String(model)}`;
    const providerOnlyKey = String(provider).toLowerCase();
    const routePrefix = `${providerOnlyKey}`;
    const entry = routes[routeKey] || routes[providerOnlyKey] || Object.entries(routes)
      .filter(([key, value]) => key.startsWith(routePrefix) && Array.isArray(value?.quotaWindows))
      .sort((a, b) => (Number(b[1]?.cachedAt) || 0) - (Number(a[1]?.cachedAt) || 0))[0]?.[1];
    if (!Array.isArray(entry?.quotaWindows)) return [];
    // Boot guard: do not render previous-launch usage before the current runtime
    // has captured at least one snapshot. Once captured in this process, hold it
    // instead of blanking it during idle/network gaps.
    const cachedAt = Number(entry.cachedAt);
    if (!Number.isFinite(cachedAt) || cachedAt < STATUSLINE_PROCESS_STARTED_AT_MS) return [];
    return entry.quotaWindows;
  } catch {
    return [];
  }
}

function displayForModel(provider, model, info) {
  const display = cleanString(info?.display) || cleanString(info?.displayName) || cleanString(info?.name);
  if (display) return display;
  if (provider === 'anthropic-oauth') {
    const m = String(model || '').match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i);
    if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}.${m[3]}`;
  }
  const raw = cleanString(model);
  const gpt = raw.match(/^gpt[-_](.+)$/i);
  if (gpt) return `GPT ${gpt[1].replace(/[-_]+/g, ' ')}`;
  const grok = raw.match(/^grok[-_](.+)$/i);
  if (grok) return `Grok ${grok[1].replace(/[-_]+/g, ' ')}`;
  const glm = raw.match(/^glm[-_](.+)$/i);
  if (glm) return `GLM ${glm[1].replace(/[-_]+/g, ' ')}`;
  return model || '';
}

const STATUSLINE_MODEL_SUFFIXES = new Set(['XHIGH', 'HIGH', 'MEDIUM', 'MID', 'LOW', 'MAX', 'FAST']);

function stripStatuslineModelSuffixes(label) {
  const s = cleanString(label);
  if (!s) return '';
  const parts = s.split(/\s+/);
  while (parts.length > 1 && STATUSLINE_MODEL_SUFFIXES.has(parts[parts.length - 1].toUpperCase())) {
    parts.pop();
  }
  return parts.join(' ');
}

function statuslineDisplayForModel(provider, model, info, preferred = '') {
  const stripped = stripStatuslineModelSuffixes(preferred);
  const fromModel = displayForModel(provider, model, info);
  const norm = (value) => cleanString(value).toLowerCase().replace(/[\s_]+/g, '-');
  if (stripped) {
    if (norm(stripped) === norm(model) && /[-_]/.test(stripped)) return fromModel || stripped;
    return stripped;
  }
  return fromModel || stripped;
}

function configuredGatewayStatus(options = {}) {
  const cfgPath = path.join(pluginDataDir(), 'mixdog-config.json');
  const cfg = readJson(cfgPath);
  const gatewayBase = cfg?.gateway && typeof cfg.gateway === 'object' ? cfg.gateway : {};
  let { route: gateway, sessionScoped } = sessionRouteFor(gatewayBase, options.sessionId, options.clientHostPid);
  const currentRoute = options?.currentRoute && typeof options.currentRoute === 'object' ? options.currentRoute : null;
  const currentProvider = cleanString(currentRoute?.provider || currentRoute?.defaultProvider);
  const currentModel = cleanString(currentRoute?.model || currentRoute?.defaultModel);
  if ((!cleanString(gateway?.defaultProvider) || !cleanString(gateway?.defaultModel)) && currentProvider && currentModel) {
    gateway = {
      ...(gateway || {}),
      mode: cleanString(gateway?.mode) || 'fixed',
      defaultProvider: currentProvider,
      defaultModel: currentModel,
      ...(cleanString(currentRoute?.effort ?? currentRoute?.displayEffort) ? { effort: cleanString(currentRoute?.effort ?? currentRoute?.displayEffort) } : {}),
      ...(cleanBool(currentRoute?.fast) !== null ? { fast: cleanBool(currentRoute.fast) } : {}),
      ...(num(currentRoute?.contextWindow, null) ? { contextWindow: num(currentRoute.contextWindow, null) } : {}),
      ...(num(currentRoute?.rawContextWindow, null) ? { rawContextWindow: num(currentRoute.rawContextWindow, null) } : {}),
    };
  }
  const modules = cfg?.modules && typeof cfg.modules === 'object' ? cfg.modules : {};
  if (modules.gateway && modules.gateway.enabled === false) return null;
  const inherit = cleanString(gateway.mode) === CLAUDE_CURRENT_MODE;
  const inherited = inherit ? readClaudeCodeCurrentRoute() : null;
  const explicitRequestedModel = explicitMixdogRequestedModel(options)
    || (!sessionScoped ? settingsMixdogRequestedModel() : '');
  let aliasTarget = explicitRequestedModel
    ? resolveConfiguredModelTarget(cfg, explicitRequestedModel)
    : null;
  if (explicitRequestedModel && !aliasTarget) return null;
  let provider = inherit
    ? cleanString(inherited?.provider) || cleanString(gateway.defaultProvider)
    : cleanString(gateway.defaultProvider);
  let model = inherit
    ? cleanString(inherited?.model) || cleanString(gateway.defaultModel)
    : cleanString(gateway.defaultModel);
  if (!aliasTarget && inherit && !cleanString(inherited?.provider) && cleanString(inherited?.requestedModel)) {
    aliasTarget = resolveConfiguredModelTarget(cfg, inherited.requestedModel);
  }
  if (aliasTarget) {
    provider = aliasTarget.provider;
    model = aliasTarget.model;
  }
  if (!provider || !model) return null;
  const presets = Array.isArray(cfg?.agent?.presets) ? cfg.agent.presets : [];
  const preset = presets.find(p =>
    p?.provider === provider &&
    p?.model === model &&
    ((gateway.presetId && p.id === gateway.presetId) ||
      (gateway.presetName && (p.name === gateway.presetName || p.id === gateway.presetName)))
  ) || (presets.filter(p => p?.provider === provider && p?.model === model).length === 1
    ? presets.find(p => p?.provider === provider && p?.model === model)
    : null);
  const info = loadCachedModel(provider, model) || {};
  const effort = aliasTarget
    ? cleanString(aliasTarget.effort || gateway.effort || gateway.displayEffort || preset?.effort)
    : inherit
    ? cleanString(aliasTarget?.effort || inherited?.effort || gateway.effort || gateway.displayEffort || preset?.effort)
    : cleanString(gateway.effort || gateway.displayEffort || preset?.effort);
  const fast = aliasTarget
    ? cleanBool(aliasTarget.fast) ?? cleanBool(gateway.fast) ?? cleanBool(preset?.fast) ?? false
    : inherit
    ? cleanBool(aliasTarget?.fast) ?? cleanBool(inherited?.fast) ?? cleanBool(gateway.fast) ?? cleanBool(preset?.fast) ?? false
    : cleanBool(gateway.fast) ?? cleanBool(preset?.fast) ?? false;
  const routeMatchesCurrent = currentProvider === provider && currentModel === model;
  const contextSeed = {
    ...(inherited || {}),
    ...(routeMatchesCurrent ? currentRoute || {} : {}),
  };
  const contextMeta = routeContextMeta(provider, info, aliasTarget ? {} : contextSeed);
  return {
    mode: inherit ? CLAUDE_CURRENT_MODE : '',
    provider,
    model,
    providerKind: providerKind(provider),
    modelDisplay: statuslineDisplayForModel(
      provider,
      model,
      info,
      cleanString(aliasTarget?.presetName)
        || cleanString(inherited?.modelDisplay)
        || (routeOwnsModelDisplay(gateway, sessionScoped) ? cleanString(gateway.modelDisplay) : ''),
    ),
    effort,
    fast,
    ...contextMeta,
    outputTokens: num(info?.outputTokens ?? info?.maxOutputTokens ?? info?.max_output_tokens, null),
  };
}

export function loadGatewayStatus(options = {}) {
  const configured = configuredGatewayStatus(options);
  const configuredStatus = configured ? {
    ...configured,
    contextUsedPct: pctOf(options.activeContextTokens, compactBoundaryForStatus(configured)),
    lastUsage: null,
    quotaWindows: cachedQuotaWindowsFallback(configured.provider, configured.model),
    balance: null,
    routeSpend: null,
  } : null;
  const activeOverride = options.activeOverride && typeof options.activeOverride === 'object' ? options.activeOverride : null;
  const activeGlobal = activeOverride || readJson(path.join(runtimeRoot(), 'active-instance.json'));
  const currentClientHostPid = normalizeClientHostPid(options.clientHostPid);
  const sessionStatus = activeOverride || gatewaySessionStatus(options.sessionId, currentClientHostPid);
  const active = sessionStatus || activeGlobal;
  if (!active || !active.gateway_port || !active.gateway_provider || !active.gateway_model) return configuredStatus;
  const ownerPid = positiveInt(active.gateway_server_pid);
  if (ownerPid && !isPidAlive(ownerPid)) return configuredStatus;
  const updatedAt = num(active.gateway_updated_at, 0) || num(active.updatedAt, 0);
  if (updatedAt && Date.now() - updatedAt > 5 * 60_000) return configuredStatus;
  // Gate active-instance metrics on a positive ownership proof. The display
  // route itself always comes from the current session config (`configured`)
  // when present; active-instance only contributes live usage for that same
  // session/route, never model identity.
  const currentSessionId = cleanString(options.sessionId);
  const gatewayCcSessionMatch = currentSessionId && cleanString(active.gateway_cc_session_id) === currentSessionId;
  const activeClientHostPid = normalizeClientHostPid(active.gateway_client_host_pid ?? active.clientHostPid);
  const gatewayClientHostMatch = !currentClientHostPid || activeClientHostPid === currentClientHostPid;
  const gwTranscript = typeof active.gateway_transcript_path === 'string' && active.gateway_transcript_path || null;
  const currentTranscript = typeof activeGlobal?.transcriptPath === 'string' && activeGlobal.transcriptPath || null;
  const gatewayTranscriptMatch = currentSessionId
    ? sessionIdFromTranscriptPath(gwTranscript) === currentSessionId
    : !!(gwTranscript && currentTranscript && gwTranscript === currentTranscript);
  const activeTranscriptMatch = currentSessionId
    ? sessionIdFromTranscriptPath(currentTranscript) === currentSessionId
    : false;
  const transcriptMatch = gatewayCcSessionMatch || gatewayTranscriptMatch || (!gwTranscript && activeTranscriptMatch);
  const routeMatchesConfigured = configured
    ? configured.provider === active.gateway_provider && configured.model === active.gateway_model
    : true;
  const metricsOwnCurrentSession = !!(sessionStatus || gatewayCcSessionMatch || gatewayTranscriptMatch || activeTranscriptMatch);
  const metricsMatch = gatewayClientHostMatch && metricsOwnCurrentSession && routeMatchesConfigured;
  const lastUsage = gatewayClientHostMatch && (sessionStatus || gatewayCcSessionMatch || gatewayTranscriptMatch) && active.gateway_last_usage && typeof active.gateway_last_usage === 'object'
    ? active.gateway_last_usage
    : null;
  const lastCompact = lastUsage?.compact && typeof lastUsage.compact === 'object'
    ? lastUsage.compact
    : null;
  const contextBoundary = compactBoundaryForStatus({
    autoCompactTokenLimit: active.gateway_auto_compact_token_limit,
    contextWindow: active.gateway_context_window,
    rawContextWindow: active.gateway_raw_context_window,
  }, lastCompact);
  const liveContextTokens = num(options.activeContextTokens, null);
  const compactRequestWithLiveTokens = lastUsage?.requestKind === 'compact' && liveContextTokens !== null;
  const overflowContextTokens = !compactRequestWithLiveTokens && lastCompact?.overflow === true
    ? Math.max(
      num(lastUsage?.promptTokens, 0),
      num(lastCompact?.beforeTokens, 0),
      num(lastCompact?.afterTokens, 0),
      num(contextBoundary, 0),
    )
    : null;
  const recomputedContextUsedPct = pctOf(liveContextTokens ?? (compactRequestWithLiveTokens ? liveContextTokens : (overflowContextTokens ?? lastUsage?.promptTokens)), contextBoundary);
  const activeQuotaWindows = metricsMatch && Array.isArray(active.gateway_quota_windows)
    ? active.gateway_quota_windows
    : [];
  const statusProvider = configured?.provider || active.gateway_provider;
  const statusProviderKind = configured?.providerKind
    || (routeMatchesConfigured ? cleanString(active.gateway_provider_kind) : '')
    || providerKind(statusProvider);
  const activeStatus = {
    provider: statusProvider,
    model: configured?.model || active.gateway_model,
    modelDisplay: configured?.modelDisplay
      || statuslineDisplayForModel(active.gateway_provider, active.gateway_model, {}, active.gateway_model_display)
      || active.gateway_model,
    effort: configured?.effort ?? active.gateway_effort ?? '',
    fast: configured?.fast ?? active.gateway_fast === true,
    contextWindow: configured?.contextWindow ?? num(active.gateway_context_window, null),
    rawContextWindow: configured?.rawContextWindow ?? num(active.gateway_raw_context_window, null),
    effectiveContextWindowPercent: configured?.effectiveContextWindowPercent ?? num(active.gateway_effective_context_window_percent, null),
    autoCompactTokenLimit: configured?.autoCompactTokenLimit ?? num(active.gateway_auto_compact_token_limit, null),
    contextUsedPct: metricsMatch ? recomputedContextUsedPct ?? num(active.gateway_context_used_pct, null) : null,
    lastUsage,
    quotaWindows: activeQuotaWindows.length ? activeQuotaWindows : (configuredStatus?.quotaWindows || []),
    balance: metricsMatch && active.gateway_balance && typeof active.gateway_balance === 'object' ? active.gateway_balance : (configuredStatus?.balance || null),
    routeSpend: metricsMatch && active.gateway_route_spend && typeof active.gateway_route_spend === 'object' ? active.gateway_route_spend : (configuredStatus?.routeSpend || null),
    providerKind: statusProviderKind,
  };
  if (!configured) return activeStatus;
  return activeStatus;
}

function isLocalEstimateWindow(window) {
  const source = cleanString(window?.source || '').toLowerCase();
  return !source || source.includes('local') || source.includes('config');
}

export function formatGatewayLimitSegments(status, fmt) {
  if (!status) return [];
  const {
    COLS = 120,
    D = '',
    R = '',
    GRN = '',
    YLW = '',
    RED = '',
    colourPct = (p) => `${p}%`,
    epochMsToHHMM = () => '',
  } = fmt || {};
  const segments = [];
  const kind = cleanString(status.providerKind || '').toLowerCase();
  const isPlainApi = kind === 'api';
  const windows = !isPlainApi && Array.isArray(status.quotaWindows) ? status.quotaWindows : [];
  const maxWindows = COLS >= 120 ? 3 : COLS >= 80 ? 2 : 1;
  const routeSpend = num(status.routeSpend?.costUsd, null);
  const routeSpendLabel = cleanString(status.routeSpend?.label) || (COLS >= 120 ? 'SESS' : 'S');
  const windowResetText = (window) => {
    if (isLocalEstimateWindow(window)) return '';
    const at = num(window?.resetAt, null);
    if (!at || at <= Date.now()) return '';
    if (at - Date.now() < 24 * 60 * 60_000) return epochMsToHHMM(at);
    const d = new Date(at);
    if (!Number.isFinite(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const withReset = (segment, window) => {
    const reset = windowResetText(window);
    return reset ? `${segment} ${D}↻ ${reset}${R}` : segment;
  };
  const addRouteSpend = () => {
    if (routeSpend !== null && routeSpend > 0) {
      segments.push(`${D}${routeSpendLabel.toUpperCase()}${R} ${money(routeSpend)}`);
      return true;
    }
    return false;
  };
  const addApiBalance = () => {
    const remaining = num(status.balance?.remainingUsd, null);
    if (remaining !== null) {
      segments.push(`${D}Credit${R} ${money(remaining)}`);
    }
    return remaining !== null;
  };
  if (isPlainApi) {
    addRouteSpend();
    if (addApiBalance()) return segments;
    if (segments.length) return segments;
  }
  for (const w of windows.slice(0, maxWindows)) {
    const label = String(w?.label || 'USE').toUpperCase();
    const pct = num(w?.usedPct, null);
    const remaining = num(w?.remainingUsd, null);
    const limit = num(w?.limitUsd, null);
    const used = num(w?.usedUsd, null);
    const remainingCredits = num(w?.remainingCredits, null);
    const limitCredits = num(w?.limitCredits, null);
    const usedCredits = num(w?.usedCredits, null);
    const estimated = isLocalEstimateWindow(w);
    if (remaining !== null) {
      const color = estimated ? YLW : remaining <= 1 ? RED : remaining <= 5 ? YLW : GRN;
      segments.push(withReset(`${D}${label}${R} ${color}${estimated ? 'est ' : ''}${money(remaining)}${R}`, w));
    } else if (used !== null && limit !== null) {
      segments.push(withReset(`${D}${label}${R} ${estimated ? 'est ' : ''}${money(used)}/${money(limit)}`, w));
    } else if (remainingCredits !== null && limitCredits !== null) {
      const color = estimated ? YLW : pct !== null && pct >= 95 ? RED : pct !== null && pct >= 80 ? YLW : GRN;
      segments.push(withReset(`${D}${label}${R} ${color}${estimated ? 'est ' : ''}${compactNumber(remainingCredits)}/${compactNumber(limitCredits)}${R}`, w));
    } else if (remainingCredits !== null) {
      const color = estimated ? YLW : pct !== null && pct >= 95 ? RED : pct !== null && pct >= 80 ? YLW : GRN;
      segments.push(withReset(`${D}${label}${R} ${color}${estimated ? 'est ' : ''}${compactNumber(remainingCredits)}${R}`, w));
    } else if (usedCredits !== null && limitCredits !== null) {
      segments.push(withReset(`${D}${label}${R} ${estimated ? 'est ' : ''}${compactNumber(usedCredits)}/${compactNumber(limitCredits)}`, w));
    } else if (pct !== null) {
      segments.push(withReset(`${D}${label}${R} ${estimated ? 'est ' : ''}${colourPct(Math.round(pct))}`, w));
    }
  }
  addRouteSpend();
  if (!isPlainApi && COLS >= 80) {
    addApiBalance();
  }
  if (segments.length) return segments;

  const remaining = num(status.balance?.remainingUsd, null);
  if (remaining !== null) {
    segments.push(`${D}Credit${R} ${money(remaining)}`);
    addRouteSpend();
    return segments;
  }
  if (addRouteSpend()) return segments;
  const lastCost = num(status.lastUsage?.costUsd, null);
  if (lastCost && lastCost > 0 && !String(status.provider || '').includes('oauth')) {
    segments.push(`${D}$${R} ${money(lastCost)}`);
  }
  return segments;
}
