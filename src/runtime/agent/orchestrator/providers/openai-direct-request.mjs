import {
  openAiCatalogMeta,
  openAiSupportsExtendedRetention,
  openAiUsesPromptCacheOptions,
} from './openai-model-capabilities.mjs';

// Public Responses contracts are independent of the OAuth backend. Service
// tiers come from the model catalog (the service-tier price columns), so a
// model the catalog lists works without an edit. Only a model no catalog
// describes (cold install) falls back to the documented ids known before the
// catalogs carried these columns.
const PRE_CATALOG_GPT_56_PLUS =
  /^(?:gpt-6-(?:astra|sol|luna)|gpt-6\.1-sol|gpt-5\.6-(?:sol|terra|luna))(?:-\d{4}-\d{2}-\d{2})?$/;
const PRE_CATALOG_EARLIER_FAST = /^gpt-5\.(?:5|4|4-mini)(?:-\d{4}|$)/;
const PRE_CATALOG_ULTRAFAST = /^(?:gpt-6-astra|gpt-6\.1-sol)(?:-\d{4}-\d{2}-\d{2})?$/;
const modelId = (model) => String(model?.id || model || '').trim();

export function openAiDirectSupportsFast(model) {
  const meta = openAiCatalogMeta(model);
  // The catalog's declaration (true or false) decides; a published Priority
  // rate is the same declaration. A row silent on Fast keeps the documented ids.
  if (typeof meta?.supportsFastMode === 'boolean') return meta.supportsFastMode;
  if (meta?.fastPricing) return true;
  const id = modelId(model);
  return PRE_CATALOG_GPT_56_PLUS.test(id) || PRE_CATALOG_EARLIER_FAST.test(id);
}

// A published Ultrafast rate (the `_ultrafast` price columns) is the tier's
// declaration; a row silent on it keeps the documented ids.
export function openAiDirectSupportsUltrafast(model) {
  if (openAiCatalogMeta(model)?.ultrafastPricing) return true;
  return PRE_CATALOG_ULTRAFAST.test(modelId(model));
}

// https://developers.openai.com/api/docs/guides/prompt-caching
// GPT-5.6 and later: prompt_cache_options.ttl. Earlier models: 24h
// prompt_cache_retention only on the documented extended-retention list;
// every other model gets no lifetime field (never inferred from pricing).
function promptCacheForm(model) {
  if (openAiUsesPromptCacheOptions(model) || PRE_CATALOG_GPT_56_PLUS.test(modelId(model))) return 'options';
  return openAiSupportsExtendedRetention(model) ? 'retention' : null;
}

// The environment developer item buildRequestBody places first in `input`:
// the end of the session's stable prefix (tools + instructions + environment).
// Top-level `instructions` cannot carry a breakpoint, so this is the earliest
// place one fits.
function stablePrefixBlock(body) {
  const first = Array.isArray(body.input) ? body.input[0] : null;
  const content = first?.type === 'message' && first.role === 'developer' ? first.content : null;
  const block = Array.isArray(content) && content.length === 1 ? content[0] : null;
  return block?.type === 'input_text' && String(block.text || '').startsWith('<environment_context>') ? block : null;
}

/**
 * Public-API cache lifetime fields. GPT-5.6+: request ttl "30m" for the
 * moving tail; `prefixTtl` '12h' (Lead class, cache-strategy.mjs
 * resolveOpenAiPrefixCacheTtl) adds one explicit 12h breakpoint at the end of
 * the stable prefix in the default implicit mode, so the implicit tail
 * breakpoint stays 30m. Earlier models are unchanged.
 */
export function applyOpenAIDirectCachePolicy(body, model, storeResponses, { prefixTtl = null } = {}) {
  body.store = storeResponses;
  delete body.prompt_cache_retention;
  delete body.prompt_cache_options;
  // Preserve the existing opt-out: no explicit cache-retention hint when
  // response storage is disabled. The provider's default cache still applies.
  if (!storeResponses) return body;
  const form = promptCacheForm(model);
  if (form === 'options') {
    body.prompt_cache_options = { ttl: '30m' };
    const block = prefixTtl === '12h' ? stablePrefixBlock(body) : null;
    if (block) {
      const [first, ...rest] = body.input;
      body.input = [
        { ...first, content: [{ ...block, prompt_cache_breakpoint: { mode: 'explicit', ttl: '12h' } }] },
        ...rest,
      ];
    }
  } else if (form === 'retention') body.prompt_cache_retention = '24h';
  return body;
}
