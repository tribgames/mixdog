// Config normalization helpers: default provider, presets/routes, module
// enable flags, shell/auto-clear/compaction config, and duration formatting.
import { clean, hasOwn } from './session-text.mjs';
import { normalizeEffortInput, normalizeSavedEffort } from './effort.mjs';
import { routeFastKey, fastPreferenceFor } from './model-capabilities.mjs';

export const DEFAULT_PROVIDER = 'anthropic-oauth';
export const DEFAULT_MODEL = '';

// Resolve a provider-less MAIN selector against the selected Main preset.
// DEFAULT_PROVIDER is only the unconfigured bootstrap fallback (model remains
// empty); agent/search override resolution never calls this to synthesize one.
export function makeResolveDefaultProvider(isKnownProvider) {
  return function resolveDefaultProvider(config) {
    const selectedMain = findPreset(config, config?.default);
    const configured = clean(selectedMain?.provider);
    if (configured && isKnownProvider(configured)) return configured;
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
  return presets.find((p) => {
    const id = clean(p?.id).toLowerCase();
    const name = clean(p?.name).toLowerCase();
    return id === wanted || name === wanted;
  }) || null;
}

function cleanModelParameters(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([key, entry]) => [clean(key), clean(entry)])
    .filter(([key, entry]) => key && entry));
}

function cleanContextPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent <= 0) return undefined;
  return Math.max(10, Math.min(100, Math.round(percent / 10) * 10));
}

export function makeResolveRoute(resolveDefaultProvider) {
  return function resolveRoute(config, { provider, model, effort, fast, modelParameters, contextPercent } = {}) {
    const explicitProvider = clean(provider);
    const explicitModel = clean(model);
    const hasExplicitEffort = effort !== undefined;
    const explicitEffort = hasExplicitEffort ? normalizeEffortInput(effort) : undefined;
    const hasExplicitFast = fast !== undefined;
    const explicitFast = fast === true;
    const hasExplicitModelParameters = modelParameters !== undefined;
    const hasExplicitContextPercent = contextPercent !== undefined;

    if (explicitModel && !explicitProvider) {
      const preset = findPreset(config, explicitModel);
      if (preset) {
        const p = clean(preset.provider);
        const m = clean(preset.model) || DEFAULT_MODEL;
        if (p && m) {
          const saved = modelSettingsFor(config, p, m);
          return {
            provider: p,
            model: m,
            preset,
            effort: hasExplicitEffort ? explicitEffort : normalizeSavedEffort(saved.effort ?? preset.effort),
            fast: hasExplicitFast ? explicitFast : (hasOwn(saved, 'fast') ? saved.fast === true : (preset.fast === true || fastPreferenceFor(config, p, m))),
            modelParameters: hasExplicitModelParameters
              ? cleanModelParameters(modelParameters)
              : cleanModelParameters(saved.modelParameters ?? preset.modelParameters),
            contextPercent: hasExplicitContextPercent
              ? cleanContextPercent(contextPercent)
              : cleanContextPercent(saved.contextPercent ?? preset.contextPercent),
          };
        }
      }
    }

    if (!explicitProvider && !explicitModel) {
      const defaultKey = config?.default;
      const preset = findPreset(config, defaultKey);
      if (preset) {
        const p = clean(preset.provider);
        const m = clean(preset.model) || DEFAULT_MODEL;
        if (p && m) {
          const saved = modelSettingsFor(config, p, m);
          return {
            provider: p,
            model: m,
            preset,
            effort: hasExplicitEffort ? explicitEffort : normalizeSavedEffort(saved.effort ?? preset.effort),
            fast: hasExplicitFast ? explicitFast : (hasOwn(saved, 'fast') ? saved.fast === true : (preset.fast === true || fastPreferenceFor(config, p, m))),
            modelParameters: hasExplicitModelParameters
              ? cleanModelParameters(modelParameters)
              : cleanModelParameters(saved.modelParameters ?? preset.modelParameters),
            contextPercent: hasExplicitContextPercent
              ? cleanContextPercent(contextPercent)
              : cleanContextPercent(saved.contextPercent ?? preset.contextPercent),
          };
        }
      }
    }

    const p = explicitProvider || resolveDefaultProvider(config);
    const m = explicitModel || DEFAULT_MODEL;
    const saved = modelSettingsFor(config, p, m);
    return {
      provider: p,
      model: m,
      preset: null,
      effort: hasExplicitEffort ? explicitEffort : normalizeSavedEffort(saved.effort),
      fast: hasExplicitFast ? explicitFast : (hasOwn(saved, 'fast') ? saved.fast === true : fastPreferenceFor(config, p, m)),
      modelParameters: hasExplicitModelParameters
        ? cleanModelParameters(modelParameters)
        : cleanModelParameters(saved.modelParameters),
      contextPercent: hasExplicitContextPercent
        ? cleanContextPercent(contextPercent)
        : cleanContextPercent(saved.contextPercent),
    };
  };
}

export function isLikelyRawModelId(value) {
  const model = clean(value);
  if (!model || model.length > 160) return false;
  if (/\s/.test(model)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(model);
}

export function validateRequestedModelSelector(config, requested = {}) {
  const model = clean(requested.model);
  if (!model) return;
  if (findPreset(config, model)) return;
  if (isLikelyRawModelId(model)) return;
  throw new Error(`Invalid model selector "${model}". Use a preset or a model id; free-form text cannot be used as a model.`);
}

export function ensureProviderEnabled(config, provider) {
  const providers = { ...(config?.providers || {}) };
  providers[provider] = { ...(providers[provider] || {}), enabled: true };
  return providers;
}

const AUTO_CLEAR_DEFAULT_IDLE_MS = 60 * 60 * 1000;

// Provider-aware auto-clear idle-sweep defaults. Rationale mirrors the
// provider cache TTLs documented in agent-runtime/cache-strategy.mjs
// (explicit breakpoint / managed-cache windows): Anthropic follows the 1h BP4
// messages-tail TTL. The 2026-07-16 6.8h trace found no intra-session gaps
// over 1h; gaps over 5m were common for agent tool executions/reviewer
// fix-loop reuse, and 24/25 such Lead gaps were agent waits where autoClear
// cannot fire. Tail-cost simulation favors 1h despite its 2x write premium:
// Lead 11.75M vs 20.11M and agents 14.46M vs 45.04M input-token equivalents,
// because cold misses rewrite the accumulated tail. Gemini, xAI and Mistral
// caches run ~1h, Groq's implicit cache persists ~2h, OpenAI/DeepSeek
// key-prefix/implicit caches persist far longer (~24h), and OpenAI OAuth
// (Codex backend) guarantees a 30-minute minimum prompt-cache TTL on
// GPT-5.6+ models (prompt_cache_options.ttl=30m, refreshed on use), so the
// sweep matches that window to avoid clearing a still-warm cache.
// Unknown/unrecognized providers fall back to the 'default' 1h entry.
export const AUTO_CLEAR_PROVIDER_IDLE_MS = Object.freeze({
  'anthropic': 60 * 60 * 1000,
  'anthropic-oauth': 60 * 60 * 1000,
  'gemini': 60 * 60 * 1000,
  'groq': 2 * 60 * 60 * 1000,
  'openai': 24 * 60 * 60 * 1000,
  'deepseek': 24 * 60 * 60 * 1000,
  'xai': 60 * 60 * 1000,
  'openai-oauth': 30 * 60 * 1000,
  'mistral': 60 * 60 * 1000,
  'default': AUTO_CLEAR_DEFAULT_IDLE_MS,
});
const AUTO_CLEAR_PROVIDER_IDS = Object.freeze(Object.keys(AUTO_CLEAR_PROVIDER_IDLE_MS));

function normalizeAutoClearProviderIdleMs(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const [key, ms] of Object.entries(raw)) {
    const provider = clean(key).toLowerCase();
    const idleMs = Number(ms);
    if (!provider || !Number.isFinite(idleMs) || idleMs <= 0) continue;
    out[provider] = Math.max(60_000, Math.round(idleMs));
  }
  return out;
}

// Resolve the auto-clear idle-sweep threshold for a given provider id.
// Unknown/missing providers fall back to the 'default' 1h entry (above).
export function autoClearIdleMsForProvider(provider, providerIdleMs = null) {
  const overrides = normalizeAutoClearProviderIdleMs(providerIdleMs);
  const key = clean(provider).toLowerCase();
  if (overrides[key]) return overrides[key];
  if (key && AUTO_CLEAR_PROVIDER_IDLE_MS[key]) return AUTO_CLEAR_PROVIDER_IDLE_MS[key];
  if (overrides.default) return overrides.default;
  return AUTO_CLEAR_PROVIDER_IDLE_MS[key] ?? AUTO_CLEAR_PROVIDER_IDLE_MS.default;
}

export function autoClearProviderDefaults(providerIdleMs = null) {
  const overrides = normalizeAutoClearProviderIdleMs(providerIdleMs);
  return AUTO_CLEAR_PROVIDER_IDS.map((provider) => {
    const builtInMs = AUTO_CLEAR_PROVIDER_IDLE_MS[provider] ?? AUTO_CLEAR_PROVIDER_IDLE_MS.default;
    const idleMs = overrides[provider] ?? builtInMs;
    return {
      provider,
      idleMs,
      builtInMs,
      custom: overrides[provider] != null,
    };
  });
}

// Agent terminal retention is deliberately narrower than Auto Clear's general
// resolution: listed providers use their provider cache lifetime. Unlisted
// providers use the Advanced "default" row, or the built-in default when no
// override is configured, so completed agents are still eventually reclaimed.
export function resolveAgentTerminalReapMs(config, provider) {
  const key = clean(provider).toLowerCase();
  const raw = config?.autoClear && typeof config.autoClear === 'object' ? config.autoClear : {};
  const overrides = normalizeAutoClearProviderIdleMs(raw.providerIdleMs);
  if (!key || key === 'default' || !Object.hasOwn(AUTO_CLEAR_PROVIDER_IDLE_MS, key)) {
    return overrides.default ?? AUTO_CLEAR_PROVIDER_IDLE_MS.default;
  }
  return overrides[key] ?? AUTO_CLEAR_PROVIDER_IDLE_MS[key];
}

// Resolve the effective auto-clear idle window for a config + provider:
// an explicit user-set idleMs (config.autoClear.idleMs) always wins; else
// fall back to the provider's default; else the global 1h default.
export function resolveAutoClearIdleMs(config, provider) {
  const raw = config?.autoClear && typeof config.autoClear === 'object' ? config.autoClear : {};
  const idleMs = Number(raw.idleMs);
  if (Number.isFinite(idleMs) && idleMs > 0) return Math.max(60_000, Math.round(idleMs));
  return autoClearIdleMsForProvider(provider, raw.providerIdleMs);
}

export function normalizeSystemShellConfig(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const command = clean(raw.command);
  const envCommand = clean(process.env.MIXDOG_SHELL);
  return {
    command,
    effective: command || envCommand || '',
    source: command ? 'config' : (envCommand ? 'env' : 'auto'),
  };
}

export function normalizeSystemShellCommand(value) {
  const command = clean(value).replace(/^auto$/i, '').replace(/^['"](.+)['"]$/, '$1').trim();
  if (!command) return '';
  if (process.platform === 'win32') {
    const stem = command.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
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
  const minContextPercent = Number.isFinite(rawMinPct)
    ? Math.min(100, Math.max(0, Math.round(rawMinPct)))
    : 10;
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
  return {
    ...next,
    auto: raw.auto !== false && raw.enabled !== false,
  };
}

export function moduleEnabled(configLike, name, fallback = true) {
  const entry = configLike?.modules?.[name];
  if (entry && typeof entry === 'object' && entry.enabled === false) return false;
  return fallback !== false;
}

// Recap toggle: gates ONLY the background memory cycles (1/2/3). The memory
// module itself (transcript watcher/ingest, on-demand recall/fasttrack drains)
// is always-on. Default enabled. Reads the dedicated `recap` section; if a
// legacy `modules.memory === false` flag is present it is honored as recap off
// (migration folds it into `recap.enabled` on config load).
export function recapEnabled(configLike, fallback = true) {
  const entry = configLike?.recap;
  if (entry && typeof entry === 'object' && entry.enabled === false) return false;
  return fallback !== false;
}

export function setRecapEnabledInConfig(configLike, enabled) {
  const next = { ...(configLike || {}) };
  next.recap = { ...(next.recap || {}), enabled: enabled !== false };
  // Drop the legacy flag if it was carrying the disabled state.
  if (next.modules && next.modules.memory === false) {
    const modules = { ...next.modules };
    delete modules.memory;
    next.modules = modules;
  } else if (next.modules && next.modules.memory && typeof next.modules.memory === 'object') {
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
  const entry = configLike?.memoryTools;
  if (entry && typeof entry === 'object' && entry.enabled === false) return false;
  return fallback !== false;
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
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
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
  const mult = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1000 : 1;
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
