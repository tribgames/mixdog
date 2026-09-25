#!/usr/bin/env bun

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import fs from 'node:fs';
import { ensureDataDir, getRequestTimeoutMs, loadConfig } from './lib/config.mjs';
import { normalizeErrorMessage } from '../agent/orchestrator/tools/builtin/path-diagnostics.mjs';
import { presentErrorText } from '../shared/err-text.mjs';

function readPluginVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version || '0.0.1';
  } catch {
    return '0.0.1';
  }
}
const PLUGIN_VERSION = readPluginVersion();
import {
  buildCacheKey,
  buildCacheMeta,
  flushCacheState,
  getCachedEntry,
  loadCacheState,
  setCachedEntry,
} from './lib/cache.mjs';
import { flushUsageState, loadUsageState, updateProviderState } from './lib/state.mjs';
import { closeScrapeBrowserPool, getScrapeCapabilities, scrapeUrls } from './lib/web-tools.mjs';
import { fetchLoopbackText, fetchPublicImage } from './lib/http-fetch.mjs';
import { applyFetchPagination, formatResponse } from './lib/formatter.mjs';
ensureDataDir();

const webSearchArgsSchema = z.object({
  keywords: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .describe('Search query string or array of queries.'),
  site: z.string().optional().describe('Restrict results to a specific domain.'),
  type: z.enum(['web', 'news', 'images']).optional().describe('Search type. Default: web.'),
  maxResults: z.number().int().min(1).max(20).optional().describe('Maximum number of results to return (1-20).'),
  locale: z
    .union([
      z.string(),
      z.object({
        country: z.string().optional(),
        language: z.string().optional(),
        region: z.string().optional(),
        city: z.string().optional(),
        timezone: z.string().optional(),
      }),
    ])
    .optional()
    .describe('Explicit search locale. String such as "ko-KR" or object with country/language/city/region/timezone.'),
  contextSize: z.enum(['low', 'medium', 'high']).optional().describe('Search context size hint. Default: low.'),
});

const urlArgsSchema = z.object({
  url: z.union([z.string().url(), z.array(z.string().url()).min(1)]).describe('Single URL or array of URLs to fetch.'),
  startIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Character offset to start the slice from (default 0). For chunked reading of large pages, pass the previous response's nextStartIndex."
    ),
  maxLength: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Max characters to return per call (default 50000). Pass 0 for unlimited.'),
  cwd: z.string().optional(),
});

const WEB_SEARCH_EMPTY_STRING_FIELDS = ['keywords', 'site', 'type', 'locale', 'contextSize'];

function normalizeWebSearchArgs(rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return rawArgs;
  const args = { ...rawArgs };
  for (const key of WEB_SEARCH_EMPTY_STRING_FIELDS) {
    const value = args[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) delete args[key];
      else args[key] = trimmed;
    }
  }
  if (Array.isArray(args.keywords)) {
    args.keywords = args.keywords.map((value) => (typeof value === 'string' ? value.trim() : value));
  }
  return args;
}

function normalizeUrlArgs(rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return rawArgs;
  const args = { ...rawArgs };
  if (typeof args.url === 'string') args.url = args.url.trim();
  if (Array.isArray(args.url)) {
    const urls = args.url
      .map((value) => (typeof value === 'string' ? value.trim() : value))
      .filter((value) => (typeof value === 'string' ? value.length > 0 : Boolean(value)));
    if (urls.length > 0) args.url = urls;
    else delete args.url;
  }
  return args;
}

/** Zod rejection of tool arguments is a caller error, not a server failure. */
function invalidArgsResponse(error) {
  if (!(error instanceof z.ZodError)) return null;
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid arguments', details: error.errors }) }],
    isError: true,
  };
}

/** `{ args }` on success, `{ invalid }` for a Zod rejection; any other error propagates. */
function parseToolArgs(schema, value) {
  try {
    return { args: schema.parse(value) };
  } catch (error) {
    const invalid = invalidArgsResponse(error);
    if (invalid) return { invalid };
    throw error;
  }
}

function toolFailure(prefix, error, surface) {
  const message = presentErrorText(normalizeErrorMessage(error instanceof Error ? error.message : String(error)), {
    surface,
  });
  return { content: [{ type: 'text', text: `${prefix}: ${message}` }], isError: true };
}

function formattedText(tool, payload) {
  const text = formatResponse(tool, tool === 'web_search' ? dropInvalidWebSearchResults(payload) : payload);
  return {
    content: [{ type: 'text', text }],
  };
}

function isInvalidWebSearchResult(result) {
  const title = String(result?.title || '').trim();
  return /\bpage not found\b|\b404\b.*\bnot found\b/i.test(title);
}

function dropInvalidWebSearchResults(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const response = payload.response;
  if (!response || typeof response !== 'object' || !Array.isArray(response.results)) return payload;
  const results = response.results.filter((result) => !isInvalidWebSearchResult(result));
  if (results.length === response.results.length) return payload;
  return {
    ...payload,
    response: {
      ...response,
      results,
      droppedInvalidResults: (response.droppedInvalidResults || 0) + (response.results.length - results.length),
    },
  };
}

function getWebSearchCacheTtlMs(type = 'web') {
  switch (type) {
    case 'news':
      return 20 * 60 * 1000;
    case 'images':
      return 60 * 60 * 1000;
    // 'web' and any unknown type.
    default:
      return 30 * 60 * 1000;
  }
}

function getScrapeCacheTtlMs() {
  return 60 * 60 * 1000;
}

function normalizeCacheUrl(url) {
  try {
    return new URL(url).toString();
  } catch {
    return String(url);
  }
}

async function writeStartupSnapshot() {
  loadConfig();
  const usageState = loadUsageState();
  const scrapeCapabilities = getScrapeCapabilities();

  updateProviderState(usageState, 'readability', {
    available: scrapeCapabilities.readability,
    connection: 'builtin',
    source: 'local',
  });

  updateProviderState(usageState, 'puppeteer', {
    available: scrapeCapabilities.puppeteer,
    connection: 'local-browser',
    source: 'local',
  });
}

const _webSearchInFlight = new Map();

/** Result cap policy shared by the cache key and the agent prompt. */
function clampMaxResults(value) {
  return Math.max(1, Math.min(20, Number(value) || 10));
}

function webSearchArgsForCacheKey(args) {
  const keywords = Array.isArray(args.keywords)
    ? [...new Set(args.keywords.map((v) => String(v || '').trim()).filter(Boolean))]
    : String(args.keywords || '').trim();
  return {
    keywords,
    site: args.site || null,
    type: args.type || 'web',
    locale: args.locale || null,
    contextSize: args.contextSize || 'low',
    maxResults: clampMaxResults(args.maxResults),
  };
}

function buildAgentWebSearchPrompt(args) {
  const query = Array.isArray(args.keywords) ? args.keywords.join('\n') : String(args.keywords || '');
  const localeLabel = typeof args.locale === 'string' ? args.locale : JSON.stringify(args.locale);
  const lines = [
    'Perform a concise web research task for Mixdog web search.',
    '',
    `Query: ${query}`,
    args.site ? `Site/domain restriction: ${args.site}` : null,
    args.type ? `Search type: ${args.type}` : null,
    args.locale ? `Locale: ${localeLabel}` : null,
    `Max results: ${clampMaxResults(args.maxResults)}`,
    '',
    'Return a short answer first, then cite useful results as title + URL + one-line snippet.',
    'Do not edit files.',
  ].filter(Boolean);
  return lines.join('\n');
}

// Native providers disagree on citation field names. These lists are the
// accepted shapes, not a guess: the first present string wins.
const NATIVE_SOURCE_URL_FIELDS = ['url', 'uri', 'href', 'source_url'];
const NATIVE_SOURCE_TITLE_FIELDS = ['title', 'query', 'name'];
const NATIVE_SOURCE_SNIPPET_FIELDS = ['snippet', 'text', 'description'];

function firstSourceField(source, names, fallback = '') {
  let raw = fallback;
  if (source && typeof source === 'object') {
    for (const name of names) {
      if (source[name]) {
        raw = source[name];
        break;
      }
    }
  }
  return String(raw || '').trim();
}

function sourceUrl(source) {
  return firstSourceField(source, NATIVE_SOURCE_URL_FIELDS);
}

function sourceTitle(source, fallbackUrl = '') {
  return firstSourceField(source, NATIVE_SOURCE_TITLE_FIELDS, fallbackUrl || '(untitled)');
}

function sourceSnippet(source) {
  return firstSourceField(source, NATIVE_SOURCE_SNIPPET_FIELDS).replace(/\s+/g, ' ').trim();
}

function collectNativeWebSearchSources(result) {
  const out = [];
  const add = (source, fallback = {}) => {
    if (!source || typeof source !== 'object') return;
    const url = sourceUrl(source);
    if (!url) return;
    out.push({
      title: sourceTitle(source, fallback.title || url),
      url,
      snippet: sourceSnippet(source),
      source: source.source || fallback.source || 'native-web-search',
      provider: source.provider || fallback.provider || 'native-web-search',
      publishedDate: source.publishedDate || source.published_date || null,
    });
  };
  for (const citation of Array.isArray(result?.citations) ? result.citations : []) {
    add(citation, { source: 'citation' });
  }
  for (const call of Array.isArray(result?.webSearchCalls) ? result.webSearchCalls : []) {
    const action = call?.action || {};
    for (const source of Array.isArray(action.sources) ? action.sources : []) {
      add(source, { title: action.query || '', source: 'web_search_call' });
    }
    if (action.url) add({ url: action.url, title: action.query || '' }, { source: 'web_search_call' });
    for (const url of Array.isArray(action.urls) ? action.urls : []) {
      add({ url, title: action.query || '' }, { source: 'web_search_call' });
    }
  }
  const seen = new Set();
  return out.filter((item) => {
    const key = item.url || `${item.title}\n${item.snippet}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeNativeWebSearchPayload(result, args, startedAt) {
  if (result && typeof result === 'object' && result.tool === 'web_search' && result.response) {
    return result;
  }
  const cacheArgs = webSearchArgsForCacheKey(args);
  const answer = typeof result === 'string' ? result : String(result?.content || result?.answer || '').trim();
  const provider = String(result?.provider || 'native-web-search');
  const results = collectNativeWebSearchSources(result).slice(0, cacheArgs.maxResults);
  const query = Array.isArray(cacheArgs.keywords) ? cacheArgs.keywords.join('\n') : cacheArgs.keywords;
  const warnings = [];
  if (!results.length && Array.isArray(result?.webSearchCalls) && result.webSearchCalls.length) {
    warnings.push('native web search returned no source URLs');
  }
  return {
    tool: 'web_search',
    provider,
    response: {
      usedProvider: provider,
      query,
      rawQuery: query,
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
  };
}

async function _webSearchCore(args, { cacheState, nativeWebSearch, signal }) {
  const cacheArgs = webSearchArgsForCacheKey(args);
  const provider = 'native-web-search';
  const webSearchCacheKey = buildCacheKey('web_search', {
    provider,
    ...cacheArgs,
  });
  const cachedWebSearch = getCachedEntry(cacheState, webSearchCacheKey);
  if (cachedWebSearch) return { ...cachedWebSearch.payload, cache: buildCacheMeta(cachedWebSearch, true) };

  if (signal?.aborted) throw signal.reason || new Error('web search aborted');
  const existing = _webSearchInFlight.get(webSearchCacheKey);
  if (existing) return joinWebSearch(existing, webSearchCacheKey, signal);

  // The shared run owns its own controller: it is aborted only once every
  // caller waiting on it has left, so one caller's cancel never fails another.
  const controller = new AbortController();
  const run = (async () => {
    if (typeof nativeWebSearch === 'function') {
      const startedAt = Date.now();
      const result = await nativeWebSearch({
        ...args,
        ...cacheArgs,
        prompt: buildAgentWebSearchPrompt({ ...args, ...cacheArgs }),
        signal: controller.signal,
      });
      const payload = normalizeNativeWebSearchPayload(result, { ...args, ...cacheArgs }, startedAt);
      const cachedEntry = setCachedEntry(
        cacheState,
        webSearchCacheKey,
        payload,
        getWebSearchCacheTtlMs(cacheArgs.type)
      );
      flushCacheState();
      return { ...payload, cache: buildCacheMeta(cachedEntry, false) };
    }
    throw new Error('web search provider unavailable: open /websearch to choose a web search provider/model');
  })();

  const entry = { run, controller, waiters: 0 };
  run
    .finally(() => {
      if (_webSearchInFlight.get(webSearchCacheKey) === entry) _webSearchInFlight.delete(webSearchCacheKey);
    })
    .catch(() => {});
  _webSearchInFlight.set(webSearchCacheKey, entry);
  return joinWebSearch(entry, webSearchCacheKey, signal);
}

/** Wait on a shared in-flight search; an aborted caller leaves at once, and
 *  the last one to leave aborts the provider work. */
function joinWebSearch(entry, key, signal) {
  entry.waiters += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const leave = () => {
      if (settled) return false;
      settled = true;
      entry.waiters -= 1;
      signal?.removeEventListener('abort', onAbort);
      return true;
    };
    const onAbort = () => {
      if (!leave()) return;
      const reason = signal.reason || new Error('web search aborted');
      if (entry.waiters === 0) {
        if (_webSearchInFlight.get(key) === entry) _webSearchInFlight.delete(key);
        entry.controller.abort(reason);
      }
      reject(reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    entry.run.then(
      (value) => leave() && resolve(value),
      (error) => leave() && reject(error)
    );
  });
}

const FETCH_CACHE_VERSION = 'document-pipeline-v3';

async function _fetchCore(args, { usageState, cacheState, timeoutMs, signal }) {
  const FETCH_URL_CAP = Math.max(1, Number(process.env.FETCH_URL_CAP) || 10);
  // Bound document jobs in addition to the shared browser page pool.
  const FETCH_CONCURRENCY = Math.max(1, Number(process.env.FETCH_CONCURRENCY) || 3);
  const allUrls = Array.isArray(args.url) ? args.url : [args.url];
  const urls = allUrls.slice(0, FETCH_URL_CAP);

  const runOne = async (url, index) => {
    const normalizedUrl = normalizeCacheUrl(url);
    const fetchCacheKey = buildCacheKey('fetch:url', { url: normalizedUrl, version: FETCH_CACHE_VERSION });
    const cached = getCachedEntry(cacheState, fetchCacheKey);
    if (cached) {
      return {
        index: index + 1,
        status: 'success',
        ...applyFetchPagination(cached.payload, args),
        cache: buildCacheMeta(cached, true),
      };
    }

    try {
      const [page] = await scrapeUrls([url], timeoutMs, usageState, signal);
      if (page?.error) {
        return {
          index: index + 1,
          status: 'error',
          tool: 'web_fetch',
          url,
          error: page.error,
          errorCode: page.errorCode,
          failures: page.failures,
          attempts: page.attempts,
        };
      }
      const payload = { tool: 'web_fetch', ...page };
      const cachedEntry = setCachedEntry(cacheState, fetchCacheKey, payload, getScrapeCacheTtlMs());
      return {
        index: index + 1,
        status: 'success',
        ...applyFetchPagination(payload, args),
        cache: buildCacheMeta(cachedEntry, false),
      };
    } catch (error) {
      // Pre-extractor failures (e.g. assertPublicUrl in web-tools) throw
      // before scrapeUrls returns a page-shaped error. Surface the raw
      // message verbatim so the caller sees the actual cause rather than
      // a silenced/swallowed result.
      const message = error instanceof Error ? error.message || error.name || 'fetch failed' : String(error);
      const code = error?.code || error?.name || null;
      return {
        index: index + 1,
        status: 'error',
        tool: 'web_fetch',
        url,
        error: message,
        ...(code ? { errorCode: code } : {}),
      };
    }
  };

  // Bounded worker pool: at most FETCH_CONCURRENCY runOne() calls in flight.
  const results = new Array(urls.length);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      results[i] = await runOne(urls[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, urls.length) }, worker));

  return { tool: 'web_fetch', results, urlsTruncated: allUrls.length > urls.length ? allUrls.length : 0 };
}

// Web search is supplied by the runtime through the configured native search
// route. The module owns argument validation, caching, fan-out, and formatting.
import { TOOL_DEFS as toolDefinitions } from './tool-defs.mjs';

const WEB_SEARCH_INSTRUCTIONS = '';

const server = new Server(
  {
    name: 'mixdog-web',
    version: PLUGIN_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: WEB_SEARCH_INSTRUCTIONS,
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions.filter((t) => t.public !== false),
}));

/** One web_search call per distinct keyword, joined into one text result. */
async function webSearchFanout(rawArgs, keywordList, { signal, nativeWebSearch }) {
  const concurrency = Math.max(1, Number(process.env.WEB_SEARCH_FANOUT_CONCURRENCY) || 10);
  const keywords = [...new Set(keywordList.map((kw) => String(kw || '').trim()).filter(Boolean))];
  const sections = new Array(keywords.length);
  let cursor = 0;
  let failed = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, keywords.length) }, async () => {
      while (cursor < keywords.length) {
        const index = cursor++;
        const kw = keywords[index];
        const sub = await handleToolCall('web_search', { ...rawArgs, keywords: kw }, { signal, nativeWebSearch });
        const text = (sub.content || [])
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('\n');
        if (sub.isError) failed++;
        sections[index] = `### Query: ${kw}\n\n${text}`;
      }
    })
  );
  const summary = failed
    ? `[web_search] ${failed}/${keywords.length} queries failed; successful results are retained.\n\n`
    : '';
  return {
    content: [{ type: 'text', text: summary + sections.join('\n\n---\n\n') }],
    ...(failed ? { isError: true } : {}),
  };
}

/** local_fetch (loopback text) and image_fetch (public image) share URL limits and the timeout signal. */
async function fetchLocalOrImage(name, urlArgs, { signal, timeoutMs }) {
  const urls = Array.isArray(urlArgs.url) ? urlArgs.url : [urlArgs.url];
  if (urls.length > 8)
    return { content: [{ type: 'text', text: 'Error: fetch batch exceeds maximum of 8 URLs.' }], isError: true };
  const fetchSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  try {
    const parts = [];
    if (name === 'local_fetch') {
      for (const url of urls) {
        const text = await fetchLoopbackText(url, { signal: fetchSignal });
        const start = urlArgs.startIndex || 0;
        const max = urlArgs.maxLength == null ? 50_000 : urlArgs.maxLength;
        const body = max === 0 ? text.slice(start) : text.slice(start, start + max);
        parts.push({ type: 'text', text: `${url}\n\n${body}` });
      }
      return { content: parts };
    }
    for (const url of urls) {
      const image = await fetchPublicImage(url, { signal: fetchSignal });
      parts.push({ type: 'text', text: `Downloaded image: ${url} (${image.mimeType}, ${image.bytes} bytes)` });
      parts.push({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } });
    }
    return { content: parts };
  } catch (error) {
    return toolFailure('Fetch failed', error, name);
  }
}

async function handleToolCall(name, rawArgs, options = {}) {
  const { signal, nativeWebSearch } = options || {};
  const config = loadConfig();
  const usageState = loadUsageState();
  const cacheState = loadCacheState();
  const timeoutMs = getRequestTimeoutMs(config);

  switch (name) {
    case 'web_search': {
      if (rawArgs && rawArgs.pattern !== undefined && rawArgs.query === undefined && rawArgs.keywords === undefined) {
        return {
          content: [{ type: 'text', text: 'Error: web search requires query; use glob(pattern=...) for file paths.' }],
          isError: true,
        };
      }
      if (rawArgs && rawArgs.query !== undefined && rawArgs.keywords === undefined) {
        rawArgs = { ...rawArgs, keywords: rawArgs.query };
        delete rawArgs.query;
      }
      const { args, invalid } = parseToolArgs(webSearchArgsSchema, normalizeWebSearchArgs(rawArgs || {}));
      if (invalid) return invalid;
      if (Array.isArray(args.keywords) && args.keywords.length > 1) {
        return webSearchFanout(rawArgs, args.keywords, { signal, nativeWebSearch });
      }
      try {
        const result = await _webSearchCore(args, { cacheState, nativeWebSearch, signal });
        flushUsageState();
        return formattedText('web_search', result);
      } catch (error) {
        flushUsageState();
        return toolFailure('Web search failed', error, 'web_search');
      }
    }
    case 'web_fetch': {
      const { args: urlArgs, invalid } = parseToolArgs(urlArgsSchema, normalizeUrlArgs(rawArgs || {}));
      if (invalid) return invalid;
      try {
        const result = await _fetchCore(urlArgs, { usageState, cacheState, timeoutMs, signal });
        flushCacheState();
        flushUsageState();
        return {
          ...formattedText('fetch', result),
          ...(result.results.some((item) => item.status === 'success') ? {} : { isError: true }),
        };
      } catch (error) {
        flushUsageState();
        return toolFailure('Fetch failed', error, 'web_fetch');
      }
    }
    case 'local_fetch':
    case 'image_fetch': {
      const { args: urlArgs, invalid } = parseToolArgs(urlArgsSchema, normalizeUrlArgs(rawArgs || {}));
      if (invalid) return invalid;
      return fetchLocalOrImage(name, urlArgs, { signal, timeoutMs });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  return handleToolCall(request.params.name, request.params.arguments, { signal: extra?.signal });
});

export { toolDefinitions as TOOL_DEFS };
export { WEB_SEARCH_INSTRUCTIONS as instructions };

export { handleToolCall };
export async function start() {
  await writeStartupSnapshot();
}
export async function stop() {
  flushUsageState();
  flushCacheState();
  await closeScrapeBrowserPool();
}
