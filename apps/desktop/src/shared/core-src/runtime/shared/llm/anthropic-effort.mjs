/**
 * Anthropic "effort" (extended-thinking budget) request parameter handling.
 */
import {
  CLAUDE_GENERATION_FLOOR,
  claudeGenerationAtLeast,
  emitsAnthropicProgressUpdates,
  isAnthropicAdaptiveOnlyByGeneration,
  normalizeClaudeModelId as normalizeModelId,
} from './anthropic-thinking-contract.mjs';
import { getModelMetadataSync } from './model-catalog.mjs';

const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const THINKING_DISPLAYS = new Set(['summarized', 'omitted', 'updates']);

// Canonical display/transport ordering for effort levels. Used only to sort
// whatever set the catalog actually advertises — NOT as an allowlist. The
// catalog (capabilities.effort) is the source of truth for which levels a
// model exposes; this array just keeps them in a stable low→max order.
const EFFORT_LEVEL_ORDER = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
function _sortEffortLevels(levels) {
  const rank = (l) => {
    const i = EFFORT_LEVEL_ORDER.indexOf(l);
    return i === -1 ? EFFORT_LEVEL_ORDER.length : i;
  };
  return [...levels].sort((a, b) => rank(a) - rank(b));
}

// Control flags that ride the capabilities.effort map alongside real levels
// (`{supported:true, low:true, …}`). They are NOT selectable effort levels;
// letting them through minted a bogus "supported" level that got persisted
// into the on-disk catalog and offered in the UI.
const CONTROL_EFFORT_KEYS = new Set(['supported', 'enabled', 'default']);

// ── Catalog-first capability index ───────────────────────────────────────
// The provider catalog already carries what each model advertises
// (capabilities.effort → reasoningOptions:[{type:'effort',values:[…]}],
// capabilities.thinking.types → thinkingTypes), so it — not an id ladder — is
// the source of truth for what we put on the wire. Order for one model:
//   1. the live-roster index below (anthropic-model-resolve feeds it whenever
//      the in-memory catalog moves),
//   2. the shared model catalog (cached roster / LiteLLM / models.dev),
//   3. a release-generation floor (anthropic-thinking-contract) for an id no
//      catalog describes — a new release inherits it, no per-id entry.
const _catalogEntries = new Map();

/** `{adaptive?:boolean, enabled?:boolean}` a live /v1/models row declares under
 *  capabilities.thinking.types, or undefined when it declares neither. */
export function thinkingTypesFromCapabilities(capabilities) {
  const types = capabilities?.thinking?.types;
  if (!types || typeof types !== 'object') return undefined;
  const out = {};
  for (const key of ['adaptive', 'enabled']) {
    const declared = types[key];
    const supported = typeof declared === 'boolean' ? declared : declared?.supported;
    if (typeof supported === 'boolean') out[key] = supported;
  }
  return Object.keys(out).length ? out : undefined;
}

function _effortLevelsOf(reasoningOptions) {
  const option = (Array.isArray(reasoningOptions) ? reasoningOptions : []).find(
    (entry) =>
      String(entry?.type || '')
        .trim()
        .toLowerCase() === 'effort'
  );
  return new Set(
    (Array.isArray(option?.values) ? option.values : [])
      .map((value) =>
        String(value || '')
          .trim()
          .toLowerCase()
      )
      .filter((value) => value && !CONTROL_EFFORT_KEYS.has(value))
  );
}

function _catalogKeys(model) {
  const id = normalizeModelId(model);
  if (!id) return [];
  // A dated id and its bare version alias describe the SAME model — index
  // both so `claude-opus-5` and `claude-opus-5-20260101` resolve alike.
  const undated = id.replace(/-\d{8}$/, '');
  return undated !== id ? [id, undated] : [id];
}

/**
 * Replace the catalog-derived capability index. Records without a
 * `reasoningOptions` array are treated as UNKNOWN (skipped, so the regex
 * fallback still applies) rather than as "no effort" — offline/static fallback
 * lists carry no capability data and must not disable effort.
 */
export function setModelEffortCapabilities(models) {
  _catalogEntries.clear();
  if (!Array.isArray(models)) return;
  for (const model of models) {
    if (!model?.id || !Array.isArray(model.reasoningOptions)) continue;
    // User-defined providers resolve reasoning from their own rows
    // (custom-reasoning.mjs); a same-id custom model must never reshape the
    // first-party index.
    if (String(model.provider || '').startsWith('custom-')) continue;
    const levels = _effortLevelsOf(model.reasoningOptions);
    const manual = typeof model.thinkingTypes?.enabled === 'boolean' ? model.thinkingTypes.enabled : undefined;
    const adaptive = typeof model.thinkingTypes?.adaptive === 'boolean' ? model.thinkingTypes.adaptive : undefined;
    for (const key of _catalogKeys(model.id)) {
      const existing = _catalogEntries.get(key);
      // A bare alias shared by several records keeps the richer entry.
      if (existing?.levels.size && levels.size === 0) continue;
      _catalogEntries.set(key, { levels, manual, adaptive });
    }
  }
}

// Shared-catalog tier (cached roster rows, LiteLLM, models.dev) for an id the
// live index does not hold. Only an actual effort ladder counts; silence
// returns null so the generation floor decides.
function _sharedCatalogEntry(model) {
  const id = normalizeModelId(model);
  if (!id) return null;
  const levels = _effortLevelsOf(getModelMetadataSync(id, 'anthropic')?.reasoningOptions);
  return levels.size ? { levels, manual: undefined, adaptive: undefined } : null;
}

/** `{levels: Set, manual?: boolean, adaptive?: boolean}` for `model`, or null when no catalog describes it. */
function _catalogEntry(model) {
  for (const key of _catalogKeys(model)) {
    const entry = _catalogEntries.get(key);
    if (entry) return entry;
  }
  return _sharedCatalogEntry(model);
}

/** Advertised levels for `model`, or null when the catalog has no ladder for it. */
function _catalogLevels(model) {
  return _catalogEntry(model)?.levels ?? null;
}

/**
 * True when the model's thinking contract rejects a manual
 * `thinking:{type:"enabled",budget_tokens}` request: the catalog's declared
 * thinking types decide, the release-generation floor covers an undescribed id.
 */
export function isAnthropicAdaptiveOnlyModel(model) {
  const manual = _catalogEntry(model)?.manual;
  return typeof manual === 'boolean' ? !manual : isAnthropicAdaptiveOnlyByGeneration(model);
}

// The thinking type is resolved apart from the effort ladder: a catalog can
// advertise effort levels for a model that still takes the manual budget shape
// (effort is not adaptive-thinking support). A declared `adaptive` flag decides;
// otherwise the release-generation floor does, whatever ladder the catalog holds.
function _usesAdaptiveThinking(model) {
  if (isEnvTruthy(process.env.MIXDOG_ANTHROPIC_ALWAYS_ENABLE_EFFORT)) return true;
  const adaptive = _catalogEntry(model)?.adaptive;
  return typeof adaptive === 'boolean' ? adaptive : _floorSupportsEffort(model);
}

export function assertAnthropicManualBudgetSupported(model) {
  if (isAnthropicAdaptiveOnlyModel(model)) {
    throw new TypeError(`${model} does not support thinkingBudgetTokens; use effort with adaptive thinking instead.`);
  }
}

/**
 * Effort levels the wire builder sends unchanged for `model` (reserved `max`
 * excluded), from the same capability gates normalizeAnthropicEffortInput and
 * applyAnthropicEffortToBody use: catalog record first, generation floor for
 * an absent record. A model without effort support, or whose catalog record
 * declares none, accepts none.
 */
export function anthropicEffortLevelsFor(model) {
  // Only the adaptive path sends output_config effort; a manual-thinking model
  // takes none, whatever ladder a catalog holds for it.
  if (!modelSupportsEffort(model) || !_usesAdaptiveThinking(model)) return [];
  const levels = ['low', 'medium', 'high'];
  if (modelSupportsXhighEffort(model)) levels.push('xhigh');
  return levels;
}

export const EFFORT_BETA_HEADER = 'effort-2025-11-24';

export const LEGACY_EFFORT_BUDGET = Object.freeze({
  low: 1024,
  medium: 4096,
  high: 16384,
  xhigh: 32768,
  max: 32768,
});
const _LOGGED_EFFORT_NORMALIZATION = new Set();
const _LOGGED_UNKNOWN_EFFORT = new Set();
const MAX_LOGGED_UNKNOWN_EFFORTS = 100;

export function modelSupportsEffort(model) {
  if (isEnvTruthy(process.env.MIXDOG_ANTHROPIC_ALWAYS_ENABLE_EFFORT)) return true;
  const advertised = _catalogLevels(model);
  if (advertised) return advertised.size > 0;
  return _floorSupportsEffort(model);
}

// Generation-floor fallbacks for ids the catalog does not describe. Also used
// by effortValuesForModel, which BUILDS the catalog records and therefore must
// never consult the index it feeds. Legacy manual-thinking generations
// (claude-3-7-sonnet, claude-sonnet-4-5, claude-haiku-4-5) sit below the
// floor; non-claude ids have no generation and get nothing.
function _floorSupportsEffort(model) {
  return claudeGenerationAtLeast(model, CLAUDE_GENERATION_FLOOR.adaptiveEffort);
}

export function modelSupportsXhighEffort(model) {
  const advertised = _catalogLevels(model);
  if (advertised) return advertised.has('xhigh');
  return _floorSupportsXhighEffort(model);
}

function _floorSupportsXhighEffort(model) {
  return claudeGenerationAtLeast(model, CLAUDE_GENERATION_FLOOR.xhighEffort);
}

export function modelSupportsMaxEffort(model) {
  const advertised = _catalogLevels(model);
  // xhigh support implies max support.
  if (advertised) return advertised.has('max') || advertised.has('xhigh');
  return _floorSupportsMaxEffort(model);
}

function _floorSupportsMaxEffort(model) {
  return claudeGenerationAtLeast(model, CLAUDE_GENERATION_FLOOR.maxEffort);
}

function isEnvTruthy(value) {
  const s = String(value ?? '')
    .trim()
    .toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function logOnce(key, write) {
  if (_LOGGED_EFFORT_NORMALIZATION.has(key)) return;
  _LOGGED_EFFORT_NORMALIZATION.add(key);
  try {
    write();
  } catch {
    /* ignore */
  }
}

/**
 * Normalize user/config effort to API levels (low/medium/high/xhigh/max).
 * Accepts extra-high / very-high aliases as xhigh; clamps xhigh/max down to
 * high on models that don't support the top Opus tiers.
 */
export function normalizeAnthropicEffortInput(raw, model, logTag = 'anthropic') {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let level = String(raw).trim().toLowerCase();
  if (level === 'extra-high' || level === 'very-high') level = 'xhigh';

  if (level === 'xhigh' && !modelSupportsXhighEffort(model)) {
    logOnce(`xhigh:high`, () => {
      process.stderr.write(`[${logTag}] effort "xhigh" downgraded to "high" for model ${model}\n`);
    });
    return 'high';
  }

  if (level === 'max' && !modelSupportsMaxEffort(model)) {
    logOnce(`max:high`, () => {
      process.stderr.write(`[${logTag}] effort "max" downgraded to "high" for model ${model}\n`);
    });
    return 'high';
  }

  if (EFFORT_LEVELS.includes(level)) return level;
  return undefined;
}

// The effort beta rides every request that sends output_config effort; an
// explicit thinkingBudgetTokens takes the manual-budget path instead.
export function shouldIncludeEffortBeta(model, opts = {}) {
  const thinkingBudgetTokens = Number(opts.thinkingBudgetTokens);
  if (Number.isFinite(thinkingBudgetTokens) && thinkingBudgetTokens > 0) return false;
  // Only requests that carry output_config effort (adaptive path) need the beta.
  return modelSupportsEffort(model) && _usesAdaptiveThinking(model);
}

/**
 * Apply effort / thinking to a Messages API body or SDK params object (mutates).
 */
export function applyAnthropicEffortToBody(
  body,
  { model, opts = {}, maxTokens, clampThinkingBudgetTokens, logTag = 'anthropic', progressUpdates = false }
) {
  if (!body || typeof body !== 'object') return;

  // A gateway that declares its own effort contract (DeepSeek ignores
  // budget_tokens) projects effort itself; returning true skips the Claude rules.
  if (typeof opts.messagesEffortProjection === 'function') {
    if (opts.messagesEffortProjection(body, { model, effort: opts.effort }) === true) return;
  }

  const thinkingBudgetTokens = Number(opts.thinkingBudgetTokens);
  if (Number.isFinite(thinkingBudgetTokens) && thinkingBudgetTokens > 0) {
    assertAnthropicManualBudgetSupported(model);
    const budgetTokens = clampThinkingBudgetTokens(thinkingBudgetTokens, maxTokens);
    if (budgetTokens) {
      body.thinking = { type: 'enabled', budget_tokens: budgetTokens };
    }
    return;
  }

  const normalized = normalizeAnthropicEffortInput(opts.effort, model, logTag);

  if (modelSupportsEffort(model) && _usesAdaptiveThinking(model)) {
    if (normalized) {
      const existing = body.output_config && typeof body.output_config === 'object' ? body.output_config : {};
      body.output_config = { ...existing, effort: normalized };
    }
    // Adaptive-thinking models (4.6+) require `thinking:{type:"adaptive"}`
    // rather than the legacy budget_tokens shape — sending
    // `thinking:{type:"enabled"}` here 400s on sonnet-5/opus-4-7/4-8.
    // Models that write tool preambles as progress-update thinking blocks
    // default to `updates` (beta) where beta headers are allowed, so those
    // notes arrive as text; every other model keeps the API default. The
    // env var overrides either way (e.g. `omitted` turns preambles off).
    const envDisplay = (process.env.MIXDOG_ANTHROPIC_THINKING_DISPLAY || '').trim();
    let display = '';
    if (THINKING_DISPLAYS.has(envDisplay)) display = envDisplay;
    else if (progressUpdates && emitsAnthropicProgressUpdates(model)) display = 'updates';
    body.thinking = display ? { type: 'adaptive', display } : { type: 'adaptive' };
    // Adaptive/4.7+ models reject any non-default sampling param with a 400.
    delete body.temperature;
    delete body.top_p;
    delete body.top_k;
    return;
  }

  if (normalized && LEGACY_EFFORT_BUDGET[normalized]) {
    // Contradictory/stale catalog data must not route an adaptive-only
    // model back to a manual request that its backend rejects.
    assertAnthropicManualBudgetSupported(model);
    const budgetTokens = clampThinkingBudgetTokens(LEGACY_EFFORT_BUDGET[normalized], maxTokens);
    if (budgetTokens) {
      body.thinking = { type: 'enabled', budget_tokens: budgetTokens };
    }
    return;
  }

  const unknownEffort = String(opts.effort ?? '');
  if (opts.effort && normalized === undefined && !_LOGGED_UNKNOWN_EFFORT.has(unknownEffort)) {
    if (_LOGGED_UNKNOWN_EFFORT.size >= MAX_LOGGED_UNKNOWN_EFFORTS) {
      _LOGGED_UNKNOWN_EFFORT.delete(_LOGGED_UNKNOWN_EFFORT.values().next().value);
    }
    _LOGGED_UNKNOWN_EFFORT.add(unknownEffort);
    try {
      process.stderr.write(
        `[${logTag}] unknown effort=${opts.effort} ignored (known legacy: ${Object.keys(LEGACY_EFFORT_BUDGET).join(', ')})\n`
      );
    } catch {
      /* ignore */
    }
  }
}

export function effortValuesForModel(capabilities, modelId) {
  const effort = capabilities?.effort;
  if (!effort) return [];
  // Catalog-first: when capabilities.effort enumerates per-level support,
  // that map is the source of truth — expose exactly the levels the model
  // advertises (xhigh, max, or anything future), no hardcoded allowlist.
  if (typeof effort === 'object') {
    const advertised = Object.keys(effort).filter(
      (level) =>
        !CONTROL_EFFORT_KEYS.has(String(level).trim().toLowerCase()) &&
        (effort[level] === true || effort[level]?.supported === true)
    );
    if (advertised.length) return _sortEffortLevels(advertised);
    // Object with no per-level flags: fall through to the boolean/supported
    // fallback below only when it explicitly marks blanket support.
    if (effort.supported !== true) return [];
  }
  // Fallback (effort === true, or {supported:true} with no per-level map):
  // the model supports effort but doesn't enumerate levels, so derive the
  // set from the known level ladder, gated by the top-tier model check.
  let levels = [...EFFORT_LEVELS];
  if (!_floorSupportsMaxEffort(modelId)) {
    levels = levels.filter((level) => level !== 'max');
  }
  if (!_floorSupportsXhighEffort(modelId)) {
    levels = levels.filter((level) => level !== 'xhigh');
  }
  return levels;
}
