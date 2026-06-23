/**
 * Model Catalog Enricher
 *
 * Providers' native /v1/models endpoints return ids but rarely include
 * metadata (context window, output limit, pricing). We fetch LiteLLM's
 * public catalog — a community-maintained JSON of 2600+ models across
 * 140+ providers — and use it as the metadata source.
 *
 * Source: https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
 *
 * The catalog is cached on disk for 24h. On fetch failure, providers fall
 * back to whatever metadata their native endpoint exposed (usually nothing
 * beyond the id). Pricing stays null in that case; UI shows "-" instead of
 * a stale number.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getPluginData } from '../config.mjs';

const CATALOG_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CATALOG_CACHE_FILE = 'litellm-catalog.json';
const CATALOG_TTL_MS = 24 * 60 * 60_000;

// Second auto pricing source: models.dev publishes per-PROVIDER model
// catalogs (cost in $/M) for 140+ providers — including ones LiteLLM does not
// track yet (e.g. opencode-go). Because it is keyed provider→model, a
// provider-scoped lookup is collision-free: deepseek-v4-pro under `deepseek`
// and under `opencode-go` resolve to their own distinct rates. Same 24h TTL
// + disk cache shape as the LiteLLM catalog above.
const MODELSDEV_URL = 'https://models.dev/api.json';
const MODELSDEV_CACHE_FILE = 'modelsdev-catalog.json';

// mixdog provider id → models.dev provider id. Identity for ids that already
// match (opencode-go / deepseek / xai / openai / anthropic / groq /
// mistral); only the OAuth aliases and gemini→google need remapping.
const _MODELSDEV_PROVIDER_ALIAS = {
    'anthropic-oauth': 'anthropic',
    'openai-oauth': 'openai',
    'grok-oauth': 'xai',
    'gemini': 'google',
};
function _modelsDevProviderId(provider) {
    if (!provider) return null;
    const p = String(provider).toLowerCase();
    return _MODELSDEV_PROVIDER_ALIAS[p] || p;
}

// Provider prefix variants used for catalog key lookup. Named constants so
// all three lookup sites (getModelMetadataSync, getModelMetadata, enrichModels)
// stay in sync. A provider needing a new prefix adds it here.
// Source: LiteLLM catalog key conventions (see CATALOG_URL above).
const _CATALOG_SIMPLE_PREFIXES = [
    'anthropic/', 'openai/', 'gemini/', 'google/', 'xai/', 'azure_ai/',
    'deepseek/', 'openrouter/anthropic/', 'openrouter/openai/',
];
// Bedrock-style variants: catalog key = <prefix><id>-v1:0
const _CATALOG_BEDROCK_PREFIXES = ['anthropic.', 'bedrock/anthropic.'];
// Shorter prefix set for enrichModels (ids from /models endpoints are rarely
// azure_ai- or openrouter-namespaced).
const _CATALOG_ENRICH_PREFIXES = ['anthropic/', 'openai/', 'gemini/', 'google/', 'xai/', 'deepseek/'];

// Polyfill for models the LiteLLM catalog does not list yet. Values mirror
// the catalog row shape so _normalize works unchanged. Source: each provider's
// official pricing page; do not extrapolate. Promotional discounts are
// intentionally NOT encoded — list rates only.
const PRICING_OVERRIDES = {
    // https://www.anthropic.com/news/claude-opus-4-8 — unchanged from Opus 4.7.
    'claude-opus-4-8': {
        litellm_provider: 'anthropic',
        input_cost_per_token: 5e-6,
        output_cost_per_token: 25e-6,
        cache_read_input_token_cost: 0.5e-6,
        cache_creation_input_token_cost: 6.25e-6,
        max_input_tokens: 1000000,
        max_output_tokens: 128000,
        mode: 'chat',
        supports_vision: true,
        supports_function_calling: true,
        supports_prompt_caching: true,
    },
    // https://api-docs.deepseek.com/quick_start/pricing — official list rates
    // ($/token), verified 2026-06-17. Both models: 1M context, 384K max output.
    'deepseek-v4-flash': {
        litellm_provider: 'deepseek',
        input_cost_per_token: 1.4e-7,
        output_cost_per_token: 2.8e-7,
        cache_read_input_token_cost: 2.8e-9,
        max_input_tokens: 1000000,
        max_output_tokens: 384000,
        mode: 'chat',
        supports_function_calling: true,
        supports_prompt_caching: true,
    },
    'deepseek-v4-pro': {
        litellm_provider: 'deepseek',
        input_cost_per_token: 4.35e-7,
        output_cost_per_token: 8.7e-7,
        cache_read_input_token_cost: 3.625e-9,
        max_input_tokens: 1000000,
        max_output_tokens: 384000,
        mode: 'chat',
        supports_function_calling: true,
        supports_prompt_caching: true,
    },
};

let _memCache = null;
let _memCacheAt = 0;
// Single-flight: concurrent loadCatalog callers share the same in-flight
// Promise so a cold cache only triggers one disk read + one remote fetch.
let _loadPromise = null;

function cachePath() {
    return join(getPluginData(), CATALOG_CACHE_FILE);
}

async function _loadCatalogImpl() {
    // Disk cache first
    try {
        if (existsSync(cachePath())) {
            const raw = JSON.parse(readFileSync(cachePath(), 'utf-8'));
            if (raw?.fetchedAt && (Date.now() - raw.fetchedAt) < CATALOG_TTL_MS && raw.data) {
                _memCache = raw.data;
                _memCacheAt = raw.fetchedAt;
                return _memCache;
            }
        }
    } catch { /* fall through */ }
    // Remote fetch
    try {
        const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        try {
            writeFileSync(cachePath(), JSON.stringify({ fetchedAt: Date.now(), data }));
        } catch { /* cache is best-effort */ }
        _memCache = data;
        _memCacheAt = Date.now();
        return data;
    } catch (err) {
        process.stderr.write(`[model-catalog] fetch failed: ${err.message}\n`);
        return {};
    }
}

async function loadCatalog() {
    if (_memCache && (Date.now() - _memCacheAt) < CATALOG_TTL_MS) return _memCache;
    if (_loadPromise) return _loadPromise;
    _loadPromise = _loadCatalogImpl().finally(() => { _loadPromise = null; });
    return _loadPromise;
}

function warmFromDiskSync() {
    if (_memCache) return;
    try {
        const raw = JSON.parse(readFileSync(cachePath(), 'utf-8'));
        if (raw?.data) {
            _memCache = raw.data;
            _memCacheAt = raw.fetchedAt || Date.now();
        }
    } catch { /* disk cache unavailable — stay cold, async warm will fill later */ }
}

// ── models.dev catalog (second auto pricing source) ─────────────────────────
let _mdCache = null;
let _mdCacheAt = 0;
let _mdLoadPromise = null;
function mdCachePath() {
    return join(getPluginData(), MODELSDEV_CACHE_FILE);
}
async function _loadModelsDevImpl() {
    try {
        if (existsSync(mdCachePath())) {
            const raw = JSON.parse(readFileSync(mdCachePath(), 'utf-8'));
            if (raw?.fetchedAt && (Date.now() - raw.fetchedAt) < CATALOG_TTL_MS && raw.data) {
                _mdCache = raw.data;
                _mdCacheAt = raw.fetchedAt;
                return _mdCache;
            }
        }
    } catch { /* fall through to remote */ }
    try {
        const res = await fetch(MODELSDEV_URL, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        try {
            writeFileSync(mdCachePath(), JSON.stringify({ fetchedAt: Date.now(), data }));
        } catch { /* cache is best-effort */ }
        _mdCache = data;
        _mdCacheAt = Date.now();
        return data;
    } catch (err) {
        process.stderr.write(`[model-catalog] models.dev fetch failed: ${err.message}\n`);
        return _mdCache || {};
    }
}
export async function loadModelsDevCatalog() {
    if (_mdCache && (Date.now() - _mdCacheAt) < CATALOG_TTL_MS) return _mdCache;
    if (_mdLoadPromise) return _mdLoadPromise;
    _mdLoadPromise = _loadModelsDevImpl().finally(() => { _mdLoadPromise = null; });
    return _mdLoadPromise;
}
function warmModelsDevFromDiskSync() {
    if (_mdCache) return;
    try {
        const raw = JSON.parse(readFileSync(mdCachePath(), 'utf-8'));
        if (raw?.data) {
            _mdCache = raw.data;
            _mdCacheAt = raw.fetchedAt || Date.now();
        }
    } catch { /* cold — async loadModelsDevCatalog will fill later */ }
}
// Adapt a models.dev model row (cost in $/M) to the LiteLLM-shaped row that
// _normalize() consumes ($/token). Only fields present are emitted.
function _modelsDevRowToOverride(row) {
    const c = (row && row.cost) || {};
    const out = {
        max_input_tokens: row?.limit?.context,
        max_output_tokens: row?.limit?.output,
        mode: 'chat',
        supports_function_calling: row?.tool_call === true,
        supports_vision: Array.isArray(row?.modalities?.input) && row.modalities.input.includes('image'),
        supports_prompt_caching: c.cache_read != null,
    };
    if (c.input != null) out.input_cost_per_token = c.input / 1_000_000;
    if (c.output != null) out.output_cost_per_token = c.output / 1_000_000;
    if (c.cache_read != null) out.cache_read_input_token_cost = c.cache_read / 1_000_000;
    if (c.cache_write != null) out.cache_creation_input_token_cost = c.cache_write / 1_000_000;
    return out;
}
function _modelsDevMetadataSync(id, provider) {
    const pid = _modelsDevProviderId(provider);
    if (!pid) return null;
    if (!_mdCache) {
        warmModelsDevFromDiskSync();
        if (!_mdCache) { void loadModelsDevCatalog(); return null; }
    }
    const row = _mdCache?.[pid]?.models?.[id];
    if (!row || !row.cost) return null;
    return _normalize(_modelsDevRowToOverride(row));
}

/**
 * Sync lookup. Warm order:
 *   1. in-memory cache (hot path),
 *   2. disk cache one-shot read if memory is cold (first call after boot),
 *   3. null if neither is available (async loadCatalog will fill later).
 *
 * Used by hot-path loggers (bridge-trace usage row) that must not await.
 * The disk fallback is a single ~5ms blocking read on cold start; all
 * subsequent calls hit memory. TTL is intentionally ignored here — stale
 * catalog beats no catalog, and the async path refreshes on schedule.
 */
export function getModelMetadataSync(id, provider) {
    if (!id) return null;
    const mappedProvider = provider ? _modelsDevProviderId(provider) : null;
    // 1. Manual overrides — authoritative + offline. Provider-guarded: when a
    //    provider hint is given, an override is only honoured if it belongs to
    //    that provider, so a model id shared across providers (e.g.
    //    deepseek-v4-pro under `deepseek` vs `opencode-go`) never leaks the
    //    wrong provider's rate. Bare-id callers keep the legacy behaviour.
    const ov = PRICING_OVERRIDES[id];
    if (ov && (!mappedProvider || _modelsDevProviderId(ov.litellm_provider) === mappedProvider)) {
        return _normalize(ov);
    }
    // 2. LiteLLM community catalog (broad mainstream coverage).
    if (!_memCache) warmFromDiskSync();
    if (_memCache) {
        const catalog = _memCache;
        if (catalog[id]) return _normalize(catalog[id]);
        for (const prefix of _CATALOG_SIMPLE_PREFIXES) {
            if (catalog[prefix + id]) return _normalize(catalog[prefix + id]);
        }
        for (const prefix of _CATALOG_BEDROCK_PREFIXES) {
            const v1 = catalog[prefix + id + '-v1:0'];
            if (v1) return _normalize(v1);
        }
    }
    // 3. models.dev — provider-scoped gap filler (collision-free, auto 24h).
    //    Placed LAST so it never shadows the authoritative sources above; it
    //    only prices what LiteLLM/overrides do not cover (e.g. opencode-go).
    if (mappedProvider) {
        const md = _modelsDevMetadataSync(id, provider);
        if (md) return md;
    }
    return null;
}

function _normalize(entry) {
    if (!entry || typeof entry !== 'object') return null;
    return {
        contextWindow: entry.max_input_tokens || entry.max_tokens || null,
        outputTokens: entry.max_output_tokens || null,
        inputCostPerM: entry.input_cost_per_token != null ? entry.input_cost_per_token * 1_000_000 : null,
        outputCostPerM: entry.output_cost_per_token != null ? entry.output_cost_per_token * 1_000_000 : null,
        cacheReadCostPerM: entry.cache_read_input_token_cost != null ? entry.cache_read_input_token_cost * 1_000_000 : null,
        cacheWriteCostPerM: entry.cache_creation_input_token_cost != null ? entry.cache_creation_input_token_cost * 1_000_000 : null,
        supportsVision: entry.supports_vision === true,
        supportsFunctionCalling: entry.supports_function_calling === true,
        supportsPromptCaching: entry.supports_prompt_caching === true,
        mode: entry.mode || null,
    };
}

/**
 * Enrich a list of {id} models with catalog metadata in parallel. Missing
 * entries keep their original shape (no metadata) so callers can distinguish
 * "known in catalog" from "no metadata available".
 */
export async function enrichModels(models) {
    if (!Array.isArray(models)) return models;
    const catalog = await loadCatalog();
    return models.map(m => {
        const id = m.id || m.name;
        if (!id) return m;
        // Same lookup logic as getModelMetadata but inlined for speed.
        let entry = PRICING_OVERRIDES[id] || catalog[id];
        if (!entry) {
            for (const prefix of _CATALOG_ENRICH_PREFIXES) {
                if (catalog[prefix + id]) { entry = catalog[prefix + id]; break; }
            }
        }
        if (!entry) {
            for (const prefix of _CATALOG_BEDROCK_PREFIXES) {
                if (catalog[prefix + id + '-v1:0']) { entry = catalog[prefix + id + '-v1:0']; break; }
            }
        }
        const meta = entry ? _normalize(entry) : null;
        if (!meta) return m;
        return {
            ...m,
            // Provider-native limits are authoritative for request sizing.
            // External catalogs are pricing/metadata fillers and may describe
            // a public API SKU rather than the OAuth/backend route in use.
            contextWindow: m.contextWindow || meta.contextWindow || null,
            outputTokens: m.outputTokens || meta.outputTokens || null,
            inputCostPerM: meta.inputCostPerM,
            outputCostPerM: meta.outputCostPerM,
            cacheReadCostPerM: meta.cacheReadCostPerM,
            cacheWriteCostPerM: meta.cacheWriteCostPerM,
            supportsVision: meta.supportsVision,
            supportsFunctionCalling: meta.supportsFunctionCalling,
            supportsPromptCaching: meta.supportsPromptCaching,
            mode: meta.mode || m.mode || null,
        };
    });
}

/**
 * Force-refresh the catalog by ignoring cached data and re-fetching.
 * Exposed so a user-initiated "refresh catalog" action in the UI can
 * bypass the 24h TTL.
 */
export async function refreshCatalog() {
    _memCache = null;
    _memCacheAt = 0;
    _mdCache = null;
    _mdCacheAt = 0;
    try {
        if (existsSync(cachePath())) {
            const fs = await import('fs');
            fs.unlinkSync(cachePath());
        }
    } catch { /* ignore */ }
    try {
        if (existsSync(mdCachePath())) {
            const fs = await import('fs');
            fs.unlinkSync(mdCachePath());
        }
    } catch { /* ignore */ }
    const [litellm] = await Promise.all([loadCatalog(), loadModelsDevCatalog()]);
    return litellm;
}
