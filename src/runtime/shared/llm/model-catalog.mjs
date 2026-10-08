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
import { resolvePluginData } from '../plugin-paths.mjs';
import { writeJsonAtomicSync } from '../atomic-file.mjs';
import {
  providerCachedModelMetadataSync,
  providerUsesEndpointScopedLimits,
  providerPricingModelSync,
  cachedProviderModelListsSync,
  providerCachedModelsSync,
} from './provider-catalog-cache.mjs';
import { litellmMediaPricing, litellmPricing, modelsDevPricing, PRICING_RATE_KEYS } from './model-pricing-rates.mjs';
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
const _RELAY_PROVIDERS = new Set(['cursor-oauth', 'cursor-api', 'antigravity-oauth', 'opencode-go']);

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
  [/^kimi[-.]/, 'moonshotai'],
  [/^glm[-.]/, 'zai'],
  [/^muse[-.]/, 'meta'],
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

// Hand-verified rows for SKUs no external catalog prices correctly: ids only
// served under a relay name, or catalogs carrying promotional rates. A row
// whose rates LiteLLM/models.dev now publish belongs to those catalogs, not
// here. Values mirror the LiteLLM row shape so _normalize works unchanged.
// Source: each provider's official pricing page; list rates only.
const PRICING_OVERRIDES = {
  // https://ai.google.dev/gemini-api/docs/pricing — Gemini 3 Flash list rates
  // (published for the preview id), verified 2026-09-22.
  'gemini-3-flash': {
    litellm_provider: 'gemini',
    input_cost_per_token: 0.5e-6,
    output_cost_per_token: 3e-6,
    cache_read_input_token_cost: 0.05e-6,
    mode: 'chat',
    supports_vision: true,
    supports_function_calling: true,
    supports_prompt_caching: true,
  },
  // https://ai.google.dev/gemini-api/docs/pricing — Gemini 3.1 Pro list rates
  // (published for the preview id), tiered above 200k prompt tokens.
  'gemini-3.1-pro': {
    litellm_provider: 'gemini',
    input_cost_per_token: 2e-6,
    input_cost_per_token_above_200k_tokens: 4e-6,
    output_cost_per_token: 12e-6,
    output_cost_per_token_above_200k_tokens: 18e-6,
    cache_read_input_token_cost: 0.2e-6,
    cache_read_input_token_cost_above_200k_tokens: 0.4e-6,
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

function readDiskCatalog(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    return raw?.data ? raw : null;
  } catch {
    return null;
  }
}

// One remote price/metadata overlay: an in-memory projection, a stale-ok disk
// copy, a retry backoff after a failed fetch and a single-flight loader.
function createCatalogSource({ url, cacheFile, project, label = '' }) {
  let cache = null;
  let cacheAt = 0;
  // Disk warm must not count as "fetched this process" — otherwise a sync
  // lookup before startup refresh would pin a stale overlay for the whole run.
  let fetchedRemote = false;
  // Single-flight: concurrent load callers share the same in-flight Promise
  // so a cold process only triggers one remote fetch.
  let loadPromise = null;
  let retryAt = 0;
  const cachePath = () => join(resolvePluginData(), cacheFile);

  async function loadImpl(fetchFn = fetch) {
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
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
      cache = project(data);
      cacheAt = Date.now();
      fetchedRemote = true;
      retryAt = 0;
      return cache;
    } catch (err) {
      process.stderr.write(`[model-catalog] ${label}fetch failed: ${err.message}\n`);
      fetchedRemote = false;
      retryAt = Date.now() + PRICING_CATALOG_RETRY_MS;
      const raw = readDiskCatalog(cachePath());
      if (raw?.data) {
        cache = project(raw.data);
        cacheAt = raw.fetchedAt || Date.now();
        return cache;
      }
      return cache || {};
    }
  }

  async function loadInjected(fetchFn) {
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      process.stderr.write(`[model-catalog] ${label}injected fetch failed: ${err.message}\n`);
      return {};
    }
  }

  return {
    get cache() {
      return cache;
    },
    get cacheAt() {
      return cacheAt;
    },
    get retryAt() {
      return retryAt;
    },
    async load({ fetchFn, force = false } = {}) {
      if (typeof fetchFn === 'function' && fetchFn !== fetch) return loadInjected(fetchFn);
      if (
        !force &&
        ((fetchedRemote && cache && Date.now() - cacheAt < PRICING_CATALOG_REFRESH_MS) || Date.now() < retryAt)
      ) {
        return cache || {};
      }
      if (loadPromise) return loadPromise;
      loadPromise = loadImpl(fetchFn).finally(() => {
        loadPromise = null;
      });
      return loadPromise;
    },
    warmFromDiskSync() {
      if (cache) return;
      try {
        const raw = JSON.parse(readFileSync(cachePath(), 'utf-8'));
        if (raw?.data) {
          cache = project(raw.data);
          cacheAt = raw.fetchedAt || Date.now();
        }
      } catch {
        /* disk cache unavailable — stay cold, the async load will fill later */
      }
    },
  };
}

const litellmSource = createCatalogSource({
  url: CATALOG_URL,
  cacheFile: CATALOG_CACHE_FILE,
  project: projectLitellmCatalog,
});
// models.dev is the second auto pricing source (see MODELSDEV_URL).
const modelsDevSource = createCatalogSource({
  url: MODELSDEV_URL,
  cacheFile: MODELSDEV_CACHE_FILE,
  project: projectModelsDevCatalog,
  label: 'models.dev ',
});

export function loadCatalog(options) {
  return litellmSource.load(options);
}
export function loadModelsDevCatalog(options) {
  return modelsDevSource.load(options);
}
const warmFromDiskSync = () => litellmSource.warmFromDiskSync();
const warmModelsDevFromDiskSync = () => modelsDevSource.warmFromDiskSync();

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
  const cat = _test || modelsDevSource.cache;
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
  const cat = _test || modelsDevSource.cache;
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
  return lookupModelMetadata(id, provider, litellmSource.cache || {}, modelsDevSource.cache || {});
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

// Provider SKUs published only as a fixed multiple of a base SKU's rates.
// Applied only while no catalog prices the variant itself.
const PRICED_VARIANTS = Object.freeze({
  'grok-oauth': Object.freeze({
    // Grok CLI proxy /models: "Fast variant. 2x the price."
    'grok-4.7-build-fast': Object.freeze({ base: 'grok-4.7', rateMultiplier: 2 }),
  }),
});

// Cursor-billed rates no catalog publishes: Cursor's first-party SKUs and Fast
// rates Cursor sells beyond the vendor's own catalog. `fast` is the rate of a
// request Cursor ran in Fast mode. Other Cursor Fast requests bill at the
// vendor's Fast rate (Anthropic fast mode, OpenAI Priority/Fast).
// Source: https://cursor.com/docs/models-and-pricing — list $/M, verified 2026-09-30.
const CURSOR_PRICING = Object.freeze({
  'composer-2.5': {
    inputCostPerM: 0.5,
    cacheReadCostPerM: 0.2,
    outputCostPerM: 2.5,
    fast: { inputCostPerM: 3, cacheReadCostPerM: 0.5, outputCostPerM: 15 },
  },
  'grok-4.7': {
    fast: {
      inputCostPerM: 4,
      cacheReadCostPerM: 1,
      outputCostPerM: 12,
      // Fast long context (>256k input) bills at 3x the standard rates.
      pricingTiers: [{ aboveInputTokens: 256000, inputCostPerM: 6, cacheReadCostPerM: 1.5, outputCostPerM: 18 }],
    },
  },
  'grok-4.6': { fast: { inputCostPerM: 4, cacheReadCostPerM: 1, outputCostPerM: 12 } },
  'grok-4.5': { fast: { inputCostPerM: 4, cacheReadCostPerM: 1, outputCostPerM: 18 } },
  'claude-opus-4-7': {
    fast: { inputCostPerM: 30, cacheWriteCostPerM: 37.5, cacheReadCostPerM: 3, outputCostPerM: 150 },
  },
});

function listedRates(row) {
  return {
    ...Object.fromEntries(PRICING_RATE_KEYS.map((key) => [key, row[key] ?? null])),
    pricingTiers: (row.pricingTiers || []).map((tier) => ({
      aboveInputTokens: tier.aboveInputTokens,
      ...Object.fromEntries(PRICING_RATE_KEYS.map((key) => [key, tier[key] ?? null])),
    })),
  };
}

function scaledRates(row, factor) {
  return Object.fromEntries(PRICING_RATE_KEYS.map((key) => [key, row?.[key] == null ? null : row[key] * factor]));
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
    // Anthropic SKUs spell versions with hyphens (claude-opus-5-5); relays
    // may list the same SKU with dots (claude-opus-5.5).
    const vendorId = relayVendor === 'anthropic' ? id.replace(/(\d)\.(\d)/g, '$1-$2') : id;
    const relayed = lookupModelMetadata(vendorId, relayVendor, catalog, modelsDevCatalog);
    if (relayed) meta = { ...relayed, contextWindow: null, outputTokens: null };
  }
  const variant = PRICED_VARIANTS[String(provider || '').toLowerCase()]?.[id];
  if (variant && !PRICING_RATE_KEYS.some((key) => meta?.[key] != null)) {
    const base = lookupModelMetadata(variant.base, provider, catalog, modelsDevCatalog);
    if (base && PRICING_RATE_KEYS.some((key) => base[key] != null)) {
      meta = {
        ...meta,
        ...scaledRates(base, variant.rateMultiplier),
        pricingTiers: (base.pricingTiers || []).map((tier) => ({
          ...tier,
          ...scaledRates(tier, variant.rateMultiplier),
        })),
        pricingSource: base.pricingSource,
        supportsPromptCaching: base.supportsPromptCaching,
      };
    }
  }
  const cursorRow = /^cursor-(?:oauth|api)$/.test(String(provider || '').toLowerCase()) ? CURSOR_PRICING[id] : null;
  if (cursorRow) {
    if (!PRICING_RATE_KEYS.some((key) => meta?.[key] != null)) {
      meta = { ...meta, ...listedRates(cursorRow), pricingSource: 'override' };
    }
    if (cursorRow.fast) meta = { ...meta, fastPricing: listedRates(cursorRow.fast) };
  }
  if (providerUsesEndpointScopedLimits(provider) && !providerNative && meta) {
    // OAuth/backend routes can expose smaller account/backend windows than
    // the public API SKU. External catalogs and manual overrides remain useful
    // for costs and capabilities, but their public-SKU limits are not
    // authoritative for these routes.
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
      preserveBaseLimits: !nativeLimitsAuthoritative,
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
  // OpenAI's Priority processing (since renamed Fast mode) columns.
  const fastPricing = litellmPricing(entry, '_priority');
  return {
    contextWindow: entry.max_input_tokens || entry.max_tokens || null,
    outputTokens: entry.max_output_tokens || null,
    ...litellmPricing(entry),
    ...litellmMediaPricing(entry),
    ...(PRICING_RATE_KEYS.some((key) => fastPricing[key] != null) ? { fastPricing } : {}),
    ...(entry.off_peak_multiplier ? { offPeakMultiplier: entry.off_peak_multiplier } : {}),
    supportsVision: entry.supports_vision === true,
    supportsFunctionCalling: entry.supports_function_calling === true,
    supportsWebSearch: entry.supports_web_search === true || entry.supports_websearch === true,
    supportsPromptCaching: entry.supports_prompt_caching === true,
    supportsFastMode: entry.supports_fast_mode === true,
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
    supportsFastMode: base.supportsFastMode || overlay.supportsFastMode,
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
  let modelsDevCatalog = modelsDevSource.cache;
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
    .update(JSON.stringify([2, litellmSource.cacheAt, modelsDevSource.cacheAt, aliases]))
    .digest('hex');
}

let lastAuditedRevision = null;
let lastAudit = null;
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
  lastAudit = { revision, rows, unpriced };
  return lastAudit;
}

/** Catalog routes without a complete list price, from the latest audit (run on demand when none is cached). */
export function unpricedModelsSync() {
  return (lastAudit ?? auditCachedModelPricing()).unpriced.map(({ provider, model, missingRates }) => ({
    provider,
    model,
    missingRates: [...missingRates],
  }));
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
  return {
    retryAfterMs:
      litellmSource.retryAt || modelsDevSource.retryAt ? PRICING_CATALOG_RETRY_MS : PRICING_CATALOG_REFRESH_MS,
  };
}
