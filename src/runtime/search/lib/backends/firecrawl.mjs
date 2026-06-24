/**
 * Firecrawl search backend.
 *
 * Uses search.credentials.firecrawl.apiKey (managed via the Setup UI's
 * search-keys section). Calls /v2/search and returns the raw SERP as
 * citations. No AI synthesis layer — answer is empty by design; the caller
 * (or mixdog model) is expected to consume citations directly.
 */
import { providerHttpError } from '../state.mjs'
import { getSearchApiKey } from '../../../shared/config.mjs'

const SEARCH_URL = 'https://api.firecrawl.dev/v2/search'

export async function searchViaFirecrawl({ query, limit = 5, site, type = 'web', locale, signal }) {
  const t0 = Date.now()
  const key = getSearchApiKey('firecrawl')
  if (!key) throw new Error('[search:firecrawl] no api key — register via mixdog-search setup -> search-keys')
  const source = type === 'images' ? 'images' : type === 'news' ? 'news' : 'web'
  const body = {
    query: String(query),
    limit,
    sources: [source],
    ...(site ? { includeDomains: [site] } : {}),
    ...(locale?.country ? { country: locale.country } : {}),
  }

  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })

  if (res.status !== 200) {
    const text = await res.text()
    throw providerHttpError('firecrawl', res.status, text)
  }
  const json = await res.json()
  const data = Array.isArray(json?.data?.[source])
    ? json.data[source]
    : Array.isArray(json?.data)
      ? json.data
      : []
  const citations = data.slice(0, limit).map(h => ({
    title: h.title || '',
    url: h.url || h.imageUrl || '',
    snippet: (h.description || h.markdown || h.alt || '').slice(0, 240),
    publishedDate: h.publishedDate || h.date || null,
    source: 'firecrawl',
  }))
  return {
    backend: 'firecrawl',
    query,
    answer: '',
    citations,
    durationMs: Date.now() - t0,
  }
}
