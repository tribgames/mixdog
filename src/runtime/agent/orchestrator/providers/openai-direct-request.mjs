// Public Responses contracts are independent of the OAuth backend.
// Match documented model IDs and dated snapshots, not unknown future families.
// GPT-5.6 and later: prompt_cache_options caching and Fast mode.
const GPT_56_PLUS_MODELS = /^(?:gpt-6-(?:astra|sol|luna)|gpt-5\.6-(?:sol|terra|luna))(?:-\d{4}-\d{2}-\d{2})?$/;
// Earlier models documented for Priority processing (now Fast mode).
const EARLIER_FAST_MODELS = /^gpt-5\.(?:5|4|4-mini)(?:-\d{4}|$)/;

export function openAiDirectSupportsFast(model) {
  const id = String(model?.id || model || '').trim();
  return GPT_56_PLUS_MODELS.test(id) || EARLIER_FAST_MODELS.test(id);
}

export function applyOpenAIDirectCachePolicy(body, model, storeResponses) {
  body.store = storeResponses;
  delete body.prompt_cache_retention;
  delete body.prompt_cache_options;
  // Preserve the existing opt-out: no explicit cache-retention hint when
  // response storage is disabled. The provider's default cache still applies.
  if (!storeResponses) return body;
  if (GPT_56_PLUS_MODELS.test(String(model || '').trim())) {
    body.prompt_cache_options = { ttl: '30m' };
  } else {
    body.prompt_cache_retention = '24h';
  }
  return body;
}
