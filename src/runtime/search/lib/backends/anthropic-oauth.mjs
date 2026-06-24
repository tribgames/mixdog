/**
 * Anthropic OAuth search backend.
 *
 * Reuses agent.providers.anthropic-oauth credentials (Claude Pro/Max bearer).
 * Calls Messages API + web_search_20250305 server tool. Model is fixed to
 * claude-haiku-4-5 — sonnet/opus over OAuth is rate-limited by Anthropic
 * third-party policy (Jan 2026) and reserved for the agent itself.
 */
import { providerHttpError } from '../state.mjs'
import { AnthropicOAuthProvider } from '../../../agent/orchestrator/providers/anthropic-oauth.mjs'

const API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const BETA_HEADERS = 'oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,extended-cache-ttl-2025-04-11'
const MODEL = 'claude-haiku-4-5-20251001'
const SYSTEM_PROMPT = 'You are an assistant for performing a web search tool use. Use web_search to find current information and reply concisely with the answer and citations.'

// Reuse one provider instance across searches so its in-memory token cache
// survives between calls — avoids re-loading credentials on every search.
// ensureAuth() still re-validates via mtime + expiry per use.
let _sharedProvider = null
function getSharedProvider() {
  if (!_sharedProvider) _sharedProvider = new AnthropicOAuthProvider({})
  return _sharedProvider
}

export async function searchViaAnthropicOAuth({ query, site, maxResults = 5, locale, warnings = [], signal }) {
  const t0 = Date.now()
  const provider = getSharedProvider()
  await provider.ensureAuth({ reason: 'search' })
  const tok = provider.credentials?.access_token || provider.credentials?.accessToken
  if (!tok) throw new Error('[search:anthropic-oauth] no access_token available')
  const webSearchTool = { type: 'web_search_20250305', name: 'web_search', max_uses: 2 }
  if (site) webSearchTool.allowed_domains = [site]
  if (locale?.country || locale?.city || locale?.region || locale?.timezone) {
    webSearchTool.user_location = {
      type: 'approximate',
      ...(locale.country ? { country: locale.country } : {}),
      ...(locale.city ? { city: locale.city } : {}),
      ...(locale.region ? { region: locale.region } : {}),
      ...(locale.timezone ? { timezone: locale.timezone } : {}),
    }
  }

  const body = {
    model: MODEL,
    max_tokens: 1024,
    system: [{ type: 'text', text: SYSTEM_PROMPT }],
    messages: [{
      role: 'user',
      content: `${String(query)}\n\nReturn a concise answer and cite at most ${maxResults} source URLs.`,
    }],
    tools: [webSearchTool],
    tool_choice: { type: 'tool', name: 'web_search' },
    stream: false,
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${tok}`,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': BETA_HEADERS,
      'anthropic-dangerous-direct-browser-access': 'true',
      'user-agent': 'claude-cli/2.1.77 (external, sdk-cli)',
      'x-app': 'cli',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })

  if (res.status !== 200) {
    const text = await res.text()
    throw providerHttpError('anthropic-oauth', res.status, text)
  }
  const json = await res.json()
  const blocks = json?.content || []
  const answer = blocks.filter(b => b.type === 'text').map(b => b.text).join('').trim()
  const citations = []
  for (const b of blocks) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const c of b.content) {
        if (c?.url) citations.push({ title: c.title || '', url: c.url, snippet: '', source: 'anthropic-oauth' })
      }
    }
  }
  return {
    backend: 'anthropic-oauth',
    model: MODEL,
    query,
    answer,
    citations: citations.slice(0, maxResults),
    durationMs: Date.now() - t0,
    usage: json?.usage || null,
    warnings,
  }
}
