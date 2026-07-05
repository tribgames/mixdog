import { readFileSync } from 'fs'

import {
  assertPublicUrl,
  pinnedFetch,
} from './ssrf-guard.mjs'

const PKG_VERSION = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version } catch { return '0.0.1' } })()

export function withTimeout(controller, timeoutMs) {
  return setTimeout(() => controller.abort(), timeoutMs)
}

export function buildHeaders() {
  return {
    'User-Agent': `mixdog-search/${PKG_VERSION}`,
  }
}

export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
export const MAX_REDIRECTS = 5
// Hard cap on response body size (10 MB) to prevent memory DoS from a
// hostile / misconfigured URL returning a huge body. Applied in two places:
//   1. Content-Length pre-check (cheap reject before reading bytes).
//   2. Streaming byte counter (covers chunked transfer / missing header).
export const MAX_BODY_BYTES = 10 * 1024 * 1024

/** HTTP-path policy failures must not fall through to the Puppeteer extractor. */
export function isFatalHttpPathPolicyError(error) {
  const msg = error instanceof Error ? error.message : String(error)
  if (/response body too large|page content too large|Content-Length=.*> cap=/i.test(msg)) return true
  if (/Blocked non-text content-type/i.test(msg)) return true
  if (/cross-host redirect blocked/i.test(msg)) return true
  if (/Blocked request to private|Blocked non-HTTP|Blocked URL with userinfo/i.test(msg)) return true
  if (/DNS returned no addresses/i.test(msg)) return true
  if (/Too many redirects/i.test(msg)) return true
  return false
}

export async function readBodyWithCap(response, maxBytes) {
  // Reject non-text content-types early; decode by content-type charset.
  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  if (contentType) {
    const isText = contentType.includes('text/') || contentType.includes('/html') ||
      contentType.includes('/xml') || contentType.includes('/json') ||
      contentType.includes('javascript') || contentType.includes('application/x-www-form-urlencoded')
    if (!isText) {
      // Cancel body before throwing so the underlying socket isn't held
      // until GC — fetchHtml's caller would otherwise leak the connection.
      try { await response.body?.cancel() } catch {}
      throw new Error(`Blocked non-text content-type: ${contentType.split(';')[0].trim()}`)
    }
  }
  const charsetMatch = contentType.match(/charset=([\w-]+)/i)
  const charset = charsetMatch ? charsetMatch[1] : 'utf-8'

  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > maxBytes) {
    try { await response.body?.cancel() } catch {}
    throw new Error(`response body too large: Content-Length=${contentLength} > cap=${maxBytes}`)
  }
  const reader = response.body?.getReader?.()
  if (!reader) {
    // Fallback for environments without a readable stream — post-check length.
    const text = await response.text()
    if (text.length > maxBytes) {
      // response.text() already drained the body, but guard symmetrically.
      try { await response.body?.cancel() } catch {}
      throw new Error(`response body too large: ${text.length} bytes > cap=${maxBytes}`)
    }
    return text
  }
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        try { await reader.cancel() } catch {}
        throw new Error(`response body too large: received ${total}+ bytes > cap=${maxBytes}`)
      }
      chunks.push(value)
    }
  } finally {
    try { reader.releaseLock() } catch {}
  }
  const decoder = new TextDecoder(charset, { fatal: false })
  let text = ''
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true })
  text += decoder.decode()
  return text
}

/** Binary-safe body reader for CDP Fetch fulfillment (no text-only filter). */
export async function readBodyBytesWithCap(response, maxBytes) {
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > maxBytes) {
    try { await response.body?.cancel() } catch {}
    throw new Error(`response body too large: Content-Length=${contentLength} > cap=${maxBytes}`)
  }
  const reader = response.body?.getReader?.()
  if (!reader) {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.byteLength > maxBytes) {
      try { await response.body?.cancel() } catch {}
      throw new Error(`response body too large: ${buf.byteLength} bytes > cap=${maxBytes}`)
    }
    return buf
  }
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        try { await reader.cancel() } catch {}
        throw new Error(`response body too large: received ${total}+ bytes > cap=${maxBytes}`)
      }
      chunks.push(value)
    }
  } finally {
    try { reader.releaseLock() } catch {}
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)))
}

const CDP_FORBIDDEN_RESPONSE_HEADERS = new Set([
  'content-length',
  'transfer-encoding',
  // undici decodes gzip/br/deflate; body passed to fulfillRequest is plain bytes
  'content-encoding',
])

export function headersToCdpPairs(headers) {
  const out = []
  headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (CDP_FORBIDDEN_RESPONSE_HEADERS.has(lower)) return
    out.push({ name, value })
  })
  return out
}

/**
 * Pinned fetch for a paused Chromium request: validate each hop, follow redirects,
 * return bytes for Fetch.fulfillRequest. Chromium never performs its own DNS/connect.
 */
export async function fetchPinnedForPausedRequest(url, { signal, method = 'GET', headers = {}, body } = {}) {
  const upperMethod = (method || 'GET').toUpperCase()
  let currentUrl = url
  for (let hops = 0; ; hops++) {
    assertPublicUrl(currentUrl)
    const response = await pinnedFetch(currentUrl, {
      signal,
      method: upperMethod,
      headers,
      body: hops === 0 ? body : undefined,
      redirect: 'manual',
    })
    if (REDIRECT_STATUSES.has(response.status)) {
      try { await response.body?.cancel() } catch {}
      if (hops >= MAX_REDIRECTS) {
        throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`)
      }
      const location = response.headers.get('location')
      if (!location) {
        throw new Error(`Redirect ${response.status} without Location header`)
      }
      currentUrl = new URL(location, currentUrl).toString()
      continue
    }
    const respBody = await readBodyBytesWithCap(response, MAX_BODY_BYTES)
    return {
      status: response.status,
      responseHeaders: headersToCdpPairs(response.headers),
      body: respBody,
    }
  }
}

export async function fetchHtml(url, timeoutMs, signal) {
  const controller = new AbortController()
  const timer = withTimeout(controller, timeoutMs)
  // Propagate an external (tool-call) abort into the local timeout controller
  // so a cancelled web_fetch tears down the in-flight request promptly.
  let onExternalAbort
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else {
      onExternalAbort = () => controller.abort(signal.reason)
      signal.addEventListener('abort', onExternalAbort, { once: true })
    }
  }
  const originalHost = new URL(url).hostname.replace(/^www\./, '')
  try {
    let currentUrl = url
    for (let hops = 0; ; hops++) {
      // pinnedFetch resolves+validates the host once and forces the
      // connection to the validated IP — closes the validate-then-fetch
      // TOCTOU / DNS-rebinding window that bare `fetch` left open.
      const response = await pinnedFetch(currentUrl, {
        signal: controller.signal,
        headers: buildHeaders(),
        redirect: 'manual',
      })
      if (REDIRECT_STATUSES.has(response.status)) {
        // Drain the redirect response body so the socket isn't held until GC.
        try { await response.body?.cancel() } catch {}
        if (hops >= MAX_REDIRECTS) {
          throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`)
        }
        const location = response.headers.get('location')
        if (!location) {
          throw new Error(`Redirect ${response.status} without Location header`)
        }
        const nextUrl = new URL(location, currentUrl).toString()
        assertPublicUrl(nextUrl)
        const nextHost = new URL(nextUrl).hostname.replace(/^www\./, '')
        if (nextHost !== originalHost) {
          throw new Error(`cross-host redirect blocked (redirected_to: ${nextUrl})`)
        }
        currentUrl = nextUrl
        continue
      }
      if (!response.ok) {
        // Drain the error response body before propagating.
        try { await response.body?.cancel() } catch {}
        const err = new Error(`HTTP ${response.status}`)
        err.status = response.status
        throw err
      }
      return await readBodyWithCap(response, MAX_BODY_BYTES)
    }
  } finally {
    clearTimeout(timer)
    if (onExternalAbort) signal.removeEventListener('abort', onExternalAbort)
  }
}

// Parse a short-delay <meta http-equiv="refresh" content="N; url=..."> from
// the document head. Browsers treat these as redirects, but fetchHtml only
// follows HTTP-level (3xx) redirects — without this, a stub page like
// tree-sitter.github.io (tiny body + meta refresh) is returned as the
// "article". Long-delay refreshes (>5s) are page auto-reloads, not
// redirects, and are deliberately NOT followed.
export function _metaRefreshTarget(html, baseUrl) {
  const head = String(html || '').slice(0, 8192)
  const tags = head.match(/<meta\b[^>]*>/gi) || []
  for (const tag of tags) {
    if (!/http-equiv\s*=\s*["']?refresh\b/i.test(tag)) continue
    // Quote-aware capture: the attribute value may NEST the other quote kind
    // (content="0; url='...'"), so a combined ["'] char class would cut the
    // capture at the inner quote. Match each quote style to its own closer.
    const m = /content\s*=\s*"([^"]*)"/i.exec(tag)
      || /content\s*=\s*'([^']*)'/i.exec(tag)
      || /content\s*=\s*([^\s>]+)/i.exec(tag)
    if (!m) continue
    const cm = /^\s*(\d+(?:\.\d+)?)\s*[;,]\s*url\s*=\s*['"]?([^'"]+?)['"]?\s*$/i.exec(m[1])
    if (!cm) continue
    const delay = Number(cm[1])
    if (!Number.isFinite(delay) || delay > 5) continue
    try {
      const resolved = new URL(cm[2].trim(), baseUrl)
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue
      if (resolved.href === baseUrl) continue
      return resolved.href
    } catch { continue }
  }
  return null
}
