#!/usr/bin/env bun

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import fs from 'fs'
import {
  ensureDataDir,
  getRequestTimeoutMs,
  loadConfig,
} from './lib/config.mjs'
import { normalizeErrorMessage } from '../agent/orchestrator/tools/builtin/path-diagnostics.mjs'
import { presentErrorText } from '../shared/err-text.mjs'

function readPluginVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version || '0.0.1'
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
import {
  flushUsageState,
  loadUsageState,
  updateProviderState,
} from './lib/state.mjs'
import { getScrapeCapabilities, scrapeUrls } from './lib/web-tools.mjs'
import { formatResponse } from './lib/formatter.mjs'
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
  contextSize: z.enum(['low', 'medium', 'high']).optional().describe('Search context size hint. Default: low.'),
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

function normalizeCacheUrl(url) {
  try {
    return new URL(url).toString()
  } catch {
    return String(url)
  }
}

async function writeStartupSnapshot() {
  loadConfig()
  const usageState = loadUsageState()
  const scrapeCapabilities = getScrapeCapabilities()

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
}

// ── Core action implementations (shared by individual and batch handlers) ──

const _searchInFlight = new Map()

function searchArgsForCacheKey(args) {
  const keywords = Array.isArray(args.keywords)
    ? [...new Set(args.keywords.map(v => String(v || '').trim()).filter(Boolean))]
    : String(args.keywords || '').trim()
  return {
    keywords,
    site: args.site || null,
    type: args.type || 'web',
    locale: args.locale || null,
    contextSize: args.contextSize || 'low',
    maxResults: Math.max(1, Math.min(20, Number(args.maxResults) || 10)),
  }
}

function buildAgentSearchPrompt(args) {
  const query = Array.isArray(args.keywords) ? args.keywords.join('\n') : String(args.keywords || '')
  const lines = [
    'Perform a concise web research task for Mixdog search.',
    '',
    `Query: ${query}`,
    args.site ? `Site/domain restriction: ${args.site}` : null,
    args.type ? `Search type: ${args.type}` : null,
    args.locale ? `Locale: ${typeof args.locale === 'string' ? args.locale : JSON.stringify(args.locale)}` : null,
    `Max results: ${Math.max(1, Math.min(20, Number(args.maxResults) || 10))}`,
    '',
    'Return a short answer first, then cite useful results as title + URL + one-line snippet.',
    'Do not edit files.',
  ].filter(Boolean)
  return lines.join('\n')
}

function sourceUrl(source) {
  return String(source?.url || source?.uri || source?.href || source?.source_url || '').trim()
}

function sourceTitle(source, fallbackUrl = '') {
  return String(source?.title || source?.query || source?.name || fallbackUrl || '(untitled)').trim()
}

function sourceSnippet(source) {
  return String(source?.snippet || source?.text || source?.description || '').replace(/\s+/g, ' ').trim()
}

function collectNativeSearchSources(result) {
  const out = []
  const add = (source, fallback = {}) => {
    if (!source || typeof source !== 'object') return
    const url = sourceUrl(source)
    if (!url) return
    out.push({
      title: sourceTitle(source, fallback.title || url),
      url,
      snippet: sourceSnippet(source),
      source: source.source || fallback.source || 'native-web-search',
      provider: source.provider || fallback.provider || 'native-web-search',
      publishedDate: source.publishedDate || source.published_date || null,
    })
  }
  for (const citation of Array.isArray(result?.citations) ? result.citations : []) {
    add(citation, { source: 'citation' })
  }
  for (const call of Array.isArray(result?.webSearchCalls) ? result.webSearchCalls : []) {
    const action = call?.action || {}
    for (const source of Array.isArray(action.sources) ? action.sources : []) {
      add(source, { title: action.query || '', source: 'web_search_call' })
    }
    if (action.url) add({ url: action.url, title: action.query || '' }, { source: 'web_search_call' })
    for (const url of Array.isArray(action.urls) ? action.urls : []) {
      add({ url, title: action.query || '' }, { source: 'web_search_call' })
    }
  }
  const seen = new Set()
  return out.filter((item) => {
    const key = item.url || `${item.title}\n${item.snippet}`
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalizeNativeSearchPayload(result, args, startedAt) {
  if (result && typeof result === 'object' && result.tool === 'search' && result.response) {
    return result
  }
  const cacheArgs = searchArgsForCacheKey(args)
  const answer = typeof result === 'string' ? result : String(result?.content || result?.answer || '').trim()
  const provider = String(result?.provider || 'native-web-search')
  const results = collectNativeSearchSources(result).slice(0, cacheArgs.maxResults)
  const warnings = []
  if (!results.length && Array.isArray(result?.webSearchCalls) && result.webSearchCalls.length) {
    warnings.push('native web search returned no source URLs')
  }
  return {
    tool: 'search',
    provider,
    response: {
      usedProvider: provider,
      query: Array.isArray(cacheArgs.keywords) ? cacheArgs.keywords.join('\n') : cacheArgs.keywords,
      rawQuery: Array.isArray(cacheArgs.keywords) ? cacheArgs.keywords.join('\n') : cacheArgs.keywords,
      answer,
      model: result?.model || null,
      durationMs: Date.now() - startedAt,
      usage: result?.usage || null,
      results,
      warnings,
      type: cacheArgs.type,
      site: cacheArgs.site,
      locale: cacheArgs.locale,
    },
  }
}

async function _searchCore(args, { cacheState, nativeSearch, signal }) {
  const cacheArgs = searchArgsForCacheKey(args)
  const backend = 'native-web-search'
  const searchCacheKey = buildCacheKey('search', {
    provider: backend,
    ...cacheArgs,
  })
  const cachedSearch = getCachedEntry(cacheState, searchCacheKey)
  if (cachedSearch) return { ...cachedSearch.payload, cache: buildCacheMeta(cachedSearch, true) }

  const existing = _searchInFlight.get(searchCacheKey)
  if (existing) return existing

  const run = (async () => {
    if (signal?.aborted) throw signal.reason || new Error('search aborted')
    if (typeof nativeSearch === 'function') {
      const startedAt = Date.now()
      const result = await nativeSearch({
        ...args,
        ...cacheArgs,
        prompt: buildAgentSearchPrompt({ ...args, ...cacheArgs }),
      })
      const payload = normalizeNativeSearchPayload(result, { ...args, ...cacheArgs }, startedAt)
      const cachedEntry = setCachedEntry(cacheState, searchCacheKey, payload, getSearchCacheTtlMs(cacheArgs.type))
      flushCacheState()
      return { ...payload, cache: buildCacheMeta(cachedEntry, false) }
    }
    throw new Error('search provider unavailable: open /search to choose a search provider/model')
  })()

  run.catch(() => {})
  _searchInFlight.set(searchCacheKey, run)
  try {
    return await run
  } finally {
    if (_searchInFlight.get(searchCacheKey) === run) _searchInFlight.delete(searchCacheKey)
  }
}

const DEFAULT_FETCH_MAX_LENGTH = 50000
const FETCH_CACHE_VERSION = 'auto-render-js-fallback-v1'

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
    const fetchCacheKey = buildCacheKey('fetch:url', { url: normalizedUrl, version: FETCH_CACHE_VERSION })
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

// Web search is supplied by the runtime through the configured native search
// route. The module owns argument validation, caching, fan-out, and formatting.
import { TOOL_DEFS as toolDefinitions } from './tool-defs.mjs'

const SEARCH_INSTRUCTIONS = '';

const server = new Server(
  {
    name: 'mixdog-web',
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

async function handleToolCall(name, rawArgs, options = {}) {
  const { signal, nativeSearch } = options || {}
  const config = loadConfig()
  const usageState = loadUsageState()
  const cacheState = loadCacheState()
  const timeoutMs = getRequestTimeoutMs(config)

  switch (name) {
    case 'search': {
      let args
      if (rawArgs && rawArgs.pattern !== undefined && rawArgs.query === undefined && rawArgs.keywords === undefined) {
        return { content: [{ type: 'text', text: 'Error: web search requires query; use glob(pattern=...) for file paths.' }], isError: true }
      }
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
      const runSearchNow = async () => {
        if (Array.isArray(args.keywords) && args.keywords.length > 1) {
          const SEARCH_FANOUT_CAP = Math.max(1, Number(process.env.SEARCH_FANOUT_CAP) || 10)
          const keywords = [...new Set(args.keywords.map(kw => String(kw || '').trim()).filter(Boolean))].slice(0, SEARCH_FANOUT_CAP)
          const sections = await Promise.all(keywords.map(async (kw) => {
            const sub = await handleToolCall('search', { ...rawArgs, keywords: kw }, { signal, nativeSearch })
            const text = (sub.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n')
            return `### Query: ${kw}\n\n${text}`
          }))
          return { content: [{ type: 'text', text: sections.join('\n\n---\n\n') }] }
        }
        try {
          const result = await _searchCore(args, { cacheState, nativeSearch, signal })
          flushUsageState()
          return formattedText('search', result)
        } catch (error) {
          flushUsageState()
          const _rawErr = normalizeErrorMessage(error instanceof Error ? error.message : String(error))
          const _cleanErr = presentErrorText(_rawErr, { surface: 'search' })
          return { content: [{ type: 'text', text: `Search failed: ${_cleanErr}` }], isError: true }
        }
      }
      return runSearchNow()
    }
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
        const result = await _fetchCore(urlArgs, { usageState, cacheState, timeoutMs, signal })
        flushCacheState()
        flushUsageState()
        return {
          ...formattedText('fetch', result),
          ...(result.results.some(item => item.status === 'success') ? {} : { isError: true }),
        }
      } catch (error) {
        flushUsageState()
        const _rawErr = normalizeErrorMessage(error instanceof Error ? error.message : String(error))
        const _cleanErr = presentErrorText(_rawErr, { surface: 'web_fetch' })
        return { content: [{ type: 'text', text: `Fetch failed: ${_cleanErr}` }], isError: true }
      }
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
