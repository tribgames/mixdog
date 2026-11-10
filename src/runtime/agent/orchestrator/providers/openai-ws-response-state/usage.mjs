import { extractCacheWriteTokens, extractCachedTokens } from '../../agent-trace.mjs';

export function normalizeWsUsage(u, serviceTier) {
  return {
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    cachedTokens: extractCachedTokens(u),
    cacheWriteTokens: extractCacheWriteTokens(u),
    // openai-oauth reports input_tokens as the total prompt volume (cached
    // portion is a subset, not additive). Alias into the cross-provider
    // `promptTokens` field so downstream loggers have uniform semantics.
    promptTokens: u.input_tokens || 0,
    raw: serviceTier ? { ...u, service_tier: serviceTier } : u,
  };
}
