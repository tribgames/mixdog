// Config normalization helpers: default provider, presets/routes, module
// enable flags, shell/auto-clear/compaction config, and duration formatting.
import { clean, hasOwn } from './session-text.mjs';
import { normalizeEffortInput, normalizeSavedEffort } from './effort.mjs';
import { routeFastKey, fastPreferenceFor } from './model-capabilities.mjs';
import { normalizeContextTokens } from '../../../shared/llm/default-context-window.mjs';
import { normalizeCompactionSummaryMode } from '../session/compact/summary-mode.mjs';

const DEFAULT_PROVIDER = 'anthropic-oauth';
export const DEFAULT_MODEL = '';

// Resolve a provider-less MAIN selector against the selected Main preset.
// DEFAULT_PROVIDER is only the unconfigured bootstrap fallback (model remains
// empty); agent/search override resolution never calls this to synthesize one.
export function makeResolveDefaultProvider(isKnownProvider) {
  return function resolveDefaultProvider(config) {
    const selectedMain = findPreset(config, config?.default);
    const configured = clean(selectedMain?.provider);
    if (configured && isKnownProvider(configured, config)) return configured;
    return DEFAULT_PROVIDER;
  };
}

export function modelSettingsFor(config, provider, model) {
  const key = routeFastKey(provider, model);
  const value = key ? config?.modelSettings?.[key] : null;
  return value && typeof value === 'object' ? value : {};
}

export function findPreset(config, key) {
  const wanted = clean(key).toLowerCase();
  if (!wanted) return null;
  const presets = Array.isArray(config?.presets) ? config.presets : [];
  return (
    presets.find((p) => {
      const id = clean(p?.id).toLowerCase();
      const name = clean(p?.name).toLowerCase();
      return id === wanted || name === wanted;
    }) || null
  );
}

function cleanModelParameters(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => [clean(key), clean(entry)])
      .filter(([key, entry]) => key && entry)
  );
}

function cleanContextPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent <= 0) return undefined;
  return Math.max(10, Math.min(100, Math.round(percent / 10) * 10));
}

/** The route's exact window in tokens: an explicit request, else none when a
 *  percent is chosen instead, else the saved or preset selection. */
function resolveContextTokens({ contextTokens, hasExplicitContextPercent, saved, preset = null }) {
  if (contextTokens !== undefined) return normalizeContextTokens(contextTokens);
  if (hasExplicitContextPercent) return undefined;
  return normalizeContextTokens(saved.contextTokens ?? preset?.contextTokens);
}

/** The route's fast flag: an explicit request, else the saved choice, else the preset or the provider preference. */
function resolveFast({ hasExplicitFast, explicitFast, saved, presetFast = false, preference }) {
  if (hasExplicitFast) return explicitFast;
  if (hasOwn(saved, 'fast')) return saved.fast === true;
  return presetFast || preference();
}

/** The route's Auto effort flag: an explicit request, else the saved choice,
 *  else the preset. Absent means on; only `false` turns it off. */
function resolveAutoEffort({ autoEffort, saved, preset = null }) {
  if (autoEffort !== undefined) return autoEffort !== false;
  if (hasOwn(saved, 'autoEffort')) return saved.autoEffort !== false;
  return preset?.autoEffort !== false;
}

/** The route's context percent: an explicit request, else the saved choice
 *  (read lazily) unless an exact token selection replaced it. */
function resolveContextPercent({ hasExplicitContextPercent, contextPercent, keepsSavedPercent, savedPercent }) {
  if (hasExplicitContextPercent) return cleanContextPercent(contextPercent);
  if (keepsSavedPercent) return cleanContextPercent(savedPercent());
  return undefined;
}

export function makeResolveRoute(resolveDefaultProvider) {
  return function resolveRoute(
    config,
    { provider, model, effort, fast, autoEffort, modelParameters, contextPercent, contextTokens } = {}
  ) {
    const explicitProvider = clean(provider);
    const explicitModel = clean(model);
    const hasExplicitEffort = effort !== undefined;
    const explicitEffort = hasExplicitEffort ? normalizeEffortInput(effort) : undefined;
    const hasExplicitFast = fast !== undefined;
    const explicitFast = fast === true;
    const hasExplicitModelParameters = modelParameters !== undefined;
    const hasExplicitContextPercent = contextPercent !== undefined;
    // An exact token selection replaces a saved percent unless a percent is
    // requested alongside it.
    const keepsSavedPercent = contextTokens === undefined;

    if (!explicitProvider) {
      const preset = findPreset(config, explicitModel || config?.default);
      if (preset) {
        const p = clean(preset.provider);
        const m = clean(preset.model) || DEFAULT_MODEL;
        if (p && m) {
          const saved = modelSettingsFor(config, p, m);
          const tokens = resolveContextTokens({ contextTokens, hasExplicitContextPercent, saved, preset });
          return {
            provider: p,
            model: m,
            preset,
            effort: hasExplicitEffort ? explicitEffort : normalizeSavedEffort(saved.effort ?? preset.effort),
            fast: resolveFast({
              hasExplicitFast,
              explicitFast,
              saved,
              presetFast: preset.fast === true,
              preference: () => fastPreferenceFor(config, p, m),
            }),
            autoEffort: resolveAutoEffort({ autoEffort, saved, preset }),
            modelParameters: hasExplicitModelParameters
              ? cleanModelParameters(modelParameters)
              : cleanModelParameters(saved.modelParameters ?? preset.modelParameters),
            contextPercent: resolveContextPercent({
              hasExplicitContextPercent,
              contextPercent,
              keepsSavedPercent,
              savedPercent: () => saved.contextPercent ?? preset.contextPercent,
            }),
            ...(tokens ? { contextTokens: tokens } : {}),
          };
        }
      }
    }

    const p = explicitProvider || resolveDefaultProvider(config);
    const m = explicitModel || DEFAULT_MODEL;
    const saved = modelSettingsFor(config, p, m);
    const tokens = resolveContextTokens({ contextTokens, hasExplicitContextPercent, saved });
    return {
      provider: p,
      model: m,
      preset: null,
      effort: hasExplicitEffort ? explicitEffort : normalizeSavedEffort(saved.effort),
      fast: resolveFast({ hasExplicitFast, explicitFast, saved, preference: () => fastPreferenceFor(config, p, m) }),
      autoEffort: resolveAutoEffort({ autoEffort, saved }),
      modelParameters: hasExplicitModelParameters
        ? cleanModelParameters(modelParameters)
        : cleanModelParameters(saved.modelParameters),
      contextPercent: resolveContextPercent({
        hasExplicitContextPercent,
        contextPercent,
        keepsSavedPercent,
        savedPercent: () => saved.contextPercent,
      }),
      ...(tokens ? { contextTokens: tokens } : {}),
    };
  };
}

export function isLikelyRawModelId(value) {
  const model = clean(value);
  if (!model || model.length > 160) return false;
  if (/\s/.test(model)) return false;
  // OpenRouter's rolling model aliases start with a literal "~".
  return /^~?[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(model);
}

export function validateRequestedModelSelector(config, requested = {}) {
  const model = clean(requested.model);
  if (!model) return;
  if (findPreset(config, model)) return;
  if (isLikelyRawModelId(model)) return;
  throw new Error(
    `Invalid model selector "${model}". Use a preset or a model id; free-form text cannot be used as a model.`
  );
}

export function ensureProviderEnabled(config, provider) {
  const providers = { ...(config?.providers || {}) };
  providers[provider] = { ...(providers[provider] || {}), enabled: true };
  return providers;
}

const AUTO_CLEAR_DEFAULT_IDLE_MS = 60 * 60 * 1000;

// Provider-aware auto-clear idle-sweep defaults. Rationale mirrors the
// provider cache TTLs documented in agent-runtime/cache-strategy.mjs
// (explicit breakpoint / managed-cache windows): Anthropic follows the Lead's
// 1h BP4 messages-tail TTL. The 2026-07-16 6.8h trace found no intra-session
// gaps over 1h, and 24/25 Lead gaps over 5m were agent waits where autoClear
// cannot fire. Tail-cost simulation favors a 1h Lead tail despite its 2x write
// premium (11.75M vs 20.11M input-token equivalents), because cold misses
// rewrite the accumulated tail. Anthropic agent tails are 5m and compact once
// expired; their terminal reap keeps this 1h window so a completed agent stays
// reusable. Gemini, xAI and Mistral
// caches run ~1h, Groq's implicit cache persists ~2h, and DeepSeek's
// implicit cache is evicted after "a few hours to a few days" (kept at 24h).
// OpenAI public API (GPT-5.6+ Responses, cache-strategy.mjs): the moving tail
// is written with ttl "30m" and only the Lead-class stable prefix with "12h",
// so the sweep matches the 30m tail — a clear after that costs nothing extra
// (the tail is cold anyway) and the cleared session restarts on the warm 12h
// prefix. Earlier OpenAI models (prompt_cache_retention, typically ~30 min)
// are not distinguished: these call sites only know the provider.
// OpenAI OAuth (Codex/ChatGPT login) keeps the cache of logged-in users
// indefinitely (2026-10-20), so its built-in window is unlimited: no idle
// clear; compaction happens only at the context limit or on request.
// Unknown/unrecognized providers fall back to the 'default' 1h entry.
//
// Unlimited ("never auto-clear") is stored as 0 in providerIdleMs — a value
// older builds dropped, so no older config carries it — and resolves to
// AUTO_CLEAR_UNLIMITED_MS, which every idle comparison treats as never
// reached. Input also accepts 'unlimited' / 'never'.
export const AUTO_CLEAR_UNLIMITED = 0;
export const AUTO_CLEAR_UNLIMITED_MS = Number.MAX_SAFE_INTEGER;
const AUTO_CLEAR_PROVIDER_IDLE_MS = Object.freeze({
  anthropic: 60 * 60 * 1000,
  'anthropic-oauth': 60 * 60 * 1000,
  gemini: 60 * 60 * 1000,
  groq: 2 * 60 * 60 * 1000,
  openai: 30 * 60 * 1000,
  deepseek: 24 * 60 * 60 * 1000,
  xai: 60 * 60 * 1000,
  'openai-oauth': AUTO_CLEAR_UNLIMITED,
  mistral: 60 * 60 * 1000,
  default: AUTO_CLEAR_DEFAULT_IDLE_MS,
});
const AUTO_CLEAR_PROVIDER_IDS = Object.freeze(Object.keys(AUTO_CLEAR_PROVIDER_IDLE_MS));

// Completed-agent retention where it must differ from the idle window. Reap
// frees in-memory sessions and worker-index rows (resources), so it stays
// finite even where the cache is permanent: openai-oauth uses the 1h product
// default, which covers Lead follow-ups (24/25 Lead waits were 5–27 min).
const AGENT_TERMINAL_REAP_MS = Object.freeze({ 'openai-oauth': 60 * 60 * 1000 });

/** A stored/requested idle value: AUTO_CLEAR_UNLIMITED, a window ≥ 1 min, or
 *  null when absent or invalid. */
export function normalizeAutoClearIdleValue(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (!text) return null;
    if (text === 'unlimited' || text === 'never') return AUTO_CLEAR_UNLIMITED;
  }
  const idleMs = Number(value);
  if (!Number.isFinite(idleMs) || idleMs < 0) return null;
  if (idleMs === 0) return AUTO_CLEAR_UNLIMITED;
  return Math.max(60_000, Math.round(idleMs));
}

const resolvedIdleMs = (stored) => (stored === AUTO_CLEAR_UNLIMITED ? AUTO_CLEAR_UNLIMITED_MS : stored);

/** Whether a resolved idle window means "never auto-clear". */
export function isAutoClearUnlimited(idleMs) {
  return Number(idleMs) >= AUTO_CLEAR_UNLIMITED_MS;
}

function normalizeAutoClearProviderIdleMs(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const [key, ms] of Object.entries(raw)) {
    const provider = clean(key).toLowerCase();
    const idleMs = normalizeAutoClearIdleValue(ms);
    if (!provider || idleMs === null) continue;
    out[provider] = idleMs;
  }
  return out;
}

// Resolve the auto-clear idle-sweep threshold for a given provider id.
// Unknown/missing providers fall back to the 'default' 1h entry (above).
export function autoClearIdleMsForProvider(provider, providerIdleMs = null) {
  const overrides = normalizeAutoClearProviderIdleMs(providerIdleMs);
  const key = clean(provider).toLowerCase();
  if (key && Object.hasOwn(overrides, key)) return resolvedIdleMs(overrides[key]);
  if (key && Object.hasOwn(AUTO_CLEAR_PROVIDER_IDLE_MS, key)) return resolvedIdleMs(AUTO_CLEAR_PROVIDER_IDLE_MS[key]);
  if (Object.hasOwn(overrides, 'default')) return resolvedIdleMs(overrides.default);
  return AUTO_CLEAR_PROVIDER_IDLE_MS.default;
}

// One row per built-in provider plus every provider in `extraProviders` (the
// providers the user has enabled or routes to), before the 'default' row.
// A provider without a built-in entry resolves like any unknown provider.
export function autoClearProviderDefaults(providerIdleMs = null, extraProviders = []) {
  const overrides = normalizeAutoClearProviderIdleMs(providerIdleMs);
  const ids = AUTO_CLEAR_PROVIDER_IDS.filter((id) => id !== 'default');
  for (const value of extraProviders || []) {
    const id = clean(value).toLowerCase();
    if (id && !ids.includes(id) && id !== 'default') ids.push(id);
  }
  for (const id of Object.keys(overrides)) if (!ids.includes(id) && id !== 'default') ids.push(id);
  ids.push('default');
  return ids.map((provider) => {
    const builtIn = Object.hasOwn(AUTO_CLEAR_PROVIDER_IDLE_MS, provider)
      ? AUTO_CLEAR_PROVIDER_IDLE_MS[provider]
      : AUTO_CLEAR_PROVIDER_IDLE_MS.default;
    let idleMs;
    if (Object.hasOwn(overrides, provider)) idleMs = resolvedIdleMs(overrides[provider]);
    else if (provider === 'default' || Object.hasOwn(AUTO_CLEAR_PROVIDER_IDLE_MS, provider)) {
      idleMs = resolvedIdleMs(builtIn);
    } else idleMs = autoClearIdleMsForProvider(provider, overrides);
    return {
      provider,
      idleMs,
      builtInMs: resolvedIdleMs(builtIn),
      unlimited: isAutoClearUnlimited(idleMs),
      builtInUnlimited: builtIn === AUTO_CLEAR_UNLIMITED,
      custom: Object.hasOwn(overrides, provider),
    };
  });
}

// Agent terminal retention is deliberately narrower than Auto Clear's general
// resolution: listed providers use their provider cache lifetime, or the
// finite AGENT_TERMINAL_REAP_MS entry where that cache is permanent. Unlisted
// providers use the Advanced "default" row, or the built-in default when no
// override is configured, so completed agents are still eventually reclaimed;
// an unlimited override never disables reaping.
export function resolveAgentTerminalReapMs(config, provider) {
  const key = clean(provider).toLowerCase();
  const raw = config?.autoClear && typeof config.autoClear === 'object' ? config.autoClear : {};
  const overrides = normalizeAutoClearProviderIdleMs(raw.providerIdleMs);
  const finite = (value) => (value > 0 ? value : null);
  if (!key || key === 'default' || !Object.hasOwn(AUTO_CLEAR_PROVIDER_IDLE_MS, key)) {
    return finite(overrides.default) ?? AUTO_CLEAR_PROVIDER_IDLE_MS.default;
  }
  return finite(overrides[key]) ?? AGENT_TERMINAL_REAP_MS[key] ?? AUTO_CLEAR_PROVIDER_IDLE_MS[key];
}

// Resolve the effective auto-clear idle window for a config + provider:
// a provider-specific override (autoClear.providerIdleMs[provider]) wins;
// else the global user-set idleMs (autoClear.idleMs); else the provider's
// built-in window, then providerIdleMs.default / the built-in 1h default.
// Unlimited resolves to AUTO_CLEAR_UNLIMITED_MS.
export function resolveAutoClearIdleMs(config, provider) {
  const raw = config?.autoClear && typeof config.autoClear === 'object' ? config.autoClear : {};
  const key = clean(provider).toLowerCase();
  const overrides = normalizeAutoClearProviderIdleMs(raw.providerIdleMs);
  if (key && key !== 'default' && Object.hasOwn(overrides, key)) return resolvedIdleMs(overrides[key]);
  const idleMs = Number(raw.idleMs);
  if (Number.isFinite(idleMs) && idleMs > 0) return Math.max(60_000, Math.round(idleMs));
  return autoClearIdleMsForProvider(provider, raw.providerIdleMs);
}

/** The idle auto-clear gate's settings for a thread on `provider`
 *  (idle-auto-clear-gate.mjs): `{ enabled, idleMs, minContextPercent }`. */
export function autoClearGateSettings(config, provider) {
  const normalized = normalizeAutoClearConfig(config?.autoClear);
  return {
    enabled: normalized.enabled,
    idleMs: resolveAutoClearIdleMs(config, provider),
    minContextPercent: normalized.minContextPercent,
  };
}

export function normalizeSystemShellConfig(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const command = clean(raw.command);
  const envCommand = clean(process.env.MIXDOG_SHELL);
  let source = 'auto';
  if (command) source = 'config';
  else if (envCommand) source = 'env';
  return {
    command,
    effective: command || envCommand || '',
    source,
  };
}

export function normalizeSystemShellCommand(value) {
  const command = clean(value)
    .replace(/^auto$/i, '')
    .replace(/^['"](.+)['"]$/, '$1')
    .trim();
  if (!command) return '';
  if (process.platform === 'win32') {
    const stem = command
      .split(/[\\/]/)
      .pop()
      .toLowerCase()
      .replace(/\.exe$/, '');
    if (stem !== 'powershell' && stem !== 'pwsh') {
      throw new Error('system shell command must be powershell.exe or pwsh on Windows');
    }
  }
  return command;
}

export function normalizeAutoClearConfig(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const idleMs = Number(raw.idleMs);
  const hasExplicitIdle = Number.isFinite(idleMs) && idleMs > 0;
  const rawMinPct = Number(raw.minContextPercent);
  const minContextPercent = Number.isFinite(rawMinPct) ? Math.min(100, Math.max(0, Math.round(rawMinPct))) : 10;
  // idleMs: null means "no explicit override" — callers resolve the
  // effective window via resolveAutoClearIdleMs/provider default. `custom`
  // tells UI whether the stored idleMs is a user override (true) or the
  // provider-default mode (false, idleMs null).
  return {
    enabled: raw.enabled !== false,
    idleMs: hasExplicitIdle ? Math.max(60_000, Math.round(idleMs)) : null,
    custom: hasExplicitIdle,
    providerIdleMs: normalizeAutoClearProviderIdleMs(raw.providerIdleMs),
    minContextPercent,
  };
}

export function normalizeCompactionConfig(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const next = { ...raw };
  if (!next.summaryModel && raw.semanticModel) next.summaryModel = raw.semanticModel;
  if (!next.memoryTimeoutMs && raw.recallMemoryTimeoutMs) next.memoryTimeoutMs = raw.recallMemoryTimeoutMs;
  delete next.type;
  delete next.compactType;
  delete next.compact_type;
  delete next.semantic;
  delete next.semanticModel;
  delete next.prune;
  delete next.tailTurns;
  delete next.recallMemoryTimeoutMs;
  delete next.recallIngestLimit;
  delete next.recallChunkLimit;
  delete next.recallLimit;
  delete next.recallCycle1BatchSize;
  delete next.recallRowsPerSession;
  delete next.recallWindowSize;
  delete next.recallConcurrency;
  delete next.recallCycle1DeadlineMs;
  delete next.enabled;
  delete next.useMaintainer;
  return {
    ...next,
    auto: raw.auto !== false && raw.enabled !== false,
    // Compact a conversation on its current model before switching it to
    // another one in place (default on).
    onModelChange: raw.onModelChange !== false,
    // Which model writes compaction summaries (smart / maintainer / self);
    // replaces the previous release's boolean useMaintainer.
    summaryMode: normalizeCompactionSummaryMode(raw),
  };
}

// A config section disables its feature only with an explicit `enabled: false`.
function sectionEnabled(entry, fallback) {
  if (entry && typeof entry === 'object' && entry.enabled === false) return false;
  return fallback !== false;
}

export function moduleEnabled(configLike, name, fallback = true) {
  return sectionEnabled(configLike?.modules?.[name], fallback);
}

// Recap toggle: gates ONLY the background memory cycles (1/2/3). The memory
// module itself (transcript watcher/ingest, on-demand recall/fasttrack drains)
// is always-on. Default enabled. Reads the dedicated `recap` section; if a
// legacy `modules.memory === false` flag is present it is honored as recap off
// (migration folds it into `recap.enabled` on config load).
export function recapEnabled(configLike, fallback = true) {
  return sectionEnabled(configLike?.recap, fallback);
}

export function setRecapEnabledInConfig(configLike, enabled) {
  const next = { ...(configLike || {}) };
  next.recap = { ...(next.recap || {}), enabled: enabled !== false };
  // Drop the legacy flag if it was carrying the disabled state.
  if (next.modules && next.modules.memory === false) {
    const modules = { ...next.modules };
    delete modules.memory;
    next.modules = modules;
  } else if (next.modules?.memory && typeof next.modules.memory === 'object') {
    const modules = { ...next.modules };
    const memoryMod = { ...modules.memory };
    delete memoryMod.enabled;
    if (Object.keys(memoryMod).length === 0) delete modules.memory;
    else modules.memory = memoryMod;
    next.modules = modules;
  }
  return next;
}

// Memory tools toggle (general option, deliberately NOT an agent module key):
// gates only the model-facing memory tool surface (`memory` writes + `recall`
// retrieval) for NEW sessions. Background ingest/watcher and user-curated core
// memory stay always-on; the recap toggle above stays cycles-only. Default on.
export function memoryToolsEnabled(configLike, fallback = true) {
  return sectionEnabled(configLike?.memoryTools, fallback);
}

export function setMemoryToolsEnabledInConfig(configLike, enabled) {
  const next = { ...(configLike || {}) };
  next.memoryTools = { ...(next.memoryTools || {}), enabled: enabled !== false };
  return next;
}

// Headless/bench feature override: an explicit MIXDOG_FEATURE_* env value wins
// over the stored config toggle for THIS process only (never persisted).
// Unset/empty → null (config decides).
export function featureEnvOverride(name) {
  const raw = String(process.env[name] ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}

export function setModuleEnabledInConfig(configLike, name, enabled) {
  const next = { ...(configLike || {}) };
  next.modules = { ...(next.modules || {}) };
  next.modules[name] = {
    ...(next.modules[name] || {}),
    enabled: enabled !== false,
  };
  return next;
}

export function formatDurationMs(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value % 3_600_000 === 0) return `${value / 3_600_000}h`;
  if (value % 60_000 === 0) return `${value / 60_000}m`;
  return `${Math.round(value / 1000)}s`;
}

export function parseDurationMs(input) {
  const text = clean(input).toLowerCase();
  if (!text) return null;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = match[2] || 'm';
  let mult = 1;
  if (unit === 'h') mult = 3_600_000;
  else if (unit === 'm') mult = 60_000;
  else if (unit === 's') mult = 1000;
  return Math.max(60_000, Math.round(n * mult));
}

// A resolved model meta carries catalog-derived fields (contextWindow, pricing,
// capabilities, …). The lookupModelMeta() fallback for an unknown id is the
// bare shape `{ id, provider }`, so "more than id/provider" reliably tells a
// real catalog hit apart from that placeholder.
export function modelMetaLooksResolved(meta) {
  if (!meta || typeof meta !== 'object') return false;
  return Object.keys(meta).some((key) => key !== 'id' && key !== 'provider');
}
