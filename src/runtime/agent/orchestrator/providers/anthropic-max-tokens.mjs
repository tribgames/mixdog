// Shared catalog-driven max_tokens resolution for both Anthropic providers
// (OAuth and API-key). Extracted from anthropic-oauth.mjs so anthropic.mjs
// (the API-key twin) gets the same sonnet-5+ / haiku fix instead of drifting
// with its own hardcoded table.
//
// Resolution order:
//   1. MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS env override, if set to a positive
//      int, wins outright (returned as the safety cap itself).
//   2. Catalog outputTokens for the model id (trusted over hardcoded
//      heuristics when present — the API reports real per-model limits),
//      clamped to [MAX_TOKENS_FLOOR, safetyCap].
//   3. Static per-model table / family heuristic fallback when the catalog
//      has no entry for this model, also capped at the safety cap.

export const MAX_TOKENS_FLOOR = 8192;
export const DEFAULT_SAFETY_CAP = 65536;
const ENV_VAR = 'MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS';

// Per-model max_tokens when the model id is explicitly listed. New models
// (e.g., Sonnet 4.7) won't match a specific entry and fall through to the
// family-based heuristic below. Conservative defaults — model may support
// more but we'd rather stay within safe bounds.
const MAX_TOKENS = {
    'claude-opus-4-8': 65536,
    'claude-opus-4-7': 65536,
    'claude-opus-4-6': 65536,
    'claude-sonnet-4-6': 16384,
    'claude-haiku-4-5-20251001': 8192,
};

// Strict-positive env override parsing. Invalid values ("0", negatives,
// garbage, whitespace) are treated as UNSET — not as "use the default cap
// outright" — so catalog/fallback still decide for low-cap models. Raw env
// truthiness must never bypass resolution.
export function envAnthropicMaxOutputOverride() {
    const raw = process.env[ENV_VAR];
    if (raw == null || String(raw).trim() === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n);
}

export function resolveAnthropicSafetyCap() {
    return envAnthropicMaxOutputOverride() ?? DEFAULT_SAFETY_CAP;
}

// Pure lookup over an already-loaded catalog array (disk cache or in-memory
// mirror) — no I/O, no caching strategy. Callers own how/when the array is
// loaded/refreshed.
export function lookupCatalogOutputTokens(models, id) {
    if (!id || !Array.isArray(models)) return null;
    const entry = models.find(m => m?.id === id);
    const out = Number(entry?.outputTokens);
    return Number.isFinite(out) && out > 0 ? out : null;
}

// Static per-model table + family heuristic, used when the catalog has no
// entry for this model id. Sonnet 5+ ships a much larger output budget than
// the legacy 4.x line (this is the claude-sonnet-5 fix: 16384 was starving
// visible output once extended thinking ate into the same hard cap). Keep
// sonnet-4-x conservative at 16384; only bump 5+.
export function fallbackAnthropicMaxTokens(model) {
    if (MAX_TOKENS[model]) return MAX_TOKENS[model];
    const id = String(model || '').toLowerCase();
    if (id.includes('opus')) return 65536;
    if (id.includes('fable')) return 65536;
    const sonnetVersion = id.match(/^claude-sonnet-(\d+)/);
    if (sonnetVersion) return Number(sonnetVersion[1]) >= 5 ? 65536 : 16384;
    if (id.includes('sonnet')) return 16384;
    if (id.includes('haiku')) return 8192;
    return 8192;
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
    if (Number.isFinite(catalogValue) && catalogValue > 0) {
        return Math.max(MAX_TOKENS_FLOOR, Math.min(catalogValue, safetyCap));
    }
    return Math.min(fallbackAnthropicMaxTokens(model), safetyCap);
}
