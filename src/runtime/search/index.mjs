#!/usr/bin/env bun

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import {
  ensureDataDir,
  getFirecrawlApiKey,
  getRequestTimeoutMs,
  getRawSearchMaxResults,
  getRawProviderCredentialSource,
  getRawProviderApiKey,
  loadConfig,
  PLUGIN_ROOT,
} from './lib/config.mjs'
import { normalizeErrorMessage } from '../agent/orchestrator/tools/builtin/path-diagnostics.mjs'
import { getAgentApiKey } from '../shared/config.mjs'

function readPluginVersion() {
  try {
    const manifestPath = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version || '0.0.1'
  } catch { return '0.0.1' }
}
const PLUGIN_VERSION = readPluginVersion()
import {
  buildCacheKey,
  buildCacheMeta,
  flushCacheState,
  getCachedEntry,
  loadCacheState,
  setCachedEntry,
} from './lib/cache.mjs'
import { fetchProviderUsageSnapshot } from './lib/provider-usage.mjs'
import {
  flushUsageState,
  loadUsageState,
  noteProviderFailure,
  classifyProviderError,
  noteProviderSuccess,
  saveUsageState,
  updateProviderState,
} from './lib/state.mjs'
import {
  getProvidersWithApiKeys,
  RAW_PROVIDER_CAPABILITIES,
} from './lib/providers.mjs'
import { dispatchSearchBackend, PROVIDER_CAPS } from './lib/backends/index.mjs'
import { normalizeSearchIntent } from './lib/search-intent.mjs'
import { assertPublicUrl, crawlSite, getScrapeCapabilities, pinnedFetch, scrapeUrls } from './lib/web-tools.mjs'
import { formatResponse } from './lib/formatter.mjs'
import { handleSetup } from './lib/setup-handler.mjs'


ensureDataDir()

const searchArgsSchema = z.object({
  keywords: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).describe('Search query string or array of queries.'),
  site: z.string().optional().describe('Restrict results to a specific domain.'),
  type: z.enum(['web', 'news', 'images']).optional().describe('Search type. Default: web.'),
  maxResults: z.number().int().min(1).max(20).optional().describe('Maximum number of results to return (1-20).'),
  locale: z.union([
    z.string(),
    z.object({
      country: z.string().optional(),
      language: z.string().optional(),
      region: z.string().optional(),
      city: z.string().optional(),
      timezone: z.string().optional(),
    }),
  ]).optional().describe('Explicit search locale. String such as "ko-KR" or object with country/language/city/region/timezone.'),
  contextSize: z.enum(['low', 'medium', 'high']).optional().describe('Search context size for providers that support it. Default: low.'),
})

const searchUrlArgsSchema = z.object({
  url: z.union([z.string().url(), z.array(z.string().url()).min(1)]).describe('Single URL or array of URLs to fetch.'),
  startIndex: z.number().int().min(0).optional().describe('Character offset to start the slice from (default 0). For chunked reading of large pages, pass the previous response\'s nextStartIndex.'),
  maxLength: z.number().int().min(0).optional().describe('Max characters to return per call (default 50000). Pass 0 for unlimited.'),
  cwd: z.string().optional(),
})

const SEARCH_EMPTY_STRING_FIELDS = ['keywords', 'site', 'type', 'locale', 'contextSize']

function normalizeSearchArgs(rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return rawArgs
  const args = { ...rawArgs }
  for (const key of SEARCH_EMPTY_STRING_FIELDS) {
    const value = args[key]
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (!trimmed) delete args[key]
      else args[key] = trimmed
    }
  }
  if (Array.isArray(args.keywords)) {
    const keywords = args.keywords
      .map(value => typeof value === 'string' ? value.trim() : value)
      .filter(value => typeof value === 'string' ? value.length > 0 : Boolean(value))
    if (keywords.length > 0) args.keywords = keywords
    else delete args.keywords
  }
  return args
}

function normalizeSearchUrlArgs(rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return rawArgs
  const args = { ...rawArgs }
  if (typeof args.url === 'string') args.url = args.url.trim()
  if (Array.isArray(args.url)) {
    const urls = args.url
      .map(value => typeof value === 'string' ? value.trim() : value)
      .filter(value => typeof value === 'string' ? value.length > 0 : Boolean(value))
    if (urls.length > 0) args.url = urls
    else delete args.url
  }
  return args
}

const crawlArgsSchema = z.object({
  url: z.string().url().describe('Starting URL to begin crawling from.'),
  maxPages: z.number().int().min(1).max(200).optional().describe('Maximum number of pages to visit (1-200).'),
  maxDepth: z.number().int().min(0).max(5).optional().describe('Maximum link depth to follow (0-5).'),
  sameDomainOnly: z.boolean().optional().describe('If true, only follow links on the same domain.'),
})

function jsonText(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  }
}

function formattedText(tool, payload) {
  const text = formatResponse(tool, tool === 'search' ? dropInvalidSearchResults(payload) : payload)
  return {
    content: [{ type: 'text', text }],
  }
}

function isInvalidSearchResult(result) {
  const title = String(result?.title || '').trim()
  return /\bpage not found\b|\b404\b.*\bnot found\b/i.test(title)
}

function dropInvalidSearchResults(payload) {
  if (!payload || typeof payload !== 'object') return payload
  const response = payload.response
  if (!response || typeof response !== 'object' || !Array.isArray(response.results)) return payload
  const results = response.results.filter(result => !isInvalidSearchResult(result))
  if (results.length === response.results.length) return payload
  return {
    ...payload,
    response: {
      ...response,
      results,
      droppedInvalidResults: (response.droppedInvalidResults || 0) + (response.results.length - results.length),
    },
  }
}

function getSearchCacheTtlMs(type = 'web') {
  switch (type) {
    case 'news':
      return 20 * 60 * 1000
    case 'images':
      return 60 * 60 * 1000
    case 'web':
    default:
      return 30 * 60 * 1000
  }
}

function getScrapeCacheTtlMs(isXRoute = false) {
  return isXRoute ? 10 * 60 * 1000 : 60 * 60 * 1000
}

function buildRuntimeEnv(config) {
  return {
    ...process.env,
    ...(getFirecrawlApiKey(config)
      ? { FIRECRAWL_API_KEY: getFirecrawlApiKey(config) }
      : {}),
    ...(getRawProviderApiKey(config, 'tavily')
      ? { TAVILY_API_KEY: getRawProviderApiKey(config, 'tavily') }
      : {}),
    ...(getRawProviderApiKey(config, 'exa')
      ? { EXA_API_KEY: getRawProviderApiKey(config, 'exa') }
      : {}),
    // xAI search runs through the xai-api backend, which reads the Agent xAI
    // credential (getAgentApiKey('xai')) — not a separate raw search key. Mirror
    // that source here so the startup snapshot discovers 'xai-api' iff the agent
    // key is present.
    ...(getAgentApiKey('xai')
      ? { XAI_API_KEY: process.env.XAI_API_KEY || getAgentApiKey('xai') }
      : {}),
  }
}

function normalizeCacheUrl(url) {
  try {
    return new URL(url).toString()
  } catch {
    return String(url)
  }
}

const DOC_INDEX_MAX_BYTES = 2 * 1024 * 1024
const DOC_INDEX_MAX_FETCHES = 8
const DOC_INDEX_COMMON_PATHS = ['docs', 'api', 'reference', 'api/reference']
const DOC_INDEX_STOPWORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'can', 'com', 'doc', 'docs',
  'documentation', 'for', 'from', 'how', 'http', 'https', 'into', 'official',
  'page', 'pages', 'site', 'the', 'this', 'title', 'url', 'use', 'using', 'what',
  'when', 'where', 'which', 'with', 'www',
])

function keywordsText(keywords) {
  return Array.isArray(keywords) ? keywords.join(' ') : String(keywords || '')
}

function queryTokens(keywords) {
  const tokens = keywordsText(keywords)
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}._-]{1,}/gu) || []
  return [...new Set(tokens
    .filter(token => token.length >= 3 && !DOC_INDEX_STOPWORDS.has(token)))]
}

// Weighted scoring across title/path/url/snippet. Title hit is the strongest
// signal (8) because llms.txt entries are hand-curated; path-segment hits
// (5) and last-segment hits (3..10) catch /api/foo over /blog/foo. Url and
// snippet (2 / 1) act as tiebreakers when title misses. .md penalty -2 so
// raw markdown sources lose to rendered docs when both are listed.
function docLinkScore(link, tokens) {
  if (!tokens.length) return 0
  const title = String(link.title || '').toLowerCase()
  const url = String(link.url || '').toLowerCase()
  const snippet = String(link.snippet || '').toLowerCase()
  let pathname = ''
  try {
    pathname = new URL(link.url).pathname.toLowerCase()
  } catch {}
  const segments = pathname.split('/').filter(Boolean)
  let score = 0
  for (const token of tokens) {
    if (title.includes(token)) score += 8
    if (segments.includes(token)) score += 5
    if (segments.at(-1) === token) score += 3 + Math.max(0, 7 - segments.length)
    if (url.includes(token)) score += 2
    if (snippet.includes(token)) score += 1
  }
  if (/\.md$/i.test(pathname)) score -= 2
  return score
}

function docIndexUrlCandidates(site, keywords) {
  if (!site) return []
  let parsed
  try {
    parsed = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`)
  } catch {
    return []
  }
  const candidates = []
  const add = (url) => {
    try {
      const normalized = new URL(url).toString()
      if (!candidates.includes(normalized)) candidates.push(normalized)
    } catch {}
  }
  const pathParts = parsed.pathname.split('/').filter(Boolean)
  for (let i = pathParts.length; i >= 0; i -= 1) {
    const prefix = pathParts.slice(0, i).join('/')
    add(`${parsed.origin}${prefix ? `/${prefix}` : ''}/llms.txt`)
  }
  // When the user asks an api/docs question on a bare-host site, also probe
  // the common doc-prefix llms.txt locations the host might publish under.
  const docsIntent = /\b(?:api|docs?|documentation|reference)\b/i.test(keywordsText(keywords))
  if (docsIntent && pathParts.length === 0) {
    for (const prefix of DOC_INDEX_COMMON_PATHS) {
      add(`${parsed.origin}/${prefix}/llms.txt`)
    }
  }
  return candidates
}


function docIndexAbortSignal(timeoutMs, parentSignal) {
  const ms = Math.min(Math.max(Number(timeoutMs) || 10_000, 1000), 10_000)
  if (typeof AbortSignal.any === 'function') {
    const parts = [AbortSignal.timeout(ms)]
    if (parentSignal) parts.push(parentSignal)
    return AbortSignal.any(parts)
  }
  const controller = new AbortController()
  let timer
  let onParentAbort
  const abortWith = reason => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (parentSignal && onParentAbort) {
      parentSignal.removeEventListener('abort', onParentAbort)
      onParentAbort = undefined
    }
    if (!controller.signal.aborted) controller.abort(reason)
  }
  timer = setTimeout(
    () => abortWith(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    ms,
  )
  if (parentSignal) {
    if (parentSignal.aborted) {
      abortWith(parentSignal.reason)
      return controller.signal
    }
    onParentAbort = () => abortWith(parentSignal.reason)
    parentSignal.addEventListener('abort', onParentAbort, { once: true })
  }
  return controller.signal
}

function searchArgsForCacheKey(args, config) {
  const caps = PROVIDER_CAPS[config.provider] || { searchTypes: ['web'], localeMode: 'tool' }
  let keywords = args.keywords
  if (Array.isArray(keywords)) {
    const items = keywords.map(k => String(k || '').trim()).filter(Boolean)
    keywords = items.length === 1 ? items[0] : items
  }
  const intent = normalizeSearchIntent(
    {
      keywords,
      site: args.site,
      type: args.type,
      maxResults: args.maxResults,
      locale: args.locale,
      contextSize: args.contextSize,
    },
    { caps, defaultMaxResults: getRawSearchMaxResults(config) },
  )
  return {
    keywords: intent.rawQuery,
    site: intent.site || null,
    type: intent.type,
    locale: intent.locale,
    contextSize: intent.contextSize,
    maxResults: intent.maxResults,
  }
}

async function fetchDocIndex(url, timeoutMs, parentSignal) {
  // SSRF: reuse the guarded web_fetch path's public-URL/private-IP check so
  // docs-index discovery cannot be steered into localhost / link-local /
  // cloud-metadata addresses by a hostile site override. Follow redirects
  // manually and re-validate each hop so a 30x Location can't steer us to
  // a private/loopback address after the initial check.
  const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
  const MAX_REDIRECTS = 5
  const signal = docIndexAbortSignal(timeoutMs, parentSignal)
  let currentUrl = url
  let response
  for (let hops = 0; ; hops++) {
    assertPublicUrl(currentUrl)
    // pinnedFetch resolves+validates the host once and pins the connection
    // to the validated IP, closing the validate-then-fetch DNS-rebinding /
    // TOCTOU window that bare `fetch` left open.
    response = await pinnedFetch(currentUrl, {
      headers: { Accept: 'text/markdown,text/plain,text/*,*/*' },
      signal,
      redirect: 'manual',
    })
    if (!REDIRECT_STATUSES.has(response.status)) break
    try { await response.body?.cancel() } catch {}
    if (hops >= MAX_REDIRECTS) {
      throw new Error(`docs index too many redirects (max ${MAX_REDIRECTS})`)
    }
    const location = response.headers.get('location')
    if (!location) {
      throw new Error(`docs index redirect ${response.status} without Location header`)
    }
    currentUrl = new URL(location, currentUrl).toString()
  }
  if (!response.ok) {
    try { await response.body?.cancel() } catch {}
    throw new Error(`docs index fetch failed: ${response.status}`)
  }
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > DOC_INDEX_MAX_BYTES) {
    try { await response.body?.cancel() } catch {}
    throw new Error(`docs index too large: ${contentLength}`)
  }
  // Enforce DOC_INDEX_MAX_BYTES while streaming so chunked / missing-length
  // responses can't blow past the 2MB cap by deferring the check until after
  // the whole body is buffered.
  const reader = response.body?.getReader?.()
  let text
  if (!reader) {
    // Buffer as bytes and cap by byte length — string.length counts UTF-16
    // code units, which under-counts multi-byte characters and lets the
    // body blow past DOC_INDEX_MAX_BYTES.
    const buf = new Uint8Array(await response.arrayBuffer())
    const capped = buf.byteLength > DOC_INDEX_MAX_BYTES ? buf.subarray(0, DOC_INDEX_MAX_BYTES) : buf
    text = new TextDecoder('utf-8', { fatal: false }).decode(capped)
  } else {
    const chunks = []
    let total = 0
    let capped = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        chunks.push(value)
        if (total >= DOC_INDEX_MAX_BYTES) {
          capped = true
          try { await reader.cancel() } catch {}
          break
        }
      }
    } finally {
      try { reader.releaseLock() } catch {}
    }
    const decoder = new TextDecoder('utf-8', { fatal: false })
    let buf = ''
    for (const chunk of chunks) buf += decoder.decode(chunk, { stream: true })
    buf += decoder.decode()
    text = capped || buf.length > DOC_INDEX_MAX_BYTES ? buf.slice(0, DOC_INDEX_MAX_BYTES) : buf
  }
  return {
    text,
    url: response.url || url,
  }
}

function parseDocIndexLinks(text, sourceUrl) {
  const links = []
  const seen = new Set()
  const add = (title, rawUrl, snippet = '') => {
    if (!title || !rawUrl) return
    let url
    try {
      url = new URL(rawUrl, sourceUrl).toString()
    } catch {
      return
    }
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return
    seen.add(url)
    links.push({
      title: String(title).trim(),
      url,
      snippet: String(snippet || '').trim(),
      sourceUrl,
    })
  }

  for (const line of String(text || '').split(/\r?\n/)) {
    const item = line.match(/^\s*[-*]\s+\[([^\]]{1,180})\]\(([^)\s]+)\)\s*:?\s*(.*)$/)
    if (item) add(item[1], item[2], item[3])
  }
  const inlineRe = /\[([^\]]{1,180})\]\((https?:\/\/[^)\s]+)\)/g
  let match
  while ((match = inlineRe.exec(String(text || '')))) {
    add(match[1], match[2])
  }
  return links
}


function isDocIndexLink(url) {
  try {
    return /\/llms(?:-full)?\.txt$/i.test(new URL(url).pathname)
  } catch {
    return false
  }
}

function hostFromUrl(url) {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function isBaseHost(host) {
  return host.split('.').filter(Boolean).length <= 2
}

function hostMatchesScope(host, scopedHost) {
  if (!host || !scopedHost) return false
  if (host === scopedHost) return true
  return isBaseHost(scopedHost) && host.endsWith(`.${scopedHost}`)
}

function sameDocIndexScope(url, site, requestedIndexUrl) {
  const linkHost = hostFromUrl(url)
  if (!linkHost) return false
  // Always require the link to match the original requested site host.
  const siteHost = hostFromUrl(site)
  if (siteHost && !hostMatchesScope(linkHost, siteHost)) return false
  const scopes = [
    siteHost,
    hostFromUrl(requestedIndexUrl),
  ].filter(Boolean)
  return scopes.some(scope => hostMatchesScope(linkHost, scope))
}

async function discoverDocsIndexResults(args, timeoutMs, parentSignal) {
  if (!args?.site || (args.type && args.type !== 'web')) return []
  const tokens = queryTokens(args.keywords)
  if (!tokens.length) return []

  const queue = docIndexUrlCandidates(args.site, args.keywords)
  const seenIndexes = new Set()
  const candidates = []

  while (queue.length > 0 && seenIndexes.size < DOC_INDEX_MAX_FETCHES) {
    if (parentSignal?.aborted) return []
    const indexUrl = queue.shift()
    if (!indexUrl || seenIndexes.has(indexUrl)) continue
    seenIndexes.add(indexUrl)
    let index = null
    try {
      index = await fetchDocIndex(indexUrl, timeoutMs, parentSignal)
    } catch {
      continue
    }
    const sourceUrl = index.url || indexUrl
    const links = parseDocIndexLinks(index.text, sourceUrl)
    for (const link of links) {
      if (isDocIndexLink(link.url)) {
        if (!seenIndexes.has(link.url) && queue.length + seenIndexes.size < DOC_INDEX_MAX_FETCHES) queue.push(link.url)
        continue
      }
      if (!sameDocIndexScope(link.url, args.site, indexUrl)) continue
      const score = docLinkScore(link, tokens)
      if (score <= 0) continue
      candidates.push({
        ...link,
        score,
      })
    }
  }

  const seenUrls = new Set()
  return candidates
    .sort((a, b) => b.score - a.score)
    .filter((item) => {
      if (seenUrls.has(item.url)) return false
      seenUrls.add(item.url)
      return true
    })
    .slice(0, Math.min(Number(args.maxResults) || 5, 5))
    .map(item => ({
      title: item.title,
      url: item.url,
      snippet: item.snippet || `Matched docs index: ${item.sourceUrl}`,
      source: 'docs-index',
      provider: 'docs-index',
      publishedDate: null,
      meta: { score: item.score, sourceUrl: item.sourceUrl },
    }))
}

async function augmentSearchPayloadWithDocsIndex(payload, args, timeoutMs, parentSignal) {
  if (!payload || typeof payload !== 'object') return payload
  const response = payload.response
  if (!response || typeof response !== 'object' || !Array.isArray(response.results)) return payload
  const indexResults = await discoverDocsIndexResults(args, timeoutMs, parentSignal)
  if (!indexResults.length) return payload
  const seen = new Set()
  const results = []
  for (const result of [...indexResults, ...response.results]) {
    const url = String(result?.url || '')
    const key = url || `${result?.title || ''}\n${result?.snippet || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    results.push(result)
  }
  return {
    ...payload,
    response: {
      ...response,
      results: results.slice(0, Math.max(Number(args.maxResults) || results.length, indexResults.length)),
      docsIndexAugmented: {
        added: indexResults.length,
        sources: [...new Set(indexResults.map(item => item.meta?.sourceUrl).filter(Boolean))],
      },
    },
  }
}

async function writeStartupSnapshot() {
  const config = loadConfig()
  const usageState = loadUsageState()
  const runtimeEnv = buildRuntimeEnv(config)
  const rawProviders = getProvidersWithApiKeys(runtimeEnv)
  const scrapeCapabilities = getScrapeCapabilities()

  for (const provider of rawProviders) {
    let usagePatch = null
    try {
      usagePatch = await fetchProviderUsageSnapshot(provider, runtimeEnv)
    } catch {
      usagePatch = null
    }

    updateProviderState(usageState, provider, {
      available: true,
      connection: 'api',
      source: getRawProviderCredentialSource(config, provider, process.env) || 'env',
      usageSupport: RAW_PROVIDER_CAPABILITIES[provider]?.usageSupport || null,
      ...(usagePatch || {}),
    })
  }

  updateProviderState(usageState, 'readability', {
    available: scrapeCapabilities.readability,
    connection: 'builtin',
    source: 'local',
  })

  updateProviderState(usageState, 'puppeteer', {
    available: scrapeCapabilities.puppeteer,
    connection: 'local-browser',
    source: 'local',
  })

  updateProviderState(usageState, 'firecrawl', {
    readability: scrapeCapabilities.readability,
    puppeteer: scrapeCapabilities.puppeteer,
    connection: 'api',
    source: getRawProviderCredentialSource(config, 'firecrawl', process.env) || 'env',
  })
}

// ── Core action implementations (shared by individual and batch handlers) ──

const _searchInFlight = new Map()

function backendResultToSearchResponse(result) {
  const maxResults = Math.max(1, Math.min(20, Number(result?.maxResults) || 10))
  const citations = Array.isArray(result?.citations) ? result.citations : []
  const results = citations.slice(0, maxResults).map((item) => ({
    title: item?.title || '',
    url: item?.url || '',
    snippet: item?.snippet || '',
    source: item?.source || result?.backend || '',
    provider: result?.backend || '',
    publishedDate: item?.publishedDate || item?.published_date || null,
  }))
  return {
    usedProvider: result?.backend || '',
    query: result?.rawQuery || result?.query || '',
    rawQuery: result?.rawQuery || result?.query || '',
    answer: result?.answer || '',
    model: result?.model || null,
    durationMs: result?.durationMs || 0,
    usage: result?.usage || null,
    results,
    warnings: Array.isArray(result?.warnings) ? result.warnings : [],
    type: result?.type || 'web',
    site: result?.site || null,
    locale: result?.locale || null,
    webSearchCalls: result?.webSearchCalls || [],
  }
}

async function _searchCore(args, { config, usageState, cacheState, timeoutMs, signal }) {
  // Hoisted so the outer finally can reference it even on early throw.
  let searchCacheKey
  // Only the owner of the in-flight entry may delete it in the outer finally.
  // Coalesced callers that early-return `existing` must leave the entry intact
  // so a third identical caller still hits coalescing.
  let ownsInFlight = false
  try {
  const provider = config.provider
  if (!provider) {
    throw new Error('No search provider configured. Set search.provider in mixdog-config.json.')
  }

  const cacheArgs = searchArgsForCacheKey(args, config)
  searchCacheKey = buildCacheKey('search', {
    keywords: cacheArgs.keywords,
    provider,
    site: cacheArgs.site,
    type: cacheArgs.type,
    locale: cacheArgs.locale,
    contextSize: cacheArgs.contextSize,
    docs_index: cacheArgs.site && cacheArgs.type === 'web' ? 4 : null,
    maxResults: cacheArgs.maxResults,
  })
  const cachedSearch = getCachedEntry(cacheState, searchCacheKey)
  if (cachedSearch) {
    // Cache hit: skip docs-index network discovery. The cached payload
    // already includes any docs-index augmentation captured at insert
    // time, so re-running the network probe here would burn external I/O
    // on every cached search.
    return { ...cachedSearch.payload, cache: buildCacheMeta(cachedSearch, true) }
  }

  // Coalesce identical concurrent requests to the same cache key
  const existing = _searchInFlight.get(searchCacheKey)
  if (existing) return existing
  let resolveCoalesce, rejectCoalesce
  const coalescePromise = new Promise((res, rej) => { resolveCoalesce = res; rejectCoalesce = rej })
  // The first caller owns the real await path; duplicate callers may await this.
  // Mark it handled so a first-call failure does not leak as unhandledRejection.
  coalescePromise.catch(() => {})
  _searchInFlight.set(searchCacheKey, coalescePromise)
  // Only the owner of the in-flight entry may delete it. Coalesced callers
  // return `existing` above, but `return` still runs the outer finally; without
  // this flag a coalesced caller would delete the owner's in-flight entry mid-
  // flight and a third identical caller would miss coalescing.
  ownsInFlight = true

  try {
    const backendResult = await dispatchSearchBackend({
      provider,
      query: args.keywords,
      site: args.site,
      type: args.type,
      locale: args.locale,
      contextSize: args.contextSize,
      maxResults: args.maxResults || getRawSearchMaxResults(config),
      config,
      signal,
    })
    const response = backendResultToSearchResponse(backendResult)

    noteProviderSuccess(usageState, response.usedProvider, {
      lastCostUsdTicks: response.usage?.cost_in_usd_ticks || null,
    })

    const payload = await augmentSearchPayloadWithDocsIndex(
      { tool: 'search', provider, response },
      { ...args, ...cacheArgs, keywords: cacheArgs.keywords },
      timeoutMs,
      signal,
    )
    const cachedEntry = setCachedEntry(
      cacheState,
      searchCacheKey,
      payload,
      getSearchCacheTtlMs(args.type || 'web'),
    )
    flushCacheState()
    flushUsageState()
    const result = { ...payload, cache: buildCacheMeta(cachedEntry, false) }
    if (ownsInFlight) _searchInFlight.delete(searchCacheKey)
    resolveCoalesce(result)
    return result
  } catch (error) {
    if (ownsInFlight) _searchInFlight.delete(searchCacheKey)
    rejectCoalesce(error)
    noteProviderFailure(
      usageState,
      provider,
      error instanceof Error ? error.message : String(error),
      classifyProviderError(error),
    )

    const err = error instanceof Error ? error : new Error(String(error))
    err.details = { tool: 'search', provider }
    throw err
  }
  } finally {
    // Resolve coalesce waiters if not already rejected. Only the owner may
    // delete the in-flight entry — a coalesced caller that returned `existing`
    // earlier must not evict the still-running owner's coalesce target.
    if (ownsInFlight && _searchInFlight.has(searchCacheKey)) {
      _searchInFlight.delete(searchCacheKey)
    }
  }
}

const DEFAULT_FETCH_MAX_LENGTH = 50000

// Apply character-level pagination to a cached or fresh fetch payload. Mirrors
// the mcp-server-fetch reference: caller passes startIndex/maxLength and
// receives a slice plus pointers (nextStartIndex, hasMore) for the next chunk.
// totalLength is preserved so the caller can decide whether to keep paging.
function applyFetchPagination(payload, args) {
  const fullContent = String(payload?.content ?? '')
  const totalLength = fullContent.length
  const startIndex = Math.max(0, Number.isFinite(args?.startIndex) ? args.startIndex : 0)
  const rawLimit = args?.maxLength
  const limit = rawLimit === 0
    ? Infinity
    : (rawLimit == null ? DEFAULT_FETCH_MAX_LENGTH : Math.max(0, Number(rawLimit)))
  if (startIndex >= totalLength) {
    return {
      ...payload,
      content: '',
      bytes: 0,
      totalLength,
      range: { startIndex, endIndex: startIndex },
      hasMore: false,
      nextStartIndex: null,
      truncated: false,
    }
  }
  const endIndex = Math.min(totalLength, startIndex + (Number.isFinite(limit) ? limit : totalLength - startIndex))
  const slice = fullContent.slice(startIndex, endIndex)
  const hasMore = endIndex < totalLength
  return {
    ...payload,
    content: slice,
    bytes: Buffer.byteLength(slice, 'utf-8'),
    totalLength,
    range: { startIndex, endIndex },
    hasMore,
    nextStartIndex: hasMore ? endIndex : null,
    truncated: hasMore || startIndex > 0,
  }
}

async function _fetchCore(args, { usageState, cacheState, timeoutMs, signal }) {
  const FETCH_URL_CAP = Math.max(1, Number(process.env.FETCH_URL_CAP) || 10)
  // Bound how many URLs scrape concurrently. Each non-cached URL can launch a
  // Puppeteer browser; running all FETCH_URL_CAP (default 10) at once can spawn
  // up to 10 Chromium processes simultaneously and exhaust memory/file handles.
  const FETCH_CONCURRENCY = Math.max(1, Number(process.env.FETCH_CONCURRENCY) || 3)
  const allUrls = Array.isArray(args.url) ? args.url : [args.url]
  const urls = allUrls.slice(0, FETCH_URL_CAP)

  const runOne = async (url, index) => {
    const normalizedUrl = normalizeCacheUrl(url)
    const fetchCacheKey = buildCacheKey('fetch:url', { url: normalizedUrl })
    const cached = getCachedEntry(cacheState, fetchCacheKey)
    if (cached) {
      return {
        index: index + 1,
        status: 'success',
        ...applyFetchPagination(cached.payload, args),
        cache: buildCacheMeta(cached, true),
      }
    }

    try {
      const [page] = await scrapeUrls([url], timeoutMs, usageState, signal)
      if (page?.error) {
        return {
          index: index + 1,
          status: 'error',
          tool: 'web_fetch',
          url,
          error: page.error,
        }
      }
      const payload = { tool: 'web_fetch', ...page }
      const cachedEntry = setCachedEntry(cacheState, fetchCacheKey, payload, getScrapeCacheTtlMs(false))
      return {
        index: index + 1,
        status: 'success',
        ...applyFetchPagination(payload, args),
        cache: buildCacheMeta(cachedEntry, false),
      }
    } catch (error) {
      // Pre-extractor failures (e.g. assertPublicUrl in web-tools) throw
      // before scrapeUrls returns a page-shaped error. Surface the raw
      // message verbatim so the caller sees the actual cause rather than
      // a silenced/swallowed result.
      const message = error instanceof Error
        ? (error.message || error.name || 'fetch failed')
        : String(error)
      const code = error?.code || error?.name || null
      return {
        index: index + 1,
        status: 'error',
        tool: 'web_fetch',
        url,
        error: message,
        ...(code ? { errorCode: code } : {}),
      }
    }
  }

  // Bounded worker pool: at most FETCH_CONCURRENCY runOne() calls in flight.
  const results = new Array(urls.length)
  let next = 0
  const worker = async () => {
    while (next < urls.length) {
      const i = next++
      results[i] = await runOne(urls[i], i)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, urls.length) }, worker),
  )

  return { tool: 'web_fetch', results, urlsTruncated: allUrls.length > urls.length ? allUrls.length : 0 }
}

// `search` and `web_fetch` are the public surface. `crawl` / `setup`
// remain `public: false`: still reachable via the module's
// handleToolCall and advertised when this module runs as a standalone
// MCP server, but excluded from the unified build-tools-manifest output
// so the Lead only sees the high-level entry points.
import { TOOL_DEFS as toolDefinitions } from './tool-defs.mjs'

const SEARCH_INSTRUCTIONS = '';

const server = new Server(
  {
    name: 'mixdog-search',
    version: PLUGIN_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: SEARCH_INSTRUCTIONS,
  },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions.filter(t => t.public !== false),
}))

async function handleToolCall(name, rawArgs, { signal } = {}) {
  const config = loadConfig()
  const usageState = loadUsageState()
  const cacheState = loadCacheState()
  const timeoutMs = getRequestTimeoutMs(config)

  switch (name) {
    case 'web_fetch': {
      let urlArgs
      try {
        urlArgs = searchUrlArgsSchema.parse(normalizeSearchUrlArgs(rawArgs || {}))
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid arguments', details: e.errors }) }], isError: true }
        }
        throw e
      }
      try {
        const result = await _fetchCore(urlArgs, { config, usageState, cacheState, timeoutMs, signal })
        flushCacheState()
        flushUsageState()
        return {
          ...formattedText('fetch', result),
          ...(result.results.some(item => item.status === 'success') ? {} : { isError: true }),
        }
      } catch (error) {
        flushUsageState()
        const _rawErr = error instanceof Error ? error.message : String(error)
        return { ...jsonText({ tool: 'web_fetch', url: urlArgs.url, error: normalizeErrorMessage(_rawErr) }), isError: true }
      }
    }
    case 'search': {
      let args
      if (rawArgs && rawArgs.pattern !== undefined && rawArgs.query === undefined && rawArgs.keywords === undefined) {
        return { content: [{ type: 'text', text: 'Error: web search requires query; use glob(pattern=...) for file paths.' }], isError: true }
      }
      // The public aiWrapped schema uses `query` (to match recall/explore style).
      // The direct zod schema expects `keywords`. Normalize so standalone callers
      // using the advertised schema don't get a validation error.
      if (rawArgs && rawArgs.query !== undefined && rawArgs.keywords === undefined) {
        rawArgs = { ...rawArgs, keywords: rawArgs.query }
        delete rawArgs.query
      }
      try {
        args = searchArgsSchema.parse(normalizeSearchArgs(rawArgs || {}))
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid arguments', details: e.errors }) }], isError: true }
        }
        throw e
      }
      // Fan-out: array `keywords` -> N parallel single-keyword calls,
      // grouped per-query with `### Query:` headers (mirrors recall fan-out).
      if (Array.isArray(args.keywords) && args.keywords.length > 1) {
        // Cap fan-out breadth: bounds both the parallel provider calls and the
        // aggregate result size. Env-overridable; extras dropped with a note.
        const SEARCH_FANOUT_CAP = Math.max(1, Number(process.env.SEARCH_FANOUT_CAP) || 10)
        const allKeywords = [...new Set(args.keywords.map(kw => String(kw || '').trim()).filter(Boolean))]
        const dedupedKeywords = allKeywords.slice(0, SEARCH_FANOUT_CAP)
        const FANOUT_CONCURRENCY = Math.max(1, Number(process.env.SEARCH_FANOUT_CONCURRENCY) || 10)
        const fanOutAbort = new AbortController()
        const deadlineSec = Math.max(1, Number(process.env.SEARCH_FANOUT_DEADLINE_S) || 180)
        const deadlineMs = deadlineSec * 1000
        let deadlineTimer
        let onToolCallAbort
        if (signal) {
          const abortFanoutFromToolCall = () => {
            fanOutAbort.abort(signal.reason ?? new Error('search aborted'))
          }
          if (signal.aborted) {
            abortFanoutFromToolCall()
          } else {
            onToolCallAbort = abortFanoutFromToolCall
            signal.addEventListener('abort', onToolCallAbort, { once: true })
          }
        }
        const deadlineRace = new Promise((_res, rej) => {
          deadlineTimer = setTimeout(() => {
            fanOutAbort.abort(new Error(`fan-out deadline exceeded (${deadlineSec}s)`))
            rej(Object.assign(new Error(`fan-out deadline exceeded (${deadlineSec}s)`), { _deadline: true }))
          }, deadlineMs)
        })
        // Track per-query results as they settle so a deadline hit preserves
        // anything that already completed (Promise.allSettled would otherwise
        // only assign `settled` after the whole batch finishes).
        const partial = new Array(dedupedKeywords.length)
        let fanoutActive = 0
        const fanoutPending = []
        const acquireFanoutSlot = () => {
          if (fanOutAbort.signal.aborted) return Promise.reject(fanOutAbort.signal.reason)
          if (fanoutActive < FANOUT_CONCURRENCY) {
            fanoutActive++
            return Promise.resolve()
          }
          return new Promise((resolve, reject) => {
            const waiter = { resolve, reject }
            const onAbort = () => {
              const idx = fanoutPending.indexOf(waiter)
              if (idx !== -1) fanoutPending.splice(idx, 1)
              reject(fanOutAbort.signal.reason)
            }
            waiter.onAbort = onAbort
            fanoutPending.push(waiter)
            fanOutAbort.signal.addEventListener('abort', onAbort, { once: true })
          })
        }
        const releaseFanoutSlot = () => {
          while (fanoutPending.length > 0) {
            const waiter = fanoutPending.shift()
            if (fanOutAbort.signal.aborted) {
              if (waiter.onAbort) fanOutAbort.signal.removeEventListener('abort', waiter.onAbort)
              waiter.reject(fanOutAbort.signal.reason)
              continue
            }
            if (waiter.onAbort) fanOutAbort.signal.removeEventListener('abort', waiter.onAbort)
            waiter.resolve()   // slot transferred; do NOT change fanoutActive
            return
          }
          fanoutActive--
        }
        const queryPromises = dedupedKeywords.map((kw, i) => (async () => {
          await acquireFanoutSlot()
          try {
            const sub = await handleToolCall('search', { ...rawArgs, keywords: kw }, { signal: fanOutAbort.signal })
            if (fanOutAbort.signal.aborted) throw fanOutAbort.signal.reason
            const text = (sub.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n')
            if (sub.isError) {
              throw Object.assign(new Error(text || 'sub-search failed'), { _subError: true })
            }
            return `### Query: ${kw}\n\n${text}`
          } finally {
            releaseFanoutSlot()
          }
        })().then(
          (value) => { partial[i] = { status: 'fulfilled', value }; return value },
          (reason) => { partial[i] = { status: 'rejected', reason }; throw reason },
        ))
        let settled
        try {
          settled = await Promise.race([
            Promise.allSettled(queryPromises),
            deadlineRace,
          ])
        } catch (err) {
          if (!err._deadline) throw err
          // Deadline hit — preserve any completed partial results; mark the
          // rest as rejected with the abort reason.
          settled = dedupedKeywords.map((_kw, i) =>
            partial[i] ?? { status: 'rejected', reason: fanOutAbort.signal.reason }
          )
        } finally {
          clearTimeout(deadlineTimer)
          if (signal && onToolCallAbort) {
            signal.removeEventListener('abort', onToolCallAbort)
          }
        }
        const anyFulfilled = settled.some(r => r.status === 'fulfilled')
        const sections = settled.map((r, i) =>
          r.status === 'fulfilled'
            ? r.value
            : `### Query: ${dedupedKeywords[i]}\n\n[error] ${normalizeErrorMessage(String(r.reason?.message || r.reason))}`
        )
        const fanoutNote = allKeywords.length > dedupedKeywords.length
          ? `[fan-out capped at ${SEARCH_FANOUT_CAP} of ${allKeywords.length} keywords; raise SEARCH_FANOUT_CAP for more]\n\n`
          : ''
        return {
          content: [{ type: 'text', text: fanoutNote + sections.join('\n\n---\n\n') }],
          ...(anyFulfilled ? {} : { isError: true }),
        }
      }
      try {
        const result = await _searchCore(args, { config, usageState, cacheState, timeoutMs, signal })
        flushUsageState()
        return formattedText('search', result)
      } catch (error) {
        flushUsageState()
        const details = error.details || { tool: 'search' }
        const _rawErr = error instanceof Error ? error.message : String(error)
        return { ...jsonText({ ...details, error: normalizeErrorMessage(_rawErr) }), isError: true }
      }
    }

    case 'crawl': {
      let args
      try {
        args = crawlArgsSchema.parse(rawArgs || {})
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid arguments', details: e.errors }) }], isError: true }
        }
        throw e
      }
      try {
        const pages = await crawlSite(
          args.url,
          {
            maxPages: args.maxPages || config.crawl?.maxPages || 10,
            maxDepth: args.maxDepth ?? config.crawl?.maxDepth ?? 1,
            sameDomainOnly: args.sameDomainOnly ?? config.crawl?.sameDomainOnly ?? true,
          },
          timeoutMs,
          usageState,
          signal,
        )
        saveUsageState(usageState)
        return formattedText('crawl', {
          tool: 'crawl',
          pages,
        })
      } catch (error) {
        saveUsageState(usageState)
        const _rawErr = error instanceof Error ? error.message : String(error)
        return { ...jsonText({
          tool: 'crawl',
          url: args.url,
          error: normalizeErrorMessage(_rawErr),
        }), isError: true }
      }
    }

    case 'setup': {
      return await handleSetup(server)
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  return handleToolCall(request.params.name, request.params.arguments, { signal: extra?.signal })
})

/* ── Module exports (used when imported by mixdog-unified) ── */
export { toolDefinitions as TOOL_DEFS }
export { SEARCH_INSTRUCTIONS as instructions }

export { handleToolCall }
export async function start() { await writeStartupSnapshot() }
export function stop() { flushUsageState(); flushCacheState() }
