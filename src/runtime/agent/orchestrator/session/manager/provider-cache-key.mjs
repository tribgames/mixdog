// manager/provider-cache-key.mjs
// Provider-scoped unified cache key extracted verbatim from manager.mjs. Goal:
// all orchestrator-internal dispatches (agent/maintenance/mcp/scheduler/webhook)
// targeting the same provider land in a single server-side cache shard, so the
// shared prefix (tools + system + pool system prompt) is reused regardless of
// role. Per-role / per-session differentiation lives after the system prefix
// (BP3 sessionMarker system block / later messages), which is naturally
// separated by provider-side content hashing.
const PROVIDER_ALIAS = {
    'openai-oauth': 'codex',      // ChatGPT subscription (OpenAI OAuth backend)
    'anthropic-oauth': 'claude',  // Claude Max subscription
    'openai': 'openai',
    'anthropic': 'anthropic',
    'gemini': 'gemini',
    'deepseek': 'deepseek',
    'xai': 'xai',
};
export function providerCacheKey(provider, override) {
    if (override) return String(override);
    if (!provider) return 'mixdog-default';
    return `mixdog-${PROVIDER_ALIAS[provider] || provider}`;
}
