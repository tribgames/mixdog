import fs from 'fs';
import os from 'os';
import path from 'path';

export const CLAUDE_CURRENT_MODE = 'claude-current';
export const CLAUDE_CURRENT_CHOICE_ID = 'claude-current';

const DEFAULT_FAMILY_MODEL = Object.freeze({
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
});

const EFFORT_BUDGET = Object.freeze({
  low: 1024,
  medium: 4096,
  high: 16384,
  xhigh: 32768,
  max: 32768,
});
const SNAPSHOT_REFRESH_MS = 30_000;

function cleanString(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

export function isMixdogModelSelection(value) {
  const raw = typeof value === 'string'
    ? value
    : value?.requestedModel || value?.model || '';
  return cleanString(raw).toLowerCase().startsWith('mixdog/');
}

export function isClaudeNativeModelSelection(route) {
  return !!(
    route &&
    route.provider === 'anthropic-oauth' &&
    cleanString(route.model) &&
    !isMixdogModelSelection(route)
  );
}

function num(v, fallback = null) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function cleanBool(v) {
  if (v === true || v === false) return v;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'fast', 'priority'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'standard'].includes(s)) return false;
  return null;
}

function claudeConfigDir() {
  return process.env.MIXDOG_CONFIG_DIR || path.join(os.homedir(), '.mixdog');
}

function pluginDataDir() {
  return process.env.MIXDOG_DATA_DIR || path.join(process.env.MIXDOG_HOME || path.join(os.homedir(), '.mixdog'), 'data');
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function readFreshJsonFile(file, maxAgeMs) {
  try {
    const st = fs.statSync(file);
    if (Number.isFinite(maxAgeMs) && maxAgeMs > 0 && Date.now() - st.mtimeMs > maxAgeMs) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function snapshotEquivalent(a, b) {
  if (!a || !b) return false;
  const keys = [
    'mode',
    'source',
    'provider',
    'model',
    'requestedModel',
    'modelDisplay',
    'effort',
    'fast',
    'thinkingBudgetTokens',
    'contextWindow',
  ];
  return keys.every(k => (a[k] ?? null) === (b[k] ?? null));
}

function familyDefaultModel(family) {
  const f = String(family || '').toLowerCase();
  if (!f) return null;
  const envName = `ANTHROPIC_DEFAULT_${f.toUpperCase()}_MODEL`;
  return cleanString(process.env[envName]) || DEFAULT_FAMILY_MODEL[f] || null;
}

export function stripClaudeContextSuffix(model) {
  return cleanString(model).replace(/\[[^\]]+\]\s*$/i, '');
}

function contextWindowFromRawModel(raw, resolved) {
  const s = cleanString(raw).toLowerCase();
  if (/\[1m\]/.test(s)) return 1000000;
  if (/^claude-(opus|sonnet)-4-(6|7|8)(?:$|-)/i.test(resolved || '')) return 1000000;
  if (/^claude-haiku-4-5/i.test(resolved || '')) return 200000;
  return null;
}

export function resolveClaudeModelAlias(model) {
  const raw = cleanString(model);
  if (!raw) return null;
  const stripped = stripClaudeContextSuffix(raw);
  if (/^claude-/i.test(stripped)) return stripped;
  const family = stripped.match(/^(opus|sonnet|haiku)(?:[-_].*)?$/i)?.[1]?.toLowerCase();
  if (family) return familyDefaultModel(family);
  return null;
}

export function displayClaudeModel(model, raw = '', display = '') {
  const explicit = cleanString(display);
  if (explicit) return explicit;
  const id = cleanString(model) || resolveClaudeModelAlias(raw) || cleanString(raw);
  const m = id.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-\d{8})?$/i);
  if (m) {
    const family = `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}`;
    const suffix = /\[1m\]/i.test(raw) || contextWindowFromRawModel(raw, id) === 1000000 ? ' (1M context)' : '';
    return `${family} ${m[2]}.${m[3]}${suffix}`;
  }
  return id || raw || '';
}

function normalizeEffort(v) {
  const s = cleanString(v).toLowerCase();
  if (!s) return null;
  if (s === 'extra-high' || s === 'very-high') return 'xhigh';
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(s)) return s;
  return null;
}

function effortFromThinking(thinking) {
  if (!thinking || typeof thinking !== 'object') return null;
  const t = cleanString(thinking.type).toLowerCase();
  if (t && t !== 'enabled') return null;
  const budget = num(thinking.budget_tokens ?? thinking.budgetTokens, null);
  if (!(budget > 0)) return null;
  let best = null;
  let bestDelta = Infinity;
  for (const [effort, value] of Object.entries(EFFORT_BUDGET)) {
    const delta = Math.abs(value - budget);
    if (delta < bestDelta) { best = effort; bestDelta = delta; }
  }
  return best;
}

function fastFromPayload(payload) {
  const direct = cleanBool(payload?.fast_mode)
    ?? cleanBool(payload?.fastMode)
    ?? cleanBool(payload?.fast);
  if (direct !== null) return direct;
  const speed = cleanString(payload?.speed || payload?.service_tier || payload?.serviceTier).toLowerCase();
  if (speed === 'fast' || speed === 'priority') return true;
  if (speed === 'standard' || speed === 'default') return false;
  return null;
}

function routeFromPayload(payload, source) {
  if (!payload || typeof payload !== 'object') return null;
  const modelObj = payload.model && typeof payload.model === 'object' ? payload.model : null;
  const rawModel = cleanString(modelObj?.id)
    || cleanString(payload.model)
    || cleanString(payload.request?.model)
    || cleanString(payload.message?.model);
  const model = resolveClaudeModelAlias(rawModel);
  const effort = normalizeEffort(payload.effort?.level)
    || normalizeEffort(payload.effortLevel)
    || effortFromThinking(payload.thinking);
  const fast = fastFromPayload(payload);
  const thinkingBudgetTokens = num(payload.thinking?.budget_tokens ?? payload.thinking?.budgetTokens, null);
  const contextWindow = num(payload.context_window?.context_window_size, null)
    || contextWindowFromRawModel(rawModel, model);
  // A present rawModel alone is enough to return a route: when it is not a
  // Claude-family alias, `model` stays null and `provider` stays null so the
  // caller (server.mjs) can reverse-map requestedModel to a gateway target.
  if (!model && !rawModel && !effort && fast === null && !(thinkingBudgetTokens > 0)) return null;
  return {
    mode: CLAUDE_CURRENT_MODE,
    source,
    provider: model ? 'anthropic-oauth' : null,
    model,
    requestedModel: rawModel || null,
    modelDisplay: model ? displayClaudeModel(model, rawModel, modelObj?.display_name) : null,
    effort,
    fast,
    thinkingBudgetTokens: thinkingBudgetTokens > 0 ? thinkingBudgetTokens : null,
    contextWindow: contextWindow > 0 ? contextWindow : null,
    at: Date.now(),
  };
}

function mergeRoute(base, next) {
  if (!next) return base || null;
  if (!base) return { ...next };
  // When `next` carries a NEW requestedModel (a live /model choice that differs
  // from the base layer), that requested model is the authoritative signal for
  // this turn. Do NOT let the base layer's resolved provider/model bleed
  // through when next deliberately left them null (a non-Claude model awaiting
  // reverse-mapping by server.mjs) — otherwise a prior Claude route would
  // silently override the requested non-Claude model.
  const nextRequested = cleanString(next.requestedModel);
  const baseRequested = cleanString(base.requestedModel);
  const requestSupersedes = !!nextRequested && nextRequested !== baseRequested;
  return {
    ...base,
    ...next,
    provider: requestSupersedes ? (next.provider ?? null) : (next.provider || base.provider),
    model: requestSupersedes ? (next.model ?? null) : (next.model || base.model),
    requestedModel: next.requestedModel || base.requestedModel,
    modelDisplay: requestSupersedes ? (next.modelDisplay ?? null) : (next.modelDisplay || base.modelDisplay),
    effort: next.effort || base.effort,
    fast: next.fast !== null && next.fast !== undefined ? next.fast : base.fast,
    thinkingBudgetTokens: next.thinkingBudgetTokens || base.thinkingBudgetTokens,
    contextWindow: requestSupersedes ? (next.contextWindow ?? null) : (next.contextWindow || base.contextWindow),
    source: next.source || base.source,
  };
}

function routeFromSettings() {
  const settings = readJsonFile(path.join(claudeConfigDir(), 'settings.json'));
  if (!settings || typeof settings !== 'object') return null;
  const route = routeFromPayload({
    model: cleanString(settings.model),
    effortLevel: settings.effortLevel,
    fast_mode: settings.fastMode ?? settings.fast_mode ?? settings.fast,
  }, 'settings');
  if (!route) return null;
  route.thinkingEnabled = settings.alwaysThinkingEnabled === true || !!route.effort;
  return route;
}

function routeFromPersistedStatus(maxAgeMs) {
  const own = readFreshJsonFile(path.join(pluginDataDir(), 'claude-current-model.json'), maxAgeMs);
  if (own && own.mode === CLAUDE_CURRENT_MODE) return own;
  const last = readFreshJsonFile(path.join(claudeConfigDir(), 'cc-statusline-last.json'), maxAgeMs);
  return routeFromPayload(last, 'cc-statusline-last');
}

export function readClaudeCodeCurrentRoute({ request = null, maxAgeMs = 10 * 60 * 1000, forBoot = false } = {}) {
  let route = routeFromSettings();
  route = mergeRoute(route, routeFromPersistedStatus(maxAgeMs));
  route = mergeRoute(route, routeFromPayload(request, 'request'));
  // Boot context (forBoot) needs a concrete provider/model so the gateway does
  // not idle-exit (server.mjs:1411). A route can be non-null yet carry a
  // non-Claude requestedModel with provider/model still null (awaiting reverse-
  // map in the request path) — at boot there is no request to reverse-map, so
  // treat a model-less route the same as no route and seed the Claude default.
  // The request path (forBoot=false) must NOT do this: it has to keep
  // provider/model null so server.mjs can reverse-map requestedModel.
  if (!route || (forBoot && !route.model)) {
    const model = familyDefaultModel('opus');
    route = {
      mode: CLAUDE_CURRENT_MODE,
      source: 'default',
      provider: 'anthropic-oauth',
      model,
      requestedModel: 'opus',
      modelDisplay: displayClaudeModel(model, 'opus[1m]'),
      effort: null,
      fast: false,
      thinkingBudgetTokens: null,
      contextWindow: 1000000,
      at: Date.now(),
    };
  }
  // Only default to the Claude OAuth provider when a Claude-family model
  // actually resolved. A route carrying a non-Claude requestedModel with no
  // resolved model keeps provider/model null so the caller can reverse-map it.
  if (route.model) route.provider = route.provider || 'anthropic-oauth';
  route.modelDisplay = route.modelDisplay || displayClaudeModel(route.model, route.requestedModel || route.model);
  route.contextWindow = route.contextWindow || contextWindowFromRawModel(route.requestedModel || route.model, route.model);
  if (route.fast === null || route.fast === undefined) route.fast = false;
  return route;
}

export function writeClaudeCodeCurrentSnapshot(ccJsonInput) {
  if (!ccJsonInput) return null;
  let payload = null;
  try { payload = JSON.parse(String(ccJsonInput)); } catch { return null; }
  const route = routeFromPayload(payload, 'statusline');
  if (!route || (!route.model && !route.requestedModel)) return null;
  const file = path.join(pluginDataDir(), 'claude-current-model.json');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const st = fs.existsSync(file) ? fs.statSync(file) : null;
    const current = st ? readJsonFile(file) : null;
    if (
      st &&
      Date.now() - st.mtimeMs < SNAPSHOT_REFRESH_MS &&
      snapshotEquivalent(current, route)
    ) {
      return route;
    }
    fs.writeFileSync(file, JSON.stringify(route, null, 2) + '\n');
  } catch { /* best-effort statusline cache */ }
  return route;
}

export function formatClaudeCurrentChoiceLabel(route = readClaudeCodeCurrentRoute()) {
  const parts = [`Current selection: ${route.modelDisplay || route.model || 'current model'}`];
  if (route.effort) parts.push(String(route.effort).toUpperCase());
  if (route.fast === true) parts.push('fast');
  return parts.join(' · ');
}
