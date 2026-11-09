/*
 * components/status-line/gateway-status.mjs — which route the footer's quota status belongs to.
 *
 * Node's `configuredGatewayStatus` (src/vendor/statusline/bin/statusline-route.mjs) derived the provider and
 * model of the footer's primary status from the config's `gateway` section, the session-route store, the
 * requested `mixdog/<preset>` model and the Claude-current route; the footer used only that provider, model
 * and kind (plus the cached quota windows of the route). This is that derivation as a pure function of the
 * files' contents (footer-inputs.mjs reads them).
 */
const CLAUDE_CURRENT_MODE = 'claude-current';
const UUIDISH_SESSION_RE = /^[0-9a-z][0-9a-z._-]{7,}$/i;
const DEFAULT_FAMILY_MODEL = Object.freeze({
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
});
const EFFORT_BUDGET = Object.freeze({ low: 1024, medium: 4096, high: 16384, xhigh: 32768, max: 32768 });

const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const cleanOrNull = (value) => clean(value) || null;
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const numOr = (value, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const cleanBool = (value) => {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'fast', 'priority'].includes(s)) return true;
    if (['0', 'false', 'no', 'off', 'none'].includes(s)) return false;
  }
  return null;
};
const cleanBoolClaude = (value) => {
  if (value === true || value === false) return value;
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'fast', 'priority'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'standard'].includes(s)) return false;
  return null;
};

export const providerKindOf = (provider) => {
  const p = String(provider || '').toLowerCase();
  if (!p) return 'unknown';
  if (p.includes('oauth')) return 'oauth';
  if (p === 'mixdog-local') return 'local';
  return 'api';
};

/* ── presets ('mixdog/<preset>' requests) ───────────────────────────────────────────────────────────── */

function anthropicFamilyModel(family, env) {
  const key = String(family || '').toLowerCase();
  if (!key) return null;
  const fromEnv = env[`ANTHROPIC_DEFAULT_${key.toUpperCase()}_MODEL`];
  if (fromEnv) return fromEnv;
  return DEFAULT_FAMILY_MODEL[key] || null;
}

function defaultPresets(env) {
  const preset = (id, name, family, effort) => ({
    id,
    name,
    type: 'agent',
    provider: 'anthropic-oauth',
    model: anthropicFamilyModel(family, env),
    ...(effort ? { effort } : {}),
    tools: 'full',
  });
  return [
    preset('haiku', 'HAIKU', 'haiku'),
    preset('sonnet-mid', 'SONNET MID', 'sonnet', 'medium'),
    preset('sonnet-high', 'SONNET HIGH', 'sonnet', 'high'),
    preset('opus-mid', 'OPUS MID', 'opus', 'medium'),
    preset('opus-high', 'OPUS HIGH', 'opus', 'high'),
  ];
}

const presetKey = (p) => p?.id || p?.name || '';

function withDefaultPresets(stored, env) {
  const list = Array.isArray(stored) ? stored : [];
  const present = new Set(list.map(presetKey));
  return [...list, ...defaultPresets(env).filter((preset) => !present.has(preset.id))];
}

const slugSegment = (value) => {
  const s = clean(value);
  if (!s) return '';
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
};

function targetAliasId(target) {
  const base =
    slugSegment(target?.presetId) ||
    slugSegment(target?.presetName) ||
    (slugSegment(target?.provider) && slugSegment(target?.model)
      ? [slugSegment(target.provider), slugSegment(target.model), slugSegment(target.effort), target.fast === true ? 'fast' : null]
          .filter(Boolean)
          .join('-')
      : '');
  return base ? `mixdog/${base}` : '';
}

function resolveConfiguredModelTarget(cfg, rawModel, env) {
  const stripped = clean(rawModel).replace(/\[[^\]]+\]\s*$/, '');
  if (!stripped) return null;
  const lower = stripped.toLowerCase();
  const agent = isRecord(cfg?.agent) ? cfg.agent : {};
  const providers = isRecord(agent.providers) ? agent.providers : {};
  for (const p of withDefaultPresets(agent.presets, env)) {
    if (!isRecord(p) || !p.provider || !p.model) continue;
    const providerEntry = providers[p.provider];
    if (isRecord(providerEntry) && providerEntry.enabled === false) continue;
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

const isMixdogModelSelection = (value) => clean(typeof value === 'string' ? value : value?.requestedModel || value?.model || '').toLowerCase().startsWith('mixdog/');

/* ── the session-route store ────────────────────────────────────────────────────────────────────────── */

const normalizeSessionId = (value) => {
  const s = cleanOrNull(value);
  return !s || !UUIDISH_SESSION_RE.test(s) ? null : s;
};
const normalizePid = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const hostRouteKey = (sessionId, clientHostPid) => {
  const sid = normalizeSessionId(sessionId);
  const pid = normalizePid(clientHostPid);
  return sid && pid ? `${sid}#${pid}` : null;
};

function normalizeRouteSection(route = {}) {
  const mode = cleanOrNull(route.mode) || CLAUDE_CURRENT_MODE;
  const provider = cleanOrNull(route.defaultProvider ?? route.provider);
  const model = cleanOrNull(route.defaultModel ?? route.model);
  if (!provider || !model) return null;
  const out = { mode, defaultProvider: provider, defaultModel: model };
  for (const key of ['presetId', 'presetName', 'effort', 'displayEffort', 'modelDisplay']) {
    const value = cleanOrNull(route[key]);
    if (value) out[key] = value;
  }
  if (Object.hasOwn(route, 'fast')) {
    const fast = cleanBool(route.fast);
    if (fast !== null) out.fast = fast;
  }
  return out;
}

function routeWithMeta(route, sessionId, clientHostPid = null) {
  const normalized = normalizeRouteSection(route || {});
  if (!normalized) return null;
  const pid = normalizePid(clientHostPid ?? route?.clientHostPid);
  return { ...normalized, sessionId, ...(pid ? { clientHostPid: pid } : {}), updatedAt: route?.updatedAt || null };
}

function readSessionRoute(store, sessionId, { clientHostPid, fallbackLegacy }) {
  const sid = normalizeSessionId(sessionId);
  if (!sid) return null;
  const pid = normalizePid(clientHostPid);
  const hosts = isRecord(store?.sessionHosts) ? store.sessionHosts : {};
  if (pid) {
    const scoped = routeWithMeta(hosts[hostRouteKey(sid, pid)], sid, pid);
    if (scoped) return scoped;
    if (fallbackLegacy === true) return routeWithMeta(isRecord(store?.sessions) ? store.sessions[sid] : null, sid);
    return null;
  }
  return routeWithMeta(isRecord(store?.sessions) ? store.sessions[sid] : null, sid);
}

function readLatestHostRoute(store, clientHostPid, excludeSessionId) {
  const pid = normalizePid(clientHostPid);
  if (!pid) return null;
  const excludeSid = normalizeSessionId(excludeSessionId);
  const hosts = isRecord(store?.sessionHosts) ? store.sessionHosts : {};
  let best = null;
  let bestAt = -1;
  for (const route of Object.values(hosts)) {
    if (!route || typeof route !== 'object') continue;
    if (normalizePid(route.clientHostPid) !== pid) continue;
    const sid = normalizeSessionId(route.sessionId);
    if (!sid || (excludeSid && sid === excludeSid)) continue;
    const normalized = routeWithMeta(route, sid, pid);
    if (!normalized) continue;
    const at = Number(route.updatedAt) || 0;
    if (at >= bestAt) {
      best = normalized;
      bestAt = at;
    }
  }
  return best;
}

function sessionRouteFor(gateway, store, sessionId, clientHostPid) {
  const sid = clean(sessionId);
  if (!sid) return { route: gateway, sessionScoped: false };
  const route =
    readSessionRoute(store, sid, { clientHostPid, fallbackLegacy: true }) ||
    readLatestHostRoute(store, clientHostPid, sid);
  if (!route || typeof route !== 'object') return { route: gateway, sessionScoped: false };
  const provider = clean(route.defaultProvider || route.provider);
  const model = clean(route.defaultModel || route.model);
  if (!provider || !model) return { route: gateway, sessionScoped: false };
  return { route: { ...(gateway || {}), ...route, defaultProvider: provider, defaultModel: model }, sessionScoped: true };
}

/* ── the Claude-current route (provider, model and the request they came from) ──────────────────────── */

const stripClaudeContextSuffix = (model) => clean(model).replace(/\[[^\]]+\]\s*$/i, '');

function newestRosterModel(family, roster) {
  const stamp = (row) => Date.parse(row.releaseDate) || (Number(row.created) > 0 ? Number(row.created) : 0);
  const rows = (Array.isArray(roster) ? roster : [])
    .map((row) => ({ ...row, id: String(row?.id || row?.name || row?.slug || '').trim() }))
    .filter((row) => row.id && row.id.toLowerCase().startsWith(`claude-${family}-`));
  // providerCachedModelsSync keeps the first row of an id.
  const seen = new Set();
  const unique = rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
  unique.sort((a, b) => stamp(b) - stamp(a));
  return unique[0]?.id || null;
}

function familyDefaultModel(family, files) {
  const f = String(family || '').toLowerCase();
  if (!f) return null;
  return clean(files.env[`ANTHROPIC_DEFAULT_${f.toUpperCase()}_MODEL`]) || newestRosterModel(f, files.roster) || DEFAULT_FAMILY_MODEL[f] || null;
}

function resolveClaudeModelAlias(model, files) {
  const raw = clean(model);
  if (!raw) return null;
  const stripped = stripClaudeContextSuffix(raw);
  if (/^claude-/i.test(stripped)) return stripped;
  const family = stripped.match(/^(opus|sonnet|haiku|fable)(?:[-_].*)?$/i)?.[1]?.toLowerCase();
  if (family) return familyDefaultModel(family, files);
  return null;
}

const normalizeEffort = (v) => {
  const s = clean(v).toLowerCase();
  if (!s) return null;
  if (s === 'extra-high' || s === 'very-high') return 'xhigh';
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(s) ? s : null;
};

function effortFromThinking(thinking) {
  if (!thinking || typeof thinking !== 'object') return null;
  const t = clean(thinking.type).toLowerCase();
  if (t && t !== 'enabled') return null;
  const budget = numOr(thinking.budget_tokens ?? thinking.budgetTokens);
  if (!(budget > 0)) return null;
  let best = null;
  let bestDelta = Infinity;
  for (const [effort, value] of Object.entries(EFFORT_BUDGET)) {
    const delta = Math.abs(value - budget);
    if (delta < bestDelta) {
      best = effort;
      bestDelta = delta;
    }
  }
  return best;
}

function fastFromPayload(payload) {
  const direct = cleanBoolClaude(payload?.fast_mode) ?? cleanBoolClaude(payload?.fastMode) ?? cleanBoolClaude(payload?.fast);
  if (direct !== null) return direct;
  const speed = clean(payload?.speed || payload?.service_tier || payload?.serviceTier).toLowerCase();
  if (speed === 'fast' || speed === 'priority') return true;
  if (speed === 'standard' || speed === 'default') return false;
  return null;
}

function routeFromPayload(payload, files) {
  if (!payload || typeof payload !== 'object') return null;
  const modelObj = isRecord(payload.model) ? payload.model : null;
  const rawModel = clean(modelObj?.id) || clean(payload.model) || clean(payload.request?.model) || clean(payload.message?.model);
  const model = resolveClaudeModelAlias(rawModel, files);
  const effort = normalizeEffort(payload.effort?.level) || normalizeEffort(payload.effortLevel) || effortFromThinking(payload.thinking);
  const fast = fastFromPayload(payload);
  const thinkingBudgetTokens = numOr(payload.thinking?.budget_tokens ?? payload.thinking?.budgetTokens);
  if (!model && !rawModel && !effort && fast === null && !(thinkingBudgetTokens > 0)) return null;
  return { provider: model ? 'anthropic-oauth' : null, model, requestedModel: rawModel || null };
}

function mergeRoute(base, next) {
  if (!next) return base || null;
  if (!base) return { ...next };
  const nextRequested = clean(next.requestedModel);
  const baseRequested = clean(base.requestedModel);
  const requestSupersedes = Boolean(nextRequested) && nextRequested !== baseRequested;
  return {
    ...base,
    ...next,
    provider: requestSupersedes ? (next.provider ?? null) : next.provider || base.provider,
    model: requestSupersedes ? (next.model ?? null) : next.model || base.model,
    requestedModel: next.requestedModel || base.requestedModel,
  };
}

function readClaudeCodeCurrentRoute(files) {
  const settings = files.claude.settings;
  let route = null;
  if (isRecord(settings)) {
    route = routeFromPayload(
      { model: clean(settings.model), effortLevel: settings.effortLevel, fast_mode: settings.fastMode ?? settings.fast_mode ?? settings.fast },
      files
    );
  }
  const own = files.claude.own;
  const persisted = own && own.mode === CLAUDE_CURRENT_MODE ? own : routeFromPayload(files.claude.last, files);
  route = mergeRoute(route, persisted);
  route = mergeRoute(route, null);
  if (!route) {
    route = { provider: 'anthropic-oauth', model: familyDefaultModel('opus', files), requestedModel: 'opus' };
  }
  if (route.model) route.provider = route.provider || 'anthropic-oauth';
  return route;
}

/* ── the status ─────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The provider and model of the footer's primary status, or null when the gateway gives it none.
 * `args` are the statusline arguments; `files` the contents of `config` (the parts read), `sessionRoutes`,
 * `settingsModel`, `claude` ({ settings, own, last }), `roster` and `env`.
 */
export function configuredGatewayRoute(args, files) {
  const cfg = files.config;
  const gatewayBase = isRecord(cfg?.gateway) ? cfg.gateway : {};
  let { route: gateway, sessionScoped } = sessionRouteFor(gatewayBase, files.sessionRoutes, args.sessionId, args.clientHostPid);
  const currentProvider = clean(args.provider);
  const currentModel = clean(args.model);
  if ((!clean(gateway?.defaultProvider) || !clean(gateway?.defaultModel)) && currentProvider && currentModel) {
    gateway = {
      ...(gateway || {}),
      mode: clean(gateway?.mode) || 'fixed',
      defaultProvider: currentProvider,
      defaultModel: currentModel,
    };
  }
  const modules = isRecord(cfg?.modules) ? cfg.modules : {};
  if (modules.gateway && modules.gateway.enabled === false) return null;
  const inherit = clean(gateway.mode) === CLAUDE_CURRENT_MODE;
  const inherited = inherit ? readClaudeCodeCurrentRoute(files) : null;
  const explicitRequestedModel =
    (isMixdogModelSelection(currentModel) ? currentModel : '') ||
    (!sessionScoped && isMixdogModelSelection(clean(files.settingsModel)) ? clean(files.settingsModel) : '');
  let aliasTarget = explicitRequestedModel ? resolveConfiguredModelTarget(cfg, explicitRequestedModel, files.env) : null;
  if (explicitRequestedModel && !aliasTarget) return null;
  let provider = inherit ? clean(inherited?.provider) || clean(gateway.defaultProvider) : clean(gateway.defaultProvider);
  let model = inherit ? clean(inherited?.model) || clean(gateway.defaultModel) : clean(gateway.defaultModel);
  if (!aliasTarget && inherit && !clean(inherited?.provider) && clean(inherited?.requestedModel)) {
    aliasTarget = resolveConfiguredModelTarget(cfg, inherited.requestedModel, files.env);
  }
  if (aliasTarget) {
    provider = aliasTarget.provider;
    model = aliasTarget.model;
  }
  if (!provider || !model) return null;
  return { provider, model, providerKind: providerKindOf(provider) };
}
