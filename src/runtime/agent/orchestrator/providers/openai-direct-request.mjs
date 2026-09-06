// Public Responses cache contracts are independent of the OAuth backend.
// Match documented model IDs and dated snapshots, not unknown future families.
const CACHE_OPTIONS_MODELS = /^(?:gpt-6-astra|gpt-5\.6-(?:sol|terra|luna))(?:-\d{4}-\d{2}-\d{2})?$/;

export function applyOpenAIDirectCachePolicy(body, model, storeResponses) {
    body.store = storeResponses;
    delete body.prompt_cache_retention;
    delete body.prompt_cache_options;
    // Preserve the existing opt-out: no explicit cache-retention hint when
    // response storage is disabled. The provider's default cache still applies.
    if (!storeResponses) return body;
    if (CACHE_OPTIONS_MODELS.test(String(model || '').trim())) {
        body.prompt_cache_options = { ttl: '30m' };
    } else {
        body.prompt_cache_retention = '24h';
    }
    return body;
}
