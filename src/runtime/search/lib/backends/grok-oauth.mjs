/**
 * Grok (xAI) OAuth search backend.
 *
 * Same Responses API + web_search (Agent Tools) call as xai-api.mjs, but the
 * Bearer is a refreshable OAuth access token from the Grok OAuth provider
 * ("Grok Build" consent / ~/.grok/auth.json) instead of a static API key.
 * Verified: this OAuth token drives api.x.ai/v1 /responses with the web_search
 * server tool and returns real citations. Auth + refresh are owned by
 * GrokOAuthProvider.ensureAuth().
 */
import { providerHttpError } from '../state.mjs'
import { GrokOAuthProvider, ensureLatestGrokModel, normalizeGrokModelId } from '../../../agent/orchestrator/providers/grok-oauth.mjs'

const URL = 'https://api.x.ai/v1/responses'

// Reuse one provider instance across searches so its in-memory token cache
// (this.tokens) survives between calls — avoids re-reading grok-oauth.json on
// every search. ensureAuth() still re-validates via mtime + expiry per use.
let _sharedProvider = null
function getSharedProvider() {
  if (!_sharedProvider) _sharedProvider = new GrokOAuthProvider({})
  return _sharedProvider
}

export async function searchViaGrokOAuth({ query, model, maxResults = 5, warnings = [], signal }) {
  const t0 = Date.now()
  const provider = getSharedProvider()
  const useModel = normalizeGrokModelId(
    model || await ensureLatestGrokModel(provider),
  )
  const tokens = await provider.ensureAuth()
  if (!tokens?.access_token) throw new Error('[search:grok-oauth] no access_token available — run the Grok CLI login or the Setup login first')

  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: useModel,
      input: String(query),
      tools: [{ type: 'web_search' }],
    }),
    // Bearer-bearing request — refuse redirects so the OAuth token is never
    // replayed to a redirect target.
    redirect: 'error',
    signal,
  })
  if (res.status !== 200) {
    const text = await res.text()
    throw providerHttpError('grok-oauth', res.status, text)
  }
  const j = await res.json()
  const items = Array.isArray(j?.output) ? j.output : []
  // xAI Responses emits output_text either as a direct output item or nested
  // inside a message; a web_search turn typically pairs a web_search_call item
  // with a direct output_text item. Collect both shapes (and a top-level
  // output_text fallback) so a valid search answer is never dropped.
  const textBlocks = []
  for (const it of items) {
    if (it?.type === 'output_text') textBlocks.push(it)
    else if (it?.type === 'message') {
      for (const c of (it.content || [])) if (c?.type === 'output_text') textBlocks.push(c)
    }
  }
  let answer = textBlocks.map(b => b?.text || '').join('').trim()
  if (!answer && typeof j?.output_text === 'string') answer = j.output_text.trim()
  let citations = textBlocks
    .flatMap(b => b?.annotations || [])
    .filter(a => a?.url)
    .map(a => ({ title: a.title || '', url: a.url || '', snippet: '', source: 'grok-oauth' }))
  if (!citations.length && Array.isArray(j?.citations)) {
    citations = j.citations
      .map(c => (typeof c === 'string' ? { url: c } : c))
      .filter(c => c?.url)
      .map(c => ({ title: c.title || '', url: c.url, snippet: '', source: 'grok-oauth' }))
  }
  return {
    backend: 'grok-oauth',
    model: useModel,
    query,
    answer,
    citations: citations.slice(0, maxResults),
    durationMs: Date.now() - t0,
    usage: j?.usage || null,
    warnings,
  }
}
