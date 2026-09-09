/**
 * Response formatter — strips metadata, returns human-readable text.
 */

function formatWebSearchResults(data) {
  // data may be the full jsonText payload: { tool, providers, response, cache, ... }
  // response.results is the array we care about
  const response = data.response || data
  const results = response.results || []
  const answer = String(response.answer || '').trim()
  const warnings = Array.isArray(response.warnings) ? response.warnings : []

  if (!results.length && !answer) {
    return '(no search results)'
  }

  // Explicit display caps — callers that need full payload should use raw JSON output.
  const TITLE_CAP = 200
  const SNIPPET_CAP = 600
  const ANSWER_CAP = 4000
  const clip = (text, cap) => text.length > cap ? `${text.slice(0, cap)}…` : text
  const blocks = []
  if (warnings.length) blocks.push(`Warnings: ${warnings.join('; ')}`)
  if (answer) blocks.push(clip(answer, ANSWER_CAP))
  if (!results.length) return blocks.join('\n\n')
  blocks.push(results
    .map((r, i) => {
      const num = i + 1
      const title = clip(r.title || '(no title)', TITLE_CAP)
      const url = r.url || ''
      const date = r.publishedDate || ''
      const snippet = clip((r.snippet || '').trim(), SNIPPET_CAP)

      const urlPart = [url, date].filter(Boolean).join(' — ')
      const lines = [`${num}. ${title}`]
      if (urlPart) lines.push(`   ${urlPart}`)
      if (snippet) lines.push(`   ${snippet}`)
      return lines.join('\n')
    })
    .join('\n\n'))
  return blocks.join('\n\n')
}

function formatCrawl(data) {
  // data: { tool, pages: [{ url, depth, title, excerpt, extractor } | { url, depth, error }] }
  const pages = data.pages || []

  if (!pages.length) {
    return '(no crawl results)'
  }

  return pages
    .map(page => {
      const url = page.url || ''
      const title = page.title || ''
      const excerpt = (page.excerpt || '').trim()
      const error = page.error

      if (error) {
        return `[${url}]\n(failed)`
      }

      const header = title ? `[${title}] ${url}` : `[${url}]`
      return `${header}\n${excerpt || '(no content)'}`
    })
    .join('\n\n---\n\n')
}

const DEFAULT_FETCH_MAX_LENGTH = 50000

export function applyFetchPagination(payload, args) {
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

function fetchDiagnostics(item) {
  const lines = []
  if (item.errorCode) lines.push(`errorCode: ${item.errorCode}`)
  if (item.attempts?.length) {
    lines.push(`attempts: ${item.attempts.map(attempt =>
      `${attempt.stage}=${attempt.code || attempt.status}${Number.isFinite(attempt.elapsedMs) ? ` (${attempt.elapsedMs}ms)` : ''}`,
    ).join(' -> ')}`)
  }
  for (const failure of item.failures || []) {
    lines.push(`failure: ${failure.extractor}${failure.code ? ` [${failure.code}]` : ''}${failure.status ? ` HTTP ${failure.status}` : ''}: ${failure.error}`)
  }
  return lines
}

function formatFetch(data) {
  const results = data.results || []
  if (!results.length) return '(no fetch results)'
  const cappedNote = data.urlsTruncated ? `[fetched first ${results.length} of ${data.urlsTruncated} URLs; raise FETCH_URL_CAP for more]\n\n` : ''

  return cappedNote + results
    .map(item => {
      const url = item.url || ''
      const diagnostics = fetchDiagnostics(item)
      if (item.status === 'error' || item.error) {
        return [`[${url}]`, `(error: ${item.error || 'unknown error'})`, ...diagnostics].join('\n')
      }
      const meta = []
      if (Number.isFinite(item.bytes)) meta.push(`${item.bytes} bytes`)
      if (Number.isFinite(item.totalLength) && item.range) {
        meta.push(`range=${item.range.startIndex}..${item.range.endIndex}/${item.totalLength}`)
      }
      if (item.hasMore && item.nextStartIndex != null) {
        meta.push(`next startIndex=${item.nextStartIndex}`)
      }
      if (Number.isFinite(item.durationMs)) meta.push(`${item.durationMs}ms`)
      const header = `${url}${meta.length ? ` (${meta.join(', ')})` : ''}`
      const titleRaw = String(item.title || '').replace(/\s+/g, ' ').trim()
      const titleLine = titleRaw ? `title: ${titleRaw}` : ''
      const body = item.content == null ? '(no content)' : String(item.content)
      return [header, titleLine, ...diagnostics].filter(Boolean).join('\n') + '\n\n' + body
    })
    .join('\n\n---\n\n')
}

/**
 * Format a tool response into human-readable text.
 * @param {string} tool - Tool name (web_search, fetch, crawl)
 * @param {object} rawResult - The raw result object that was previously passed to jsonText()
 * @returns {string} Formatted text
 */
export function formatResponse(tool, rawResult) {
  switch (tool) {
    case 'web_search':
      return formatWebSearchResults(rawResult)
    case 'crawl':
      return formatCrawl(rawResult)
    case 'fetch':
      return formatFetch(rawResult)
    default:
      return JSON.stringify(rawResult, null, 2)
  }
}
