// Reasoning-effort catalogs and coercion. Pure helpers.
import { clean } from './session-text.mjs';
import { customEffortLevels, snapCustomEffort } from '../providers/custom-reasoning.mjs';
import { rejectedEffortLevelsSync } from '../providers/effort-rejection.mjs';

const TOOL_MODES = new Set(['full', 'readonly', 'lead']);
const ALL_EFFORT_LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const EFFORT_LABELS = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
};

// Last-resort ladders for routes whose endpoints publish no effort metadata
// (no per-model levels on /models, no same-endpoint catalog row). Every other
// provider's ladder comes from its own catalog rows (live roster, models.dev
// via provider-catalog-registry, seeds); a route with none offers no effort.
const EFFORT_OPTIONS_BY_PROVIDER = {
  openai: ['none', 'low', 'medium', 'high', 'xhigh'],
  // xAI Grok 4.6+: low/medium/high/xhigh. Reasoning cannot be disabled.
  xai: ['low', 'medium', 'high', 'xhigh'],
  'mimo-oauth': ['minimal', 'low', 'medium', 'high'],
  // Command Code relays several vendors over Chat Completions; the common
  // `reasoning_effort` levels are the fallback when no catalog row declares any.
  'command-code-oauth': ['low', 'medium', 'high'],
};
const EFFORT_BY_FAMILY = {
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
const EFFORT_FALLBACKS = {
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
  const value = String(mode || '')
    .trim()
    .toLowerCase();
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

// Levels the endpoint has rejected for this route stop being offered.
export function effortOptionsFor(provider, model) {
  const options = catalogEffortOptions(provider, model);
  const rejected = model?.id ? rejectedEffortLevelsSync(provider, model.id) : null;
  return rejected?.size ? options.filter((level) => !rejected.has(level)) : options;
}

function catalogEffortOptions(provider, model) {
  // Custom-provider rows declare their levels authoritatively: an explicit []
  // (or no declaration) means none, with no family/provider fallback.
  if (model?.customReasoning) return customEffortLevels(model) || [];
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
  if (Object.hasOwn(EFFORT_BY_FAMILY, family)) {
    return [...EFFORT_BY_FAMILY[family]];
  }
  return providerAllowed ? [...providerAllowed] : [];
}

const warnedEmptyLadders = new Set();

/**
 * Auto effort skipped a judgment because the base is off the model's ladder.
 * A user-chosen max/ultra is expected to skip; any other base means the route
 * has no usable ladder, so say so once per provider/model per process.
 */
export function warnEmptyAutoEffortLadder(provider, model, base) {
  if (base === 'max' || base === 'ultra') return;
  const key = `${provider}/${model}`;
  if (warnedEmptyLadders.has(key)) return;
  warnedEmptyLadders.add(key);
  process.stderr.write(`[auto-effort] no effort ladder for ${key}; judge skipped\n`);
}

export function coerceEffortFor(provider, model, effort) {
  if (!effort) return null;
  if (model?.customReasoning) return snapCustomEffort(customEffortLevels(model), effort);
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
