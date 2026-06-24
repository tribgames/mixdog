/**
 * Exa semantic search backend.
 *
 * Uses search.credentials.exa.apiKey. POST /search with type:'auto' so Exa
 * picks keyword vs neural mode. /contents endpoint integrates fetch-step.
 */
import { providerHttpError } from '../state.mjs'
import { getSearchApiKey } from '../../../shared/config.mjs'

const URL = 'https://api.exa.ai/search'

export async function searchViaExa({ query, limit = 5, site, type = 'web', locale, signal }) {
  const t0 = Date.now()
  const key = getSearchApiKey('exa')
  if (!key) throw new Error('[search:exa] no api key - register via mixdog-search setup -> search-keys')
  const body = {
    query: String(query),
    numResults: limit,
    type: 'auto',
    ...(site ? { includeDomains: [site] } : {}),
    ...(locale?.country ? { userLocation: locale.country } : {}),
    ...(type === 'news' ? { category: 'news' } : {}),
  }

  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (res.status !== 200) {
    const text = await res.text()
    throw providerHttpError('exa', res.status, text)
  }
  const j = await res.json()
  const citations = (j?.results || []).slice(0, limit).map(h => ({
    title: h.title || '',
    url: h.url || '',
    snippet: (h.text || h.snippet || '').slice(0, 240),
    publishedDate: h.publishedDate || h.published_date || null,
    source: 'exa',
  }))
  return {
    backend: 'exa',
    query,
    answer: '',
    citations,
    durationMs: Date.now() - t0,
  }
}
