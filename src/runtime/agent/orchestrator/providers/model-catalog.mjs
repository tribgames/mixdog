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
 * Overlay catalogs (LiteLLM + models.dev) refresh periodically.
 * Disk is a stale-ok fallback when the remote fetch fails. On fetch
 * failure with no disk copy, providers keep whatever metadata their
 * native endpoint exposed (usually nothing beyond the id).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getPluginData } from '../config.mjs';
import { writeJsonAtomicSync } from '../../../shared/atomic-file.mjs';
import {
  providerCachedModelMetadataSync,
  providerUsesEndpointScopedLimits,
  providerPricingModelSync,
  cachedProviderModelListsSync,
  providerCachedModelsSync,
} from './provider-catalog-cache.mjs';
import { litellmPricing, modelsDevPricing, PRICING_RATE_KEYS } from './model-pricing-rates.mjs';
// Both overlays are narrowed to their read surface before becoming resident;
// the disk caches below still receive the full payload.
import { projectLitellmCatalog, projectModelsDevCatalog } from './model-catalog-projection.mjs';

const CATALOG_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CATALOG_CACHE_FILE = 'litellm-catalog.json';

// Second auto pricing source: models.dev publishes per-PROVIDER model
// catalogs (cost in $/M) for 140+ providers — including ones LiteLLM does not
// track yet (e.g. opencode-go). Because it is keyed provider→model, a
// provider-scoped lookup is collision-free: deepseek-v4-pro under `deepseek`
// and under `opencode-go` resolve to their own distinct rates. Same
// periodic refresh + disk fallback as the LiteLLM catalog above.
const MODELSDEV_URL = 'https://models.dev/api.json';
const MODELSDEV_CACHE_FILE = 'modelsdev-catalog.json';
export const PRICING_CATALOG_REFRESH_MS = 6 * 60 * 60 * 1000;
const PRICING_CATALOG_RETRY_MS = 60_000;
let catalogRetryAt = 0;
let modelsDevRetryAt = 0;

// mixdog provider id → models.dev provider id. Identity for ids that already
// match (opencode-go / deepseek / xai / openai / anthropic / groq /
// mistral); only the OAuth aliases and gemini→google need remapping.
const _MODELSDEV_PROVIDER_ALIAS = {
  'anthropic-oauth': 'anthropic',
  'openai-oauth': 'openai',
  'grok-oauth': 'xai',
  gemini: 'google',
};
function _modelsDevProviderId(provider) {
  if (!provider) return null;
  const p = String(provider).toLowerCase();
  return _MODELSDEV_PROVIDER_ALIAS[p] || p;
}

// Relays sell access, not models: one subscription fronts Anthropic, Google,
// OpenAI and xAI SKUs at once. No catalog lists them under the relay's own
// name, so a provider-keyed lookup finds nothing and the route silently prices
// at zero — indistinguishable from a genuinely free local model.
const _RELAY_PROVIDERS = new Set(['cursor-oauth', 'cursor-api', 'antigravity-oauth']);

// Which vendor actually served a relayed model, read off the model id. This is
// a LAST resort: it runs only after the provider-keyed lookup has already
// failed, so a route with real catalog coverage can never be repriced by a
// name guess. Ids are matched on their leading family token rather than a bare
// substring, so an unrelated model that merely mentions a vendor is not
// adopted by it.
const _RELAYED_MODEL_VENDORS = [
  [/^claude[-.]/, 'anthropic'],
  [/^(gpt|o[1-9]|codex)[-.]/, 'openai'],
  [/^gemini[-.]/, 'google'],
  [/^grok[-.]/, 'xai'],
  [/^deepseek[-.]/, 'deepseek'],
];

function _relayedModelVendor(id) {
  const model = String(id || '').toLowerCase();
  if (!model) return null;
  for (const [pattern, vendor] of _RELAYED_MODEL_VENDORS) {
    if (pattern.test(model)) return vendor;
  }
  return null;
}

/** The vendor to reprice a relayed model under, or null to leave it alone. */
function _relayPricingProvider(provider, id) {
  if (!provider || !_RELAY_PROVIDERS.has(String(provider).toLowerCase())) return null;
  return _relayedModelVendor(id);
}

// Provider prefix variants used by the shared catalog resolver.
// A provider needing a new prefix adds it here.
// Source: LiteLLM catalog key conventions (see CATALOG_URL above).
const _CATALOG_SIMPLE_PREFIXES = [
  'anthropic/',
  'openai/',
  'gemini/',
  'google/',
  'xai/',
  'azure_ai/',
  'deepseek/',
  'openrouter/anthropic/',
  'openrouter/openai/',
];
// Bedrock-style variants: catalog key = <prefix><id>-v1:0
const _CATALOG_BEDROCK_PREFIXES = ['anthropic.', 'bedrock/anthropic.'];

// Provider hint → catalog prefixes to try (subset of _CATALOG_SIMPLE_PREFIXES).
// Keyed by the *mapped* models.dev provider id
// (see _modelsDevProviderId), so anthropic-oauth and anthropic share one
// entry, likewise grok-oauth/xai and gemini/google. A provider missing here
// (unknown/custom) gets bare-id lookup only — no prefix guessing across
// unrelated providers. No provider hint at all (mappedProvider null) keeps
// legacy behaviour: try every prefix.
const _PROVIDER_CATALOG_PREFIXES = {
  openai: ['openai/'],
  anthropic: ['anthropic/'],
  google: ['gemini/', 'google/'],
  xai: ['xai/'],
  deepseek: ['deepseek/'],
  azure: ['azure_ai/'],
};
function _prefixesForProvider(mappedProvider, allPrefixes) {
  if (!mappedProvider) return allPrefixes;
  const allowed = _PROVIDER_CATALOG_PREFIXES[mappedProvider];
  if (!allowed) return [];
  return allPrefixes.filter((p) => allowed.includes(p));
}
// Bedrock-style catalog keys (anthropic.<id>-v1:0) only ever describe
// Anthropic models; skip that lookup entirely for any other provider hint.
function _bedrockAllowed(mappedProvider) {
  return !mappedProvider || mappedProvider === 'anthropic';
}

// Polyfill for models the LiteLLM catalog does not list yet. Values mirror
// the catalog row shape so _normalize works unchanged. Source: each provider's
// official pricing page; do not extrapolate. Promotional discounts are
// intentionally NOT encoded — list rates only.
const XAI_GROK_420_ROW = Object.freeze({
  litellm_provider: 'xai',
  input_cost_per_token: 1.25e-6,
  output_cost_per_token: 2.5e-6,
  cache_read_input_token_cost: 0.2e-6,
  long_context_threshold: 200000,
  long_context_multiplier: 2,
  max_input_tokens: 1000000,
  mode: 'chat',
  supports_vision: true,
  supports_function_calling: true,
});
const XAI_GROK_420_IDS = Object.freeze([
  // https://docs.x.ai/developers/models/grok-4.20-0309-reasoning
  'grok-4.20-0309-reasoning',
  'grok-4.20-reasoning-latest',
  'grok-4.20',
  'grok-4.20-reasoning',
  'grok-4.20-0309',
  'grok-4.20-beta-0309-reasoning',
  'grok-4.20-beta',
  'grok-4.20-beta-0309',
  'grok-4.20-beta-latest',
  'grok-4.20-beta-latest-reasoning',
  'grok-4.20-beta-reasoning',
  'grok-4.20-experimental-beta-0304-reasoning',
  'grok-4.20-experimental-beta-0304',
  'grok-4.20-experimental-beta-reasoning-latest',
  'grok-4.20-experimental-beta-latest',
  'grok-4.20-reasoning-gv2',
  // https://docs.x.ai/developers/models/grok-4.20-0309-non-reasoning
  'grok-4.20-0309-non-reasoning',
  'grok-4.20-non-reasoning',
  'grok-4.20-non-reasoning-latest',
  'grok-4.20-beta-non-reasoning',
  'grok-4.20-beta-latest-non-reasoning',
  'grok-4.20-experimental-beta-0304-non-reasoning',
  'grok-4.20-experimental-beta-non-reasoning-latest',
  'grok-4.20-beta-0309-non-reasoning',
  'grok-4.20-non-reasoning-gv2',
  // https://docs.x.ai/developers/models/grok-4.20-multi-agent-beta-0309
  'grok-4.20-multi-agent-0309',
  'grok-4.20-multi-agent',
  'grok-4.20-multi-agent-latest',
  'grok-4.20-beta-0309-multi-agent',
]);

const PRICING_OVERRIDES = {
  ...Object.fromEntries(XAI_GROK_420_IDS.map((id) => [id, XAI_GROK_420_ROW])),
  // https://docs.x.ai/developers/models — Grok Build 0.1, 256k context.
  'grok-build-0.1': {
    litellm_provider: 'xai',
    input_cost_per_token: 1e-6,
    output_cost_per_token: 2e-6,
    max_input_tokens: 256000,
    mode: 'chat',
  },
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
  // https://api-docs.deepseek.com/quick_start/pricing — verified 2026-09-12.
  // Peak list rates; priceUsage applies the published UTC off-peak schedule.
  // The legacy Flash alias is now served and billed as DeepSeek-V4.1-Flash.
  'deepseek-flash': {
    litellm_provider: 'deepseek',
    input_cost_per_token: 3e-7,
    output_cost_per_token: 1.2e-6,
    cache_read_input_token_cost: 6e-9,
    off_peak_multiplier: 0.5,
    max_input_tokens: 1000000,
    max_output_tokens: 384000,
    mode: 'chat',
    supports_vision: true,
    supports_function_calling: true,
    supports_prompt_caching: true,
  },
  'deepseek-v4-flash': {
    litellm_provider: 'deepseek',
    input_cost_per_token: 3e-7,
    output_cost_per_token: 1.2e-6,
    cache_read_input_token_cost: 6e-9,
    off_peak_multiplier: 0.5,
    max_input_tokens: 1000000,
    max_output_tokens: 384000,
    mode: 'chat',
    supports_function_calling: true,
    supports_prompt_caching: true,
  },
  'deepseek-v4-pro': {
    litellm_provider: 'deepseek',
    input_cost_per_token: 1.32e-6,
    output_cost_per_token: 3.96e-6,
    cache_read_input_token_cost: 4.4e-8,
    off_peak_multiplier: 0.5,
    max_input_tokens: 1000000,
    max_output_tokens: 384000,
    mode: 'chat',
    supports_function_calling: true,
    supports_prompt_caching: true,
  },
};

let _memCache = null;
let _memCacheAt = 0;
// Disk warm must not count as "fetched this process" — otherwise a sync
// lookup before startup refresh would pin a stale overlay for the whole run.
let _catalogFetchedRemote = false;
// Single-flight: concurrent loadCatalog callers share the same in-flight
// Promise so a cold process only triggers one remote fetch.
let _loadPromise = null;

function cachePath() {
  return join(getPluginData(), CATALOG_CACHE_FILE);
}

function readDiskCatalog(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    return raw?.data ? raw : null;
  } catch {
    return null;
  }
}

async function _loadCatalogImpl(fetchFn = fetch) {
  try {
    const res = await fetchFn(CATALOG_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    try {
      writeJsonAtomicSync(
        cachePath(),
        { fetchedAt: Date.now(), data },
        { lock: true, compact: true, fsyncDir: true, timeoutMs: 1000 }
      );
    } catch {
      /* cache is best-effort */
    }
    _memCache = projectLitellmCatalog(data);
    _memCacheAt = Date.now();
    _catalogFetchedRemote = true;
    catalogRetryAt = 0;
    return _memCache;
  } catch (err) {
    process.stderr.write(`[model-catalog] fetch failed: ${err.message}\n`);
    _catalogFetchedRemote = false;
    catalogRetryAt = Date.now() + PRICING_CATALOG_RETRY_MS;
    const raw = readDiskCatalog(cachePath());
    if (raw?.data) {
      _memCache = projectLitellmCatalog(raw.data);
      _memCacheAt = raw.fetchedAt || Date.now();
      return _memCache;
    }
    return _memCache || {};
  }
}

async function _loadCatalogInjected(fetchFn) {
  try {
    const res = await fetchFn(CATALOG_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    process.stderr.write(`[model-catalog] injected fetch failed: ${err.message}\n`);
    return {};
  }
}

export async function loadCatalog({ fetchFn, force = false } = {}) {
  if (typeof fetchFn === 'function' && fetchFn !== fetch) {
    return _loadCatalogInjected(fetchFn);
  }
  if (
    !force &&
    ((_catalogFetchedRemote && _memCache && Date.now() - _memCacheAt < PRICING_CATALOG_REFRESH_MS) ||
      Date.now() < catalogRetryAt)
  )
    return _memCache || {};
  if (_loadPromise) return _loadPromise;
  _loadPromise = _loadCatalogImpl(fetchFn).finally(() => {
    _loadPromise = null;
  });
  return _loadPromise;
}

function warmFromDiskSync() {
  if (_memCache) return;
  try {
    const raw = JSON.parse(readFileSync(cachePath(), 'utf-8'));
    if (raw?.data) {
      _memCache = projectLitellmCatalog(raw.data);
      _memCacheAt = raw.fetchedAt || Date.now();
    }
  } catch {
    /* disk cache unavailable — stay cold, async warm will fill later */
  }
}

// ── models.dev catalog (second auto pricing source) ─────────────────────────
let _mdCache = null;
let _mdCacheAt = 0;
let _mdLoadPromise = null;
let _mdFetchedRemote = false;
function mdCachePath() {
  return join(getPluginData(), MODELSDEV_CACHE_FILE);
}
async function _loadModelsDevImpl(fetchFn = fetch) {
  try {
    const res = await fetchFn(MODELSDEV_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    try {
      writeJsonAtomicSync(
        mdCachePath(),
        { fetchedAt: Date.now(), data },
        { lock: true, compact: true, fsyncDir: true, timeoutMs: 1000 }
      );
    } catch {
      /* cache is best-effort */
    }
    _mdCache = projectModelsDevCatalog(data);
    _mdCacheAt = Date.now();
    _mdFetchedRemote = true;
    modelsDevRetryAt = 0;
    return _mdCache;
  } catch (err) {
    process.stderr.write(`[model-catalog] models.dev fetch failed: ${err.message}\n`);
    _mdFetchedRemote = false;
    modelsDevRetryAt = Date.now() + PRICING_CATALOG_RETRY_MS;
    const raw = readDiskCatalog(mdCachePath());
    if (raw?.data) {
      _mdCache = projectModelsDevCatalog(raw.data);
      _mdCacheAt = raw.fetchedAt || Date.now();
      return _mdCache;
    }
    return _mdCache || {};
  }
}
async function _loadModelsDevInjected(fetchFn) {
  try {
    const res = await fetchFn(MODELSDEV_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    process.stderr.write(`[model-catalog] models.dev injected fetch failed: ${err.message}\n`);
    return {};
  }
}
export async function loadModelsDevCatalog({ fetchFn, force = false } = {}) {
  if (typeof fetchFn === 'function' && fetchFn !== fetch) {
    return _loadModelsDevInjected(fetchFn);
  }
  if (
    !force &&
    ((_mdFetchedRemote && _mdCache && Date.now() - _mdCacheAt < PRICING_CATALOG_REFRESH_MS) ||
      Date.now() < modelsDevRetryAt)
  )
    return _mdCache || {};
  if (_mdLoadPromise) return _mdLoadPromise;
  _mdLoadPromise = _loadModelsDevImpl(fetchFn).finally(() => {
    _mdLoadPromise = null;
  });
  return _mdLoadPromise;
}
function warmModelsDevFromDiskSync() {
  if (_mdCache) return;
  try {
    const raw = JSON.parse(readFileSync(mdCachePath(), 'utf-8'));
    if (raw?.data) {
      _mdCache = projectModelsDevCatalog(raw.data);
      _mdCacheAt = raw.fetchedAt || Date.now();
    }
  } catch {
    /* cold — async loadModelsDevCatalog will fill later */
  }
}
// Human label from a models.dev row. Marketing tails such as "(New)",
// "(2x usage)", "(Unlimited)" are catalog commentary, not part of the name.
function modelsDevDisplayName(row) {
  const name = typeof row?.name === 'string' ? row.name : '';
  const cleaned = name
    .replace(/\s*\([^)]*\)\s*$/, '')
    // Program-tier suffix ("Muse Spark 1.3 Contributor"), not a model trait.
    .replace(/\s+contributor$/i, '')
    .trim();
  return cleaned || null;
}

// Capabilities share the metadata schema; prices stay in their native $/M unit.
function _modelsDevMetadata(row) {
  const c = row?.cost || {};
  const out = {
    max_input_tokens: row?.limit?.context,
    max_output_tokens: row?.limit?.output,
    mode: 'chat',
    supports_reasoning: row?.reasoning === true,
    reasoning_options: Array.isArray(row?.reasoning_options) ? row.reasoning_options : [],
    reasoning_content_field: row?.interleaved?.field || null,
    supports_function_calling: row?.tool_call === true,
    supports_vision: Array.isArray(row?.modalities?.input) && row.modalities.input.includes('image'),
    supports_prompt_caching: c.cache_read != null,
  };
  return { ..._normalize(out), ...modelsDevPricing(c), pricingSource: row?.cost ? 'models.dev' : null };
}

// Raw models.dev catalog row accessor for the model-list sanitizer's
// data-driven staleness filter. Pricing is not required: staleness only needs
// family/release_date. Returns the raw row untouched. Warms from disk if memory is cold;
// returns null when the catalog is unavailable so callers can skip filtering.
// Sync reads never start network work: session warmup owns remote catalog I/O,
// and injected/provider-local transports must remain request-hermetic.
// `_test` (tests only) injects a fake catalog map without touching disk.
export function getModelsDevRowSync(id, provider, _test) {
  if (!_test) warmModelsDevFromDiskSync();
  const cat = _test || _mdCache;
  if (!cat) return null;
  const pid = _modelsDevProviderId(provider);
  if (!pid) return null;
  const row = cat?.[pid]?.models?.[id];
  return row || null;
}

// All models.dev rows for a provider (mapped id), keyed by model id. Used by
// the sanitizer's family-supersession pass to compare release dates across a
// provider's whole catalog. Returns null when the catalog is cold/unavailable.
export function getModelsDevProviderModelsSync(provider, _test) {
  if (!_test) warmModelsDevFromDiskSync();
  const cat = _test || _mdCache;
  if (!cat) return null;
  const pid = _modelsDevProviderId(provider);
  if (!pid) return null;
  const models = cat?.[pid]?.models;
  return models && typeof models === 'object' ? models : null;
}

/**
 * Sync lookup. Warm order:
 *   1. in-memory cache (hot path),
 *   2. disk cache one-shot read if memory is cold (first call after boot),
 *   3. null if neither is available (async loadCatalog will fill later).
 *
 * Used by hot-path loggers (agent-trace usage row) that must not await.
 * The disk fallback is a single ~5ms blocking read on cold start; all
 * subsequent calls hit memory. TTL is intentionally ignored here — stale
 * catalog beats no catalog, and the async path refreshes on schedule.
 */
export function getModelMetadataSync(id, provider) {
  if (!id) return null;
  warmFromDiskSync();
  warmModelsDevFromDiskSync();
  return lookupModelMetadata(id, provider, _memCache || {}, _mdCache || {});
}

/** The transport's explicit pricing SKU wins. Grok's documented proxy
 * contract uses the requested SKU, not its internal response deployment id. */
export function resolveModelPricingIdentity(model, provider, { requestedModel, pricingModel } = {}) {
  const selected = pricingModel || (provider === 'grok-oauth' && requestedModel) || model;
  return {
    requestedModel: requestedModel || null,
    pricingModel: providerPricingModelSync(provider, selected),
    pricingProvider: provider,
  };
}

// Both list enrichment and synchronous accounting use this exact resolver.
function lookupModelMetadata(originalId, provider, catalog, modelsDevCatalog) {
  const id = providerPricingModelSync(provider, originalId);
  const mappedProvider = provider ? _modelsDevProviderId(provider) : null;
  const providerNative = provider ? providerCachedModelMetadataSync(provider, originalId) : null;
  let meta = null;
  // 1. Manual overrides — authoritative + offline. Provider-guarded: when a
  //    provider hint is given, an override is only honoured if it belongs to
  //    that provider, so a model id shared across providers (e.g.
  //    deepseek-v4-pro under `deepseek` vs `opencode-go`) never leaks the
  //    wrong provider's rate. Bare-id callers keep the legacy behaviour.
  const ov = PRICING_OVERRIDES[id];
  if (ov && (!mappedProvider || _modelsDevProviderId(ov.litellm_provider) === mappedProvider)) {
    meta = { ..._normalize(ov), pricingSource: 'override' };
  }
  const metaFromPricingOverride = meta !== null;
  // 2. LiteLLM community catalog (broad mainstream coverage).
  if (!meta) {
    if (catalog[id] && (!mappedProvider || _modelsDevProviderId(catalog[id].litellm_provider) === mappedProvider)) {
      meta = { ..._normalize(catalog[id]), pricingSource: 'litellm' };
    }
    for (const prefix of _prefixesForProvider(mappedProvider, _CATALOG_SIMPLE_PREFIXES)) {
      if (meta) break;
      if (catalog[prefix + id]) meta = { ..._normalize(catalog[prefix + id]), pricingSource: 'litellm' };
    }
    for (const prefix of _bedrockAllowed(mappedProvider) ? _CATALOG_BEDROCK_PREFIXES : []) {
      if (meta) break;
      const v1 = catalog[`${prefix + id}-v1:0`];
      if (v1) meta = { ..._normalize(v1), pricingSource: 'litellm' };
    }
  }
  // 3. models.dev — provider-scoped gap filler + capability overlay.
  //    Provider-scoped limits may replace generic LiteLLM rows for the same
  //    id, and add fields LiteLLM lacks, such as opencode-go reasoning_options.
  if (mappedProvider) {
    const row = modelsDevCatalog?.[mappedProvider]?.models?.[id];
    const md = row ? _modelsDevMetadata(row) : null;
    if (md)
      meta = mergeModelMetadata(meta, md, {
        preserveBaseCosts: metaFromPricingOverride,
        preserveBaseLimits: metaFromPricingOverride,
      });
    if (row) meta = { ...meta, displayName: modelsDevDisplayName(row) };
  }
  const relayVendor = _relayPricingProvider(provider, id);
  if (relayVendor && !PRICING_RATE_KEYS.some((key) => meta?.[key] != null)) {
    const relayed = lookupModelMetadata(id, relayVendor, catalog, modelsDevCatalog);
    if (relayed) meta = { ...relayed, contextWindow: null, outputTokens: null };
  }
  if (providerUsesEndpointScopedLimits(provider) && !providerNative && meta && !metaFromPricingOverride) {
    // OAuth/backend routes can expose smaller account/backend windows than
    // the public API SKU. External catalogs remain useful for costs and
    // capabilities, but their limits are not authoritative for these routes.
    meta = { ...meta, contextWindow: null, outputTokens: null };
  }
  if (providerNative) {
    // Provider cache limits are only authoritative for endpoint-scoped
    // routes (OAuth/backend), where the cached row reflects the live
    // account/backend window. For every other provider the cache is a
    // best-effort snapshot that can go stale, so it must NOT override the
    // catalog/known limits — otherwise this function returns cache limits
    // labelled as catalog data and downstream catalog-vs-cache staleness
    // checks (context-meta, statusline route-meta) compare stale-vs-stale
    // and can never correct an outdated cached window. Capabilities and
    // gap-filling (base limit null) still flow through the merge.
    const nativeLimitsAuthoritative = providerUsesEndpointScopedLimits(provider);
    meta = mergeModelMetadata(meta, providerNative, {
      preserveBaseCosts: true,
      preserveBaseLimits: metaFromPricingOverride || !nativeLimitsAuthoritative,
    });
  }
  return meta
    ? {
        ...meta,
        pricingModel: id,
        pricingProvider: meta.pricingProvider || mappedProvider || provider || null,
      }
    : null;
}

function _normalize(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    contextWindow: entry.max_input_tokens || entry.max_tokens || null,
    outputTokens: entry.max_output_tokens || null,
    ...litellmPricing(entry),
    ...(entry.long_context_threshold
      ? {
          longContextThreshold: entry.long_context_threshold,
          longContextMultiplier: entry.long_context_multiplier,
        }
      : {}),
    ...(entry.off_peak_multiplier ? { offPeakMultiplier: entry.off_peak_multiplier } : {}),
    supportsVision: entry.supports_vision === true,
    supportsFunctionCalling: entry.supports_function_calling === true,
    supportsWebSearch: entry.supports_web_search === true || entry.supports_websearch === true,
    supportsPromptCaching: entry.supports_prompt_caching === true,
    supportsReasoning: entry.supports_reasoning === true,
    reasoningOptions: Array.isArray(entry.reasoning_options) ? entry.reasoning_options : [],
    reasoningContentField: entry.reasoning_content_field || null,
    mode: entry.mode || null,
  };
}

function mergeModelMetadata(base, overlay, opts = {}) {
  if (!base) return overlay || null;
  if (!overlay) return base;
  return {
    ...base,
    contextWindow: opts.preserveBaseLimits
      ? base.contextWindow || overlay.contextWindow || null
      : overlay.contextWindow || base.contextWindow || null,
    outputTokens: opts.preserveBaseLimits
      ? base.outputTokens || overlay.outputTokens || null
      : overlay.outputTokens || base.outputTokens || null,
    // Provider-scoped models.dev rates beat generic base (LiteLLM) rates
    // when present — the overlay is the provider-scoped source, so a
    // non-null overlay value always wins over the generic fallback —
    // UNLESS base came from PRICING_OVERRIDES (preserveBaseCosts), which
    // is a hand-verified, authoritative rate that must not be clobbered
    // by a models.dev row for the same id.
    inputCostPerM:
      !opts.preserveBaseCosts && overlay.inputCostPerM != null ? overlay.inputCostPerM : base.inputCostPerM,
    outputCostPerM:
      !opts.preserveBaseCosts && overlay.outputCostPerM != null ? overlay.outputCostPerM : base.outputCostPerM,
    cacheReadCostPerM:
      !opts.preserveBaseCosts && overlay.cacheReadCostPerM != null ? overlay.cacheReadCostPerM : base.cacheReadCostPerM,
    cacheWriteCostPerM:
      !opts.preserveBaseCosts && overlay.cacheWriteCostPerM != null
        ? overlay.cacheWriteCostPerM
        : base.cacheWriteCostPerM,
    pricingTiers:
      !opts.preserveBaseCosts && overlay.pricingTiers?.length ? overlay.pricingTiers : base.pricingTiers || [],
    pricingSource:
      !opts.preserveBaseCosts && PRICING_RATE_KEYS.some((key) => overlay[key] != null)
        ? overlay.pricingSource
        : base.pricingSource,
    supportsVision: base.supportsVision || overlay.supportsVision,
    supportsFunctionCalling: base.supportsFunctionCalling || overlay.supportsFunctionCalling,
    supportsWebSearch: base.supportsWebSearch || overlay.supportsWebSearch,
    supportsPromptCaching: base.supportsPromptCaching || overlay.supportsPromptCaching,
    supportsReasoning: base.supportsReasoning || overlay.supportsReasoning,
    reasoningOptions: overlay.reasoningOptions?.length ? overlay.reasoningOptions : base.reasoningOptions || [],
    reasoningContentField: overlay.reasoningContentField || base.reasoningContentField || null,
    mode: base.mode || overlay.mode || null,
  };
}

/**
 * Enrich a list of {id} models with catalog metadata in parallel. Missing
 * entries keep their original shape (no metadata) so callers can distinguish
 * "known in catalog" from "no metadata available".
 */
export async function enrichModels(models, { fetchFn, force = false } = {}) {
  if (!Array.isArray(models)) return models;
  const catalog = await loadCatalog({ fetchFn, force });
  let modelsDevCatalog = _mdCache;
  if (models.some((m) => _modelsDevProviderId(m?.provider))) {
    try {
      modelsDevCatalog = await loadModelsDevCatalog({ fetchFn, force });
    } catch {
      /* optional gap filler */
    }
  }
  return models.map((m) => {
    const id = m.id || m.name;
    if (!id) return m;
    const meta = lookupModelMetadata(id, m.provider, catalog, modelsDevCatalog || {});
    if (!meta) return m;
    const catalogDisplay = meta.displayName;
    return {
      ...m,
      // Provider endpoints that expose no label (opencode-go /models)
      // borrow the catalog's human name; provider-supplied labels win.
      ...(catalogDisplay && !m.display ? { display: catalogDisplay } : {}),
      // Provider-native limits are authoritative for request sizing.
      // External catalogs are pricing/metadata fillers and may describe
      // a public API SKU rather than the OAuth/backend route in use.
      contextWindow: m.contextWindow || meta.contextWindow || null,
      outputTokens: m.outputTokens || meta.outputTokens || null,
      inputCostPerM: meta.inputCostPerM,
      outputCostPerM: meta.outputCostPerM,
      cacheReadCostPerM: meta.cacheReadCostPerM,
      cacheWriteCostPerM: meta.cacheWriteCostPerM,
      pricingTiers: meta.pricingTiers,
      pricingModel: meta.pricingModel,
      pricingProvider: meta.pricingProvider,
      pricingSource: meta.pricingSource,
      supportsVision: m.supportsVision === true || meta.supportsVision,
      supportsFunctionCalling: m.supportsFunctionCalling === true || meta.supportsFunctionCalling,
      supportsWebSearch: meta.supportsWebSearch || m.supportsWebSearch === true,
      supportsPromptCaching: m.supportsPromptCaching === true || meta.supportsPromptCaching,
      supportsReasoning: m.supportsReasoning === true || meta.supportsReasoning,
      reasoningOptions: m.reasoningOptions?.length ? m.reasoningOptions : meta.reasoningOptions || [],
      reasoningContentField: meta.reasoningContentField || m.reasoningContentField || null,
      mode: meta.mode || m.mode || null,
    };
  });
}

/** Include wire ids, not just picker rows, in automatic price coverage. */
export function auditModelPricing(models, provider) {
  const rows = [];
  for (const model of models || []) {
    const ids = new Set(
      [model.id, ...(typeof model.wire === 'string' ? [model.wire] : Object.values(model.wire || {}))].filter(Boolean)
    );
    for (const id of ids) {
      const owner = provider || model.provider;
      const meta = getModelMetadataSync(id, owner);
      const required = [
        'inputCostPerM',
        'outputCostPerM',
        ...(meta?.supportsPromptCaching ? ['cacheReadCostPerM'] : []),
      ];
      const missingRates = required.filter((key) => meta?.[key] == null);
      rows.push({
        provider: owner,
        model: id,
        pricingModel: meta?.pricingModel || providerPricingModelSync(owner, id),
        pricingProvider: meta?.pricingProvider || owner,
        pricingSource: meta?.pricingSource || null,
        priced: missingRates.length === 0,
        missingRates,
      });
    }
  }
  return rows;
}

export function pricingCatalogRevisionSync() {
  warmFromDiskSync();
  warmModelsDevFromDiskSync();
  const aliases = providerCachedModelsSync('antigravity-oauth').map(({ id, wire, pricingModel }) => ({
    id,
    wire,
    pricingModel,
  }));
  return createHash('sha256')
    .update(JSON.stringify([2, _memCacheAt, _mdCacheAt, aliases]))
    .digest('hex');
}

let lastAuditedRevision = null;
function auditCachedModelPricing() {
  const revision = pricingCatalogRevisionSync();
  const rows = Object.entries(cachedProviderModelListsSync()).flatMap(([provider, models]) =>
    auditModelPricing(models, provider)
  );
  const unpriced = rows.filter((row) => !row.priced);
  if (revision !== lastAuditedRevision && unpriced.length) {
    process.stderr.write(
      `[model-pricing] ${unpriced.length}/${rows.length} catalog routes have no complete price: ${unpriced
        .map((row) => `${row.provider}/${row.model} (${row.missingRates.join(', ')})`)
        .join('; ')}\n`
    );
  }
  lastAuditedRevision = revision;
  return { revision, rows, unpriced };
}

/**
 * Force-refresh the catalog by ignoring cached data and re-fetching.
 * Exposed so a user-initiated "refresh catalog" action in the UI can
 * bypass the periodic overlay cache.
 */
export async function refreshCatalog() {
  // A failed refresh must retain the last usable price table on disk.
  const [litellm] = await Promise.all([loadCatalog({ force: true }), loadModelsDevCatalog({ force: true })]);
  auditCachedModelPricing();
  return litellm;
}

export async function warmModelMetadataCatalogs() {
  const [litellm] = await Promise.all([loadCatalog(), loadModelsDevCatalog()]);
  return litellm;
}

/** Refresh both overlays together before auditing the combined price table. */
export async function warmCatalogsInBackground() {
  try {
    await Promise.all([loadCatalog(), loadModelsDevCatalog()]);
    auditCachedModelPricing();
  } catch {
    /* never throw — boot/statusline must not fail on catalog warm */
  }
  return { retryAfterMs: catalogRetryAt || modelsDevRetryAt ? PRICING_CATALOG_RETRY_MS : PRICING_CATALOG_REFRESH_MS };
}
