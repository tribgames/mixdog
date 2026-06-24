/**
 * Tavily search backend.
 *
 * Uses search.credentials.tavily.apiKey. POST /search with include_answer:true
 * for built-in AI synthesis. RAG-specialized index.
 */
import { providerHttpError } from '../state.mjs'
import { getSearchApiKey } from '../../../shared/config.mjs'
import { tavilyCountryName } from '../search-intent.mjs'

const URL = 'https://api.tavily.com/search'

export async function searchViaTavily({ query, limit = 5, site, type = 'web', locale, signal }) {
  const t0 = Date.now()
  const key = getSearchApiKey('tavily')
  if (!key) throw new Error('[search:tavily] no api key — register via mixdog-search setup -> search-keys')
  const topic = type === 'news' ? 'news' : 'general'
  const body = {
    api_key: key,
    query: String(query),
    topic,
    search_depth: 'basic',
    max_results: limit,
    include_answer: true,
    include_raw_content: false,
    ...(site ? { include_domains: [site] } : {}),
  }
  if (topic === 'general' && locale?.country) body.country = tavilyCountryName(locale.country)

  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (res.status !== 200) {
    const text = await res.text()
    throw providerHttpError('tavily', res.status, text)
  }
  const j = await res.json()
  const citations = (j?.results || []).slice(0, limit).map(h => ({
    title: h.title || '',
    url: h.url || '',
    snippet: (h.content || '').slice(0, 240),
    publishedDate: h.published_date || null,
    source: 'tavily',
  }))
  return {
    backend: 'tavily',
    query,
    answer: (j?.answer || '').trim(),
    citations,
    durationMs: Date.now() - t0,
  }
}
