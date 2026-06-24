/**
 * OpenAI API key search backend.
 *
 * Reuses agent.providers.openai.apiKey. Calls Responses API + web_search
 * server tool. Model is config-driven.
 */
import { providerHttpError } from '../state.mjs'
import { getAgentApiKey } from '../../../shared/config.mjs'
import {
  OPENAI_SEARCH_SYSTEM_INSTRUCTIONS,
  buildOpenAISearchPrompt,
  buildOpenAIWebSearchTool,
  citationsFromText,
} from './openai-web-search.mjs'

const URL = 'https://api.openai.com/v1/responses'
const MODELS_URL = 'https://api.openai.com/v1/models'

function _codexFamily(id) {
  const s = String(id || '').toLowerCase()
  if (s.includes('nano')) return 'gpt-nano'
  if (s.includes('mini')) return 'gpt-mini'
  if (s.includes('codex')) return 'gpt-codex'
  if (s.startsWith('gpt-5.5')) return 'gpt-5.5'
  if (s.startsWith('gpt-5.4')) return 'gpt-5.4'
  if (s.startsWith('gpt-5.2')) return 'gpt-5.2'
  if (s.startsWith('gpt-5')) return 'gpt-5'
  return 'gpt'
}

function _compareVersion(a, b) {
  const na = (String(a).match(/gpt-(\d+)\.(\d+)/) || []).slice(1).map(Number)
  const nb = (String(b).match(/gpt-(\d+)\.(\d+)/) || []).slice(1).map(Number)
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    if ((na[i] || 0) !== (nb[i] || 0)) return (na[i] || 0) - (nb[i] || 0)
  }
  return String(a).localeCompare(String(b))
}

function _isMainCodexFamily(family) {
  return typeof family === 'string' && family.startsWith('gpt-5')
}

function _pickLatestMainGpt5Model(ids) {
  let best = null
  for (const id of ids) {
    if (!id || typeof id !== 'string') continue
    const family = _codexFamily(id)
    if (!_isMainCodexFamily(family)) continue
    if (!best || _compareVersion(id, best) > 0) best = id
  }
  return best
}

async function ensureLatestOpenAIApiModel(apiKey, signal) {
  const res = await fetch(MODELS_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    redirect: 'error',
    signal: signal ?? AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(
      `[search:openai-api] model catalog unavailable (${res.status}${text ? `: ${text.slice(0, 200)}` : ''}) — set search.models.openai to an explicit model id`,
    )
  }
  const data = await res.json()
  const ids = (Array.isArray(data?.data) ? data.data : [])
    .map(m => m?.id)
    .filter(Boolean)
  const m = _pickLatestMainGpt5Model(ids)
  if (m) return m
  throw new Error(
    '[search:openai-api] no default gpt-5 model in API catalog — set search.models.openai to an explicit model id',
  )
}

export async function searchViaOpenAIApi({
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
  const key = getAgentApiKey('openai')
  if (!key) throw new Error('[search:openai-api] no api key — set OPENAI_API_KEY or the OpenAI provider key in setup')
  const useModel = model || await ensureLatestOpenAIApiModel(key, signal)

  const payload = {
    model: useModel,
    instructions: OPENAI_SEARCH_SYSTEM_INSTRUCTIONS,
    input: buildOpenAISearchPrompt(query, maxResults),
    tools: [buildOpenAIWebSearchTool({ site, type, locale, contextSize })],
    prompt_cache_key: `mixdog-search-openai-api-${useModel}`,
    text: { verbosity: 'low' },
  }
  if (effort || /^gpt-5/i.test(String(useModel))) payload.reasoning = { effort: effort || 'low' }
  if (fast === true) payload.service_tier = 'priority'
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  if (res.status !== 200) {
    const text = await res.text()
    throw providerHttpError('openai-api', res.status, text)
  }
  const j = await res.json()
  const items = j?.output || []
  // Collect every output_text part across all message items — the model can
  // split its answer (and citations) across multiple content parts and/or
  // multiple messages. Reading only the first part drops the rest.
  const textParts = items
    .filter(it => it.type === 'message')
    .flatMap(it => Array.isArray(it.content) ? it.content : [])
    .filter(c => c.type === 'output_text')
  const answer = (textParts.map(c => c?.text || '').join('').trim() || j?.output_text || '').trim()
  const annotations = textParts
    .flatMap(c => Array.isArray(c?.annotations) ? c.annotations : [])
    .filter(a => a?.url)
    .map(a => ({ title: a.title || '', url: a.url || '', snippet: '', source: 'openai-api' }))
  const citations = annotations.length
    ? annotations.slice(0, maxResults)
    : citationsFromText(answer, maxResults, 'openai-api')
  return {
    backend: 'openai-api',
    model: useModel,
    query,
    answer,
    citations,
    durationMs: Date.now() - t0,
    usage: j?.usage || null,
    warnings,
  }
}