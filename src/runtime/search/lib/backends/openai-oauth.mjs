/**
 * OpenAI OAuth (Codex backend) search backend.
 *
 * Reuses agent.providers.openai-oauth credentials (ChatGPT Pro bearer).
 * Calls Codex WebSocket endpoint via sendViaWebSocket with web_search server
 * tool. Model is config-driven (search.models.openai default 'gpt-5.4-mini').
 */
import {
  OpenAIOAuthProvider,
  ensureLatestCodexModel,
  codexModelSupportsServiceTier,
} from '../../../agent/orchestrator/providers/openai-oauth.mjs'
import {
  OPENAI_SEARCH_SYSTEM_INSTRUCTIONS,
  buildOpenAISearchPrompt,
  buildOpenAIWebSearchTool,
  citationsFromText,
  citationsFromWebSearchCalls,
} from './openai-web-search.mjs'

const SEARCH_POOL_KEY = 'mixdog-search-openai-oauth'
const SEARCH_CACHE_KEY = 'mixdog-codex-search'

// Reuse one provider instance across searches so its in-memory token cache
// survives between calls — avoids re-loading credentials on every search.
// ensureAuth() still re-validates via mtime + expiry per use.
let _sharedProvider = null
function getSharedProvider() {
  if (!_sharedProvider) _sharedProvider = new OpenAIOAuthProvider({})
  return _sharedProvider
}

export async function searchViaOpenAIOAuth({
  query,
  model,
  effort,
  fast = false,
  site,
  type = 'web',
  maxResults = 5,
  locale,
  contextSize = 'low',
  warnings = [],
  signal,
}) {
  const t0 = Date.now()
  const provider = getSharedProvider()
  const useModel = model || await ensureLatestCodexModel(provider)
  await provider.ensureAuth({ reason: 'search' })
  const tokens = provider.tokens
  if (!tokens?.access_token) throw new Error('[search:openai-oauth] no access_token available')

  // Match the bridge invariant: poolKey is the local socket bucket, cacheKey is
  // the server-side prompt-cache shard. Keep them stable and distinct.
  const poolKey = SEARCH_POOL_KEY
  const cacheKey = SEARCH_CACHE_KEY
  // Effort defaults to 'low' when caller doesn't specify — preserves the
  // prior hard-coded behavior so older configs without modelOptions still
  // route through the same low-latency path.
  const body = {
    model: useModel,
    instructions: OPENAI_SEARCH_SYSTEM_INSTRUCTIONS,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: buildOpenAISearchPrompt(query, maxResults) }] }],
    store: false,
    stream: true,
    prompt_cache_key: cacheKey,
    reasoning: { effort: effort || 'low' },
    text: { verbosity: 'low' },
    tool_choice: 'auto',
    parallel_tool_calls: false,
    tools: [buildOpenAIWebSearchTool({ site, type, locale, contextSize })],
  }
  if (fast === true && codexModelSupportsServiceTier(useModel, 'priority')) body.service_tier = 'priority'
  // Route through provider.send() (not sendViaWebSocket directly) so the search
  // request inherits the 401/403 force-refresh retry + HTTP/SSE fallback. A
  // stale token or unhealthy WebSocket then recovers instead of hard-failing.
  // _prebuiltBody bypasses buildRequestBody — the web_search server-tool body
  // shape it can't express is shipped verbatim. poolKey/cacheKey map onto
  // sessionId/providerCacheKey to preserve the prior socket/cache sharding.
  const result = await provider.send(null, useModel, null, {
    _prebuiltBody: body,
    sessionId: poolKey,
    providerCacheKey: cacheKey,
    iteration: 0,
    signal,
  })
  const answer = String(result?.content || '').trim()
  let citations = Array.isArray(result?.citations) ? result.citations.slice(0, maxResults) : []
  if (!citations.length) citations = citationsFromText(answer, maxResults, 'openai-oauth')
  if (!citations.length) citations = citationsFromWebSearchCalls(result?.webSearchCalls, maxResults, 'openai-oauth')
  return {
    backend: 'openai-oauth',
    model: useModel,
    query,
    answer,
    citations,
    durationMs: Date.now() - t0,
    usage: result?.usage || null,
    webSearchCalls: result?.webSearchCalls || [],
    warnings,
  }
}
