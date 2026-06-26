#!/usr/bin/env bun

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
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
  noteProviderFailure,
  classifyProviderError,
  noteProviderSuccess,
  saveUsageState,
  updateProviderState,
} from './lib/state.mjs'
import { assertPublicUrl, crawlSite, getScrapeCapabilities, pinnedFetch, scrapeUrls } from './lib/web-tools.mjs'
import { formatResponse } from './lib/formatter.mjs'
import {
  cancelBackgroundTask,
  getBackgroundTask,
  renderBackgroundTask,
  renderBackgroundTaskList,
  resolveExecutionMode,
  startBackgroundTask,
  taskIdFromArgs,
} from '../shared/background-tasks.mjs'


ensureDataDir()

const searchArgsSchema = z.object({
  keywords: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).describe('Search query string or array of queries.'),
  mode: z.enum(['sync', 'async']).optional(),
  action: z.enum(['run', 'list', 'status', 'read', 'cancel']).optional(),
  task_id: z.string().optional(),
  firstResponseTimeoutMs: z.number().int().min(0).optional(),
  idleTimeoutMs: z.number().int().min(0).optional(),
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

const SEARCH_EMPTY_STRING_FIELDS = ['keywords', 'site', 'type', 'locale', 'contextSize', 'mode', 'action', 'task_id', 'firstResponseTimeoutMs', 'idleTimeoutMs']

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

function toolText(response) {
  if (typeof response === 'string') return response
  const parts = Array.isArray(response?.content) ? response.content : []
  const text = parts
    .filter(part => part?.type === 'text')
    .map(part => part.text)
    .join('\n')
  return text || JSON.stringify(response, null, 2)
}

function okText(text) {
  return { content: [{ type: 'text', text }], isError: false }
}

function searchTaskControl(action, args = {}, options = {}) {
  if (action === 'list') return okText(renderBackgroundTaskList({ surface: 'search', context: options }))
  const taskId = taskIdFromArgs(args)
  if (!taskId) return { ...okText('Error: task_id is required'), isError: true }
  const task = getBackgroundTask(taskId, { surface: 'search', context: options })
  if (!task) return { ...okText(`Error: search task not found: ${taskId}`), isError: true }
  if (action === 'cancel') {
    cancelBackgroundTask(taskId, 'cancelled by search control')
    return okText(renderBackgroundTask(task, { includeResult: true }))
  }
  return okText(renderBackgroundTask(task, { includeResult: action === 'read' }))
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

async function _searchCore(args, { cacheState, agentSearch, signal }) {
  const cacheArgs = searchArgsForCacheKey(args)
  const searchCacheKey = buildCacheKey('search', {
    provider: 'web-researcher',
    ...cacheArgs,
  })
  const cachedSearch = getCachedEntry(cacheState, searchCacheKey)
  if (cachedSearch) return { ...cachedSearch.payload, cache: buildCacheMeta(cachedSearch, true) }

  const existing = _searchInFlight.get(searchCacheKey)
  if (existing) return existing

  const run = (async () => {
    if (signal?.aborted) throw signal.reason || new Error('search aborted')
    if (typeof agentSearch !== 'function') {
      throw new Error('search provider unavailable: Web Researcher agent bridge is not attached')
    }
    const startedAt = Date.now()
    const content = await agentSearch({
      ...args,
      ...cacheArgs,
      prompt: buildAgentSearchPrompt({ ...args, ...cacheArgs }),
    })
    const answer = String(content || '').trim()
    const payload = {
      tool: 'search',
      provider: 'web-researcher',
      response: {
        usedProvider: 'web-researcher',
        query: Array.isArray(cacheArgs.keywords) ? cacheArgs.keywords.join('\n') : cacheArgs.keywords,
        rawQuery: Array.isArray(cacheArgs.keywords) ? cacheArgs.keywords.join('\n') : cacheArgs.keywords,
        answer,
        model: null,
        durationMs: Date.now() - startedAt,
        usage: null,
        results: [],
        warnings: [],
        type: cacheArgs.type,
        site: cacheArgs.site,
        locale: cacheArgs.locale,
      },
    }
    const cachedEntry = setCachedEntry(cacheState, searchCacheKey, payload, getSearchCacheTtlMs(cacheArgs.type))
    flushCacheState()
    return { ...payload, cache: buildCacheMeta(cachedEntry, false) }
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

// Only `web_fetch` remains in the direct web module. Web search is routed
// through the Web Researcher agent, so there is no standalone search provider
// configuration or search backend selection surface.
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
  const { signal, agentSearch } = options || {}
  const config = loadConfig()
  const usageState = loadUsageState()
  const cacheState = loadCacheState()
  const timeoutMs = getRequestTimeoutMs(config)

  switch (name) {
    case 'search': {
      let args
      const rawAction = String(rawArgs?.action || 'run').trim().toLowerCase()
      if (['list', 'status', 'read', 'cancel'].includes(rawAction)) {
        return searchTaskControl(rawAction, rawArgs || {}, options)
      }
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
            const sub = await handleToolCall('search', { ...rawArgs, keywords: kw, mode: 'sync', action: 'run' }, { signal, agentSearch })
            const text = (sub.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n')
            return `### Query: ${kw}\n\n${text}`
          }))
          return { content: [{ type: 'text', text: sections.join('\n\n---\n\n') }] }
        }
        try {
          const result = await _searchCore(args, { cacheState, agentSearch, signal })
          flushUsageState()
          return formattedText('search', result)
        } catch (error) {
          flushUsageState()
          const _rawErr = normalizeErrorMessage(error instanceof Error ? error.message : String(error))
          const _cleanErr = presentErrorText(_rawErr, { surface: 'search' })
          return { content: [{ type: 'text', text: `Search failed: ${_cleanErr}` }], isError: true }
        }
      }
      if (resolveExecutionMode(args, 'sync') === 'async') {
        const label = Array.isArray(args.keywords)
          ? args.keywords.join(' | ')
          : String(args.keywords || '')
        const task = startBackgroundTask({
          surface: 'search',
          operation: 'search',
          label: label.replace(/\s+/g, ' ').slice(0, 120),
          input: { keywords: args.keywords, site: args.site || null, type: args.type || 'web' },
          context: options,
          resultType: 'search_task_result',
          renderResult: (text) => String(text || ''),
          run: async () => {
            const response = await runSearchNow()
            const text = toolText(response)
            if (response?.isError) throw new Error(text)
            return text
          },
        })
        return okText(renderBackgroundTask(task))
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
        const result = await _fetchCore(urlArgs, { config, usageState, cacheState, timeoutMs, signal })
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
