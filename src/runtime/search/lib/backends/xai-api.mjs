/**
 * xAI API key search backend.
 *
 * API key via getAgentApiKey('xai') (env/keychain/setup). Calls Responses API + web_search
 * (Agent Tools API) — Live Search (Chat Completions) is deprecated.
 */
import { providerHttpError } from '../state.mjs'
import { getAgentApiKey } from '../../../shared/config.mjs'
import { resolveLatestGrokModel } from '../../../agent/orchestrator/providers/grok-oauth.mjs'

const URL = 'https://api.x.ai/v1/responses'
const MODELS_URL = 'https://api.x.ai/v1/models'

// Match resolveLatestGrokModel() in grok-oauth.mjs (do not write OAuth shared cache).
const NON_CHAT_MODEL_RE = /imagine|image|video/i
const PROXY_EXACT_MODELS = new Set(['grok-build'])
function _isProxyOnlyModel(model) {
  const m = String(model || '')
  return /^grok-composer/i.test(m) || PROXY_EXACT_MODELS.has(m)
}

function _normalizeGrokApiModel(m) {
  const id = m?.id
  if (!id) return null
  return {
    id,
    name: id,
    display: id,
    provider: 'grok-oauth',
    family: 'grok',
    tier: 'version',
    latest: false,
    contextWindow: m?.context_window || 0,
    created: typeof m?.created === 'number' ? m.created : null,
  }
}

function _pickLatestChatModelId(models) {
  let best = null
  for (const m of models) {
    if (!m?.id || NON_CHAT_MODEL_RE.test(m.id) || _isProxyOnlyModel(m.id) || !(Number(m.created) > 0)) continue
    if (!best || Number(m.created) > Number(best.created)) best = m
  }
  return best?.id || null
}

async function _fetchGrokCatalogModels(apiKey, signal) {
  const res = await fetch(MODELS_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    redirect: 'error',
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`[search:xai-api] model catalog fetch failed (${res.status}${text ? `: ${text.slice(0, 200)}` : ''})`)
  }
  const data = await res.json()
  if (!Array.isArray(data?.data)) {
    throw new Error('[search:xai-api] unexpected /models response shape (no data[])')
  }
  return data.data.map(_normalizeGrokApiModel).filter(Boolean)
}

async function ensureLatestGrokModelForApiKey(apiKey, signal) {
  let m = resolveLatestGrokModel()
  if (m) return m
  const models = await _fetchGrokCatalogModels(apiKey, signal)
  m = _pickLatestChatModelId(models)
  if (m) return m
  throw new Error(
    '[search:xai-api] model catalog unavailable after warmup — set search.models.xai to an explicit model id',
  )
}

export async function searchViaXAIApi({ query, model, maxResults = 5, warnings = [], signal }) {
  const t0 = Date.now()
  const key = getAgentApiKey('xai')
  if (!key) throw new Error('[search:xai-api] no api key — set XAI_API_KEY or the xAI provider key in setup')
  const useModel = model || await ensureLatestGrokModelForApiKey(key, signal)

  const res = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: useModel,
      input: String(query),
      tools: [{ type: 'web_search' }],
    }),
    signal,
  })
  if (res.status !== 200) {
    const text = await res.text()
    throw providerHttpError('xai-api', res.status, text)
  }
  const j = await res.json()
  const items = j?.output || []
  const msg = items.find(it => it.type === 'message')?.content || []
  const tb = msg.find(c => c.type === 'output_text')
  const annotations = (tb?.annotations || [])
    .filter(a => a?.url)
    .map(a => ({ title: a.title || '', url: a.url || '', snippet: '', source: 'xai-api' }))
  return {
    backend: 'xai-api',
    model: useModel,
    query,
    answer: (tb?.text || '').trim(),
    citations: annotations.slice(0, maxResults),
    durationMs: Date.now() - t0,
    usage: j?.usage || null,
    warnings,
  }
}