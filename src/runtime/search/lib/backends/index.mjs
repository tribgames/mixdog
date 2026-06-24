/**
 * Search backend dispatcher.
 *
 * `web_fetch` is provider-independent: it uses local readability+puppeteer
 * extractors via src/search/lib/web-tools.mjs, not provider backends.
 * 4xx HTTP from a search backend is surfaced as an error — no silent
 * fallback.
 */
import { searchViaAnthropicOAuth } from './anthropic-oauth.mjs'
import { searchViaFirecrawl } from './firecrawl.mjs'
import { searchViaOpenAIOAuth } from './openai-oauth.mjs'
import { searchViaOpenAIApi } from './openai-api.mjs'
import { searchViaGeminiApi } from './gemini-api.mjs'
import { searchViaXAIApi } from './xai-api.mjs'
import { searchViaGrokOAuth } from './grok-oauth.mjs'
import { searchViaTavily } from './tavily.mjs'
import { searchViaExa } from './exa.mjs'
import { normalizeSearchIntent } from '../search-intent.mjs'

/**
 * Capability matrix for every supported provider.
 *
 * `siteMode` controls whether a site restriction is sent as a structured API/tool
 * parameter or appended to the query for providers that expose no structured
 * domain filter. `localeMode:none` means an explicit locale is ignored with a
 * warning rather than being rewritten into the query.
 */
export const PROVIDER_CAPS = Object.freeze({
  'anthropic-oauth': { searchTypes: ['web'],                   siteMode: 'tool',  localeMode: 'tool' },
  'openai-oauth':    { searchTypes: ['web', 'images'],         siteMode: 'tool',  localeMode: 'tool' },
  'openai-api':      { searchTypes: ['web', 'images'],         siteMode: 'tool',  localeMode: 'tool' },
  'gemini-api':      { searchTypes: ['web'],                   siteMode: 'query', localeMode: 'none' },
  'xai-api':         { searchTypes: ['web'],                   siteMode: 'query', localeMode: 'none' },
  'grok-oauth':      { searchTypes: ['web'],                   siteMode: 'query', localeMode: 'none' },
  'tavily':          { searchTypes: ['web', 'news'],           siteMode: 'api',   localeMode: 'api' },
  'firecrawl':       { searchTypes: ['web', 'news', 'images'], siteMode: 'api',   localeMode: 'api' },
  'exa':             { searchTypes: ['web', 'news'],           siteMode: 'api',   localeMode: 'api' },
})

export const SUPPORTED_PROVIDERS = Object.freeze(Object.keys(PROVIDER_CAPS))

function scopedQuery(intent, caps) {
  return caps?.siteMode === 'api' || caps?.siteMode === 'tool'
    ? intent.query
    : intent.queryWithSite
}

function withSearchTimeout(signal, timeoutMs) {
  const ms = Number(timeoutMs || 0)
  if (!Number.isFinite(ms) || ms <= 0) return { signal, cleanup: () => {} }
  const controller = new AbortController()
  let timer = null
  const abortFromParent = () => {
    try { controller.abort(signal?.reason || new Error('search aborted')) } catch {}
  }
  if (signal?.aborted) {
    abortFromParent()
  } else if (signal) {
    signal.addEventListener('abort', abortFromParent, { once: true })
  }
  timer = setTimeout(() => {
    try { controller.abort(new Error(`search timeout after ${ms}ms`)) } catch {}
  }, ms)
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', abortFromParent)
    },
  }
}

export async function dispatchSearchBackend({ provider, query, keywords, site, type, maxResults, contextSize, locale, signal, config }) {
  const caps = PROVIDER_CAPS[provider]
  if (!caps) {
    throw new Error(`[search:dispatch] unknown provider "${provider}" — supported: ${SUPPORTED_PROVIDERS.join(', ')}`)
  }
  const models = config?.models || {}
  const modelOptions = config?.modelOptions || {}
  const openaiOpts = modelOptions.openai || {}
  const intent = normalizeSearchIntent(
    { query, keywords, site, type, maxResults, contextSize, locale, defaultContextSize: openaiOpts.searchContextSize || 'low' },
    { caps, defaultMaxResults: config?.rawSearch?.maxResults || 5 },
  )
  const { signal: searchSignal, cleanup } = withSearchTimeout(signal, config?.requestTimeoutMs)
  const common = {
    query: scopedQuery(intent, caps),
    rawQuery: intent.rawQuery,
    site: intent.site,
    type: intent.type,
    requestedType: intent.requestedType,
    maxResults: intent.maxResults,
    limit: intent.maxResults,
    locale: caps.localeMode === 'none' ? null : intent.locale,
    contextSize: intent.contextSize,
    signal: searchSignal,
  }
  try {
    let result
    switch (provider) {
      case 'anthropic-oauth':
        result = await searchViaAnthropicOAuth(common)
        break
      case 'firecrawl':
        result = await searchViaFirecrawl(common)
        break
      case 'openai-oauth':
        result = await searchViaOpenAIOAuth({ ...common, model: models.openai || undefined, effort: openaiOpts.effort, fast: openaiOpts.fast === true })
        break
      case 'openai-api':
        result = await searchViaOpenAIApi({ ...common, model: models.openai || undefined, effort: openaiOpts.effort, fast: openaiOpts.fast === true })
        break
      case 'gemini-api':
        result = await searchViaGeminiApi({ ...common, model: models.gemini || undefined })
        break
      case 'xai-api':
        result = await searchViaXAIApi({ ...common, model: models.xai || undefined })
        break
      case 'grok-oauth':
        // OAuth bearer (Grok CLI login) drives the same api.x.ai Responses +
        // web_search call. Model is user-selectable from the live xAI catalog
        // (shares the 'xai' model family → models.xai); when unset the backend
        // resolves the newest chat model from the live catalog.
        result = await searchViaGrokOAuth({ ...common, model: models.xai })
        break
      case 'tavily':
        result = await searchViaTavily(common)
        break
      case 'exa':
        result = await searchViaExa(common)
        break
      default:
        throw new Error(`[search:dispatch] provider "${provider}" has no search case wired — PROVIDER_CAPS / switch are out of sync`)
    }
    return {
      ...result,
      query: result.query || intent.queryWithSite,
      rawQuery: intent.rawQuery,
      site: intent.site || undefined,
      type: intent.type,
      requestedType: intent.requestedType,
      maxResults: intent.maxResults,
      locale: caps.localeMode === 'none' ? null : intent.locale,
      warnings: [...intent.warnings, ...(result.warnings || [])],
    }
  } finally {
    cleanup()
  }
}

