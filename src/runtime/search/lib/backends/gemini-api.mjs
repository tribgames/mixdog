/**
 * Gemini API key search backend.
 *
 * Reuses agent.providers.gemini.apiKey. Calls generateContent + google_search
 * tool. Model is config-driven.
 */
import { providerHttpError } from '../state.mjs'
import { getAgentApiKey } from '../../../shared/config.mjs'
import { GeminiProvider, ensureLatestGeminiModel } from '../../../agent/orchestrator/providers/gemini.mjs'

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

let _geminiWarmProvider = null
let _geminiWarmProviderKey = ''
function getGeminiWarmProvider(apiKey) {
  if (!_geminiWarmProvider || _geminiWarmProviderKey !== apiKey) {
    _geminiWarmProvider = new GeminiProvider({ apiKey })
    _geminiWarmProviderKey = apiKey
  }
  return _geminiWarmProvider
}

export async function searchViaGeminiApi({ query, model, maxResults = 5, warnings = [], signal }) {
  const t0 = Date.now()
  const key = getAgentApiKey('gemini')
  if (!key) throw new Error('[search:gemini-api] no api key — set GEMINI_API_KEY or the Gemini provider key in setup')
  const useModel = model || await ensureLatestGeminiModel(getGeminiWarmProvider(key))

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(useModel)}:generateContent?key=${encodeURIComponent(key)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: String(query) }] }],
      tools: [{ google_search: {} }],
    }),
    signal,
  })
  if (res.status !== 200) {
    const text = await res.text()
    throw providerHttpError('gemini-api', res.status, text)
  }
  const j = await res.json()
  const malformed = () => { throw new Error('[search:gemini-api] malformed JSON response') }
  if (!Array.isArray(j?.candidates)) malformed()
  const cand = j.candidates[0]
  if (!isRecord(cand) || !isRecord(cand.content)) malformed()
  const parts = cand.content.parts
  if (!Array.isArray(parts)) malformed()
  const text = parts.map(p => (isRecord(p) && typeof p.text === 'string' ? p.text : undefined)).filter(Boolean).join('').trim()
  if (!text) malformed()
  const groundingMetadata = cand.groundingMetadata
  const groundingChunks = groundingMetadata === undefined
    ? []
    : (isRecord(groundingMetadata) && Array.isArray(groundingMetadata.groundingChunks)
      ? groundingMetadata.groundingChunks
      : undefined)
  if (!groundingChunks) malformed()
  // Keep only well-formed web grounding chunks. Gemini may also emit non-web
  // grounding sources (e.g. retrievedContext) and occasional empty entries;
  // dropping those avoids blank citations without rejecting an otherwise valid
  // grounded response.
  const chunks = groundingChunks
    .filter(c => isRecord(c) && isRecord(c.web) && typeof c.web.uri === 'string' && c.web.uri)
    .map(c => ({
      title: typeof c.web.title === 'string' ? c.web.title : '',
      url: c.web.uri,
      snippet: '',
      source: 'gemini-api',
    }))
  return {
    backend: 'gemini-api',
    model: useModel,
    query,
    answer: text,
    citations: chunks.slice(0, maxResults),
    durationMs: Date.now() - t0,
    usage: j?.usageMetadata || null,
    warnings,
  }
}
