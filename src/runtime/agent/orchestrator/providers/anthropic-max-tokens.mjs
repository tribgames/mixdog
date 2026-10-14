// Shared catalog-driven max_tokens resolution for both Anthropic providers
// (OAuth and API-key), so anthropic.mjs (the API-key twin) never drifts with
// its own hardcoded table.
//
// Resolution order:
//   1. MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS env override, if set to a positive
//      int, wins outright (returned as the safety cap itself).
//   2. Catalog outputTokens for the model id (trusted over hardcoded
//      heuristics when present — the API reports real per-model limits),
//      clamped to [MAX_TOKENS_FLOOR, safetyCap].
//   3. The shared model catalog's outputTokens for the model (cached roster /
//      LiteLLM / models.dev), same clamp.
//   4. The pre-catalog family limits for a model no catalog describes, else
//      the floor.

import { getModelMetadataSync } from './model-catalog.mjs';

const MAX_TOKENS_FLOOR = 8192;
const DEFAULT_SAFETY_CAP = 65536;
const ENV_VAR = 'MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS';

// Strict-positive env override parsing. Invalid values ("0", negatives,
// garbage, whitespace) are treated as UNSET — not as "use the default cap
// outright" — so catalog/fallback still decide for low-cap models. Raw env
// truthiness must never bypass resolution.
function envAnthropicMaxOutputOverride() {
  const raw = process.env[ENV_VAR];
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

// Last resort when no catalog describes the model: the limits known before
// the catalogs existed. Sonnet 5+ ships a much larger output budget than the
// legacy 4.x line (16384 starved visible output once extended thinking ate
// into the same hard cap). Unknown families stay at the floor.
const MAX_TOKENS = {
  'claude-opus-4-8': 65536,
  'claude-opus-4-7': 65536,
  'claude-opus-4-6': 65536,
  'claude-sonnet-4-6': 16384,
  'claude-haiku-4-5-20251001': 8192,
};

function fallbackAnthropicMaxTokens(model) {
  if (MAX_TOKENS[model]) return MAX_TOKENS[model];
  const id = String(model || '').toLowerCase();
  if (id.includes('opus')) return 65536;
  if (id.includes('fable') || id.includes('mythos')) return 65536;
  const sonnetVersion = id.match(/^claude-sonnet-(\d+)/);
  if (sonnetVersion) return Number(sonnetVersion[1]) >= 5 ? 65536 : 16384;
  if (id.includes('sonnet')) return 16384;
  return MAX_TOKENS_FLOOR;
}

function sharedCatalogOutputTokens(model) {
  const declared = Number(getModelMetadataSync(String(model || ''), 'anthropic')?.outputTokens);
  return Number.isFinite(declared) && declared > 0 ? declared : null;
}

// catalogLookup(model) -> number|null. Providers supply their own strategy
// for sourcing the catalog array (in-memory mirror + disk fallback for OAuth,
// plain disk read for the API-key twin — see anthropic.mjs).
export function resolveAnthropicMaxTokens(model, { catalogLookup } = {}) {
  const envOverride = envAnthropicMaxOutputOverride();
  if (envOverride != null) return envOverride;
  const safetyCap = DEFAULT_SAFETY_CAP;
  let catalogValue = null;
  if (typeof catalogLookup === 'function') {
    try {
      catalogValue = catalogLookup(model);
    } catch {
      catalogValue = null;
    }
  }
  if (!(Number.isFinite(catalogValue) && catalogValue > 0)) catalogValue = sharedCatalogOutputTokens(model);
  if (Number.isFinite(catalogValue) && catalogValue > 0) {
    return Math.max(MAX_TOKENS_FLOOR, Math.min(catalogValue, safetyCap));
  }
  return Math.min(fallbackAnthropicMaxTokens(model), safetyCap);
}
