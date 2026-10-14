import { getModelMetadataSync } from '../../../shared/llm/model-catalog.mjs';

// Public Responses contracts are independent of the OAuth backend. Every
// capability here comes from the model catalog (the service-tier price columns
// and the cache-write rate), so a model the catalog lists works without an
// edit. Only a model no catalog describes (cold install) falls back to the
// documented ids known before the catalogs carried these columns.
const SNAPSHOT_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;
const PRE_CATALOG_GPT_56_PLUS =
  /^(?:gpt-6-(?:astra|sol|luna)|gpt-6\.1-sol|gpt-5\.6-(?:sol|terra|luna))(?:-\d{4}-\d{2}-\d{2})?$/;
const PRE_CATALOG_EARLIER_FAST = /^gpt-5\.(?:5|4|4-mini)(?:-\d{4}|$)/;
const PRE_CATALOG_ULTRAFAST = /^(?:gpt-6-astra|gpt-6\.1-sol)(?:-\d{4}-\d{2}-\d{2})?$/;
const modelId = (model) => String(model?.id || model || '').trim();

// The catalog metadata of one model. A dated snapshot reads as its undated
// alias when only the alias is listed.
function openAiCatalogMeta(model) {
  const id = String(model?.id || model || '').trim();
  for (const candidate of new Set([id, id.replace(SNAPSHOT_SUFFIX, '')])) {
    const meta = candidate ? getModelMetadataSync(candidate, 'openai') : null;
    if (meta) return meta;
  }
  return null;
}

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

// OpenAI bills prompt-cache writes from GPT-5.6 on, and exactly those models
// take prompt_cache_options in place of prompt_cache_retention, so a published
// cache-write rate selects the new form.
// https://developers.openai.com/api/docs/guides/prompt-caching
function promptCacheForm(model) {
  const writeRate = openAiCatalogMeta(model)?.cacheWriteCostPerM > 0;
  return writeRate || PRE_CATALOG_GPT_56_PLUS.test(modelId(model)) ? 'options' : 'retention';
}

export function applyOpenAIDirectCachePolicy(body, model, storeResponses) {
  body.store = storeResponses;
  delete body.prompt_cache_retention;
  delete body.prompt_cache_options;
  // Preserve the existing opt-out: no explicit cache-retention hint when
  // response storage is disabled. The provider's default cache still applies.
  if (!storeResponses) return body;
  const form = promptCacheForm(model);
  if (form === 'options') body.prompt_cache_options = { ttl: '30m' };
  else if (form === 'retention') body.prompt_cache_retention = '24h';
  return body;
}
