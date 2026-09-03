// Reasoning-effort catalogs and coercion. Pure helpers.
import { clean } from './session-text.mjs';

export const TOOL_MODES = new Set(['full', 'readonly', 'lead']);
export const ALL_EFFORT_LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export const EFFORT_LABELS = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
};

export const EFFORT_OPTIONS_BY_PROVIDER = {
  openai: ['none', 'low', 'medium', 'high', 'xhigh'],
  // gpt-5.6+ catalogs declare max/ultra; the openai-oauth transport folds
  // ultra -> max on the wire (openai-oauth.mjs _normalizeReasoningEffort).
  'openai-oauth': ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  anthropic: ['low', 'medium', 'high', 'xhigh', 'max'],
  'anthropic-oauth': ['low', 'medium', 'high', 'xhigh', 'max'],
  // xAI Grok 4.6+: low/medium/high/xhigh. Reasoning cannot be disabled.
  xai: ['low', 'medium', 'high', 'xhigh'],
  'grok-oauth': ['low', 'medium', 'high', 'xhigh'],
  // Antigravity carries the effort tier inside the wire model id
  // (gemini-3-pro-high / -low, claude-*-thinking), so the route exposes none.
  'antigravity-oauth': [],
  'opencode-go': ['high', 'max'],
};
export const EFFORT_BY_FAMILY = {
  opus: ['low', 'medium', 'high', 'xhigh', 'max'],
  fable: ['low', 'medium', 'high', 'xhigh', 'max'],
  sonnet: ['low', 'medium', 'high'],
  haiku: [],
  'gpt-5.5': ['none', 'low', 'medium', 'high', 'xhigh'],
  'gpt-5.4': ['none', 'low', 'medium', 'high', 'xhigh'],
  'gpt-5.2': ['none', 'low', 'medium', 'high', 'xhigh'],
  'gpt-5': ['none', 'low', 'medium', 'high', 'xhigh'],
  'gpt-mini': ['none', 'low', 'medium', 'high', 'xhigh'],
  'gpt-nano': ['none', 'low', 'medium', 'high'],
  'gpt-codex': ['none', 'low', 'medium', 'high'],
  grok: ['low', 'medium', 'high', 'xhigh'],
};
export const EFFORT_FALLBACKS = {
  ultra: ['ultra', 'max', 'xhigh', 'high', 'medium', 'low', 'minimal'],
  max: ['max', 'xhigh', 'high', 'medium', 'low', 'minimal'],
  xhigh: ['xhigh', 'high', 'medium', 'low', 'minimal'],
  high: ['high', 'medium', 'low', 'minimal'],
  medium: ['medium', 'low', 'minimal'],
  low: ['low', 'minimal'],
  minimal: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  none: ['none'],
};

export function normalizeToolMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  return TOOL_MODES.has(value) ? value : 'full';
}

export function normalizeEffortInput(value) {
  const v = clean(value).toLowerCase();
  if (!v || v === 'auto') return null;
  if (!ALL_EFFORT_LEVELS.has(v)) {
    throw new Error(`effort must be one of auto, ${[...ALL_EFFORT_LEVELS].join(', ')}`);
  }
  return v;
}

export function effortOptionsFor(provider, model) {
  const providerAllowed = EFFORT_OPTIONS_BY_PROVIDER[provider] || null;
  const normalizeCatalogValues = (values) => {
    const seen = new Set();
    const out = [];
    for (const raw of values || []) {
      const v = clean(raw).toLowerCase();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      if (ALL_EFFORT_LEVELS.has(v)) out.push(v);
    }
    return out;
  };
  const family = clean(model?.family).toLowerCase();
  const reasoningOptionEffort = Array.isArray(model?.reasoningOptions)
    ? model.reasoningOptions.find((option) => clean(option?.type).toLowerCase() === 'effort')
    : null;
  const reasoningOptionValues = Array.isArray(reasoningOptionEffort?.values)
    ? reasoningOptionEffort.values.map((v) => clean(v).toLowerCase()).filter(Boolean)
    : [];
  const declared = Array.isArray(model?.reasoningLevels)
    ? model.reasoningLevels.map((v) => clean(v).toLowerCase()).filter(Boolean)
    : [];
  // Catalog-first: when the catalog (models.dev / native /models) declares
  // effort values, trust them as-is. Provider/family lists are fallbacks for
  // catalog-empty models only, never a filter that narrows catalog values.
  if (reasoningOptionValues.length) return normalizeCatalogValues(reasoningOptionValues);
  if (declared.length) return normalizeCatalogValues(declared);
  if (Object.prototype.hasOwnProperty.call(EFFORT_BY_FAMILY, family)) {
    return [...EFFORT_BY_FAMILY[family]];
  }
  return providerAllowed ? [...providerAllowed] : [];
}

export function coerceEffortFor(provider, model, effort) {
  if (!effort) return null;
  const allowed = effortOptionsFor(provider, model);
  if (!allowed || allowed.length === 0) return null;
  if (allowed.includes(effort)) return effort;
  for (const candidate of EFFORT_FALLBACKS[effort] || []) {
    if (allowed.includes(candidate)) return candidate;
  }
  return null;
}

export function normalizeSavedEffort(value) {
  try {
    return normalizeEffortInput(value);
  } catch {
    return null;
  }
}

export function effortItemsFor(provider, model, activeEffort) {
  const allowed = effortOptionsFor(provider, model);
  const items = [];
  for (const value of allowed || []) {
    items.push({
      value,
      label: EFFORT_LABELS[value] || value,
      description: value === activeEffort ? 'current' : '',
    });
  }
  return items;
}

export function toolSpecForMode(mode) {
  return mode === 'readonly' ? ['tools:readonly'] : 'full';
}

export function deferredSurfaceModeForLead(mode) {
  return mode === 'readonly' ? 'readonly' : 'lead';
}
