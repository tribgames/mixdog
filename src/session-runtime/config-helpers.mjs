// Config normalization helpers: default provider, presets/routes, module
// enable flags, shell/auto-clear/compaction config, and duration formatting.
import { clean, hasOwn } from './session-text.mjs';
import { normalizeEffortInput, normalizeSavedEffort } from './effort.mjs';
import { routeFastKey, fastPreferenceFor } from './model-capabilities.mjs';

export const DEFAULT_PROVIDER = 'anthropic-oauth';
export const DEFAULT_MODEL = '';

// Resolve the provider to use when a route carries no explicit provider.
// Priority: config.defaultProvider (when it names a known provider) > DEFAULT_PROVIDER.
export function makeResolveDefaultProvider(isKnownProvider) {
  return function resolveDefaultProvider(config) {
    const configured = clean(config?.defaultProvider);
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

export function makeResolveRoute(resolveDefaultProvider) {
  return function resolveRoute(config, { provider, model, effort, fast } = {}) {
    const explicitProvider = clean(provider);
    const explicitModel = clean(model);
    const hasExplicitEffort = effort !== undefined;
    const explicitEffort = hasExplicitEffort ? normalizeEffortInput(effort) : undefined;
    const hasExplicitFast = fast !== undefined;
    const explicitFast = fast === true;

    if (explicitModel && !explicitProvider) {
      const preset = findPreset(config, explicitModel);
      if (preset) {
        const p = clean(preset.provider) || DEFAULT_PROVIDER;
        const m = clean(preset.model) || DEFAULT_MODEL;
        const saved = modelSettingsFor(config, p, m);
        return {
          provider: p,
          model: m,
          preset,
          effort: hasExplicitEffort ? explicitEffort : normalizeSavedEffort(saved.effort ?? preset.effort),
          fast: hasExplicitFast ? explicitFast : (hasOwn(saved, 'fast') ? saved.fast === true : (preset.fast === true || fastPreferenceFor(config, p, m))),
        };
      }
    }

    if (!explicitProvider && !explicitModel) {
      const defaultKey = config?.default;
      const preset = findPreset(config, defaultKey);
      if (preset) {
        const p = clean(preset.provider) || DEFAULT_PROVIDER;
        const m = clean(preset.model) || DEFAULT_MODEL;
        const saved = modelSettingsFor(config, p, m);
        return {
          provider: p,
          model: m,
          preset,
          effort: hasExplicitEffort ? explicitEffort : normalizeSavedEffort(saved.effort ?? preset.effort),
          fast: hasExplicitFast ? explicitFast : (hasOwn(saved, 'fast') ? saved.fast === true : (preset.fast === true || fastPreferenceFor(config, p, m))),
        };
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

export function normalizeSystemShellConfig(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const command = clean(raw.command ?? raw.path ?? raw.executable ?? raw.shell);
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
  const idleMs = Number(raw.idleMs ?? raw.thresholdMs ?? raw.idleMillis);
  return {
    enabled: raw.enabled !== false,
    idleMs: Number.isFinite(idleMs) && idleMs > 0 ? Math.max(60_000, Math.round(idleMs)) : AUTO_CLEAR_DEFAULT_IDLE_MS,
  };
}

export function normalizeCompactTypeSetting(value, fallback = 'semantic') {
  const raw = clean(value).toLowerCase().replace(/_/g, '-');
  if (!raw) return fallback;
  if (raw === '1' || raw === 'type1' || raw === 'type-1' || raw === 'semantic' || raw === 'summary' || raw === 'default') return 'semantic';
  if (raw === '2' || raw === 'type2' || raw === 'type-2' || raw === 'recall' || raw === 'recall-fast' || raw === 'recall-fasttrack' || raw === 'recall-fast-track' || raw === 'fasttrack' || raw === 'fast-track') return 'recall-fasttrack';
  return fallback;
}

export function normalizeCompactionConfig(value = {}, { memoryEnabled = true } = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  let compactType = normalizeCompactTypeSetting(raw.compactType ?? raw.compact_type ?? raw.type, 'semantic');
  if (compactType === 'recall-fasttrack' && memoryEnabled === false) compactType = 'semantic';
  return {
    ...raw,
    auto: raw.auto !== false && raw.enabled !== false,
    type: compactType,
    compactType,
  };
}

export function moduleEnabled(configLike, name, fallback = true) {
  const entry = configLike?.modules?.[name];
  if (entry && typeof entry === 'object' && entry.enabled === false) return false;
  return fallback !== false;
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
