import fs, { readFileSync } from 'fs'
import dns from 'dns'
import net from 'net'
import { Agent, fetch as undiciFetch } from 'undici'

import { Readability } from '@mozilla/readability'
import { isWSL } from '../../shared/wsl.mjs'
import { startChildGuardian } from '../../shared/child-guardian.mjs'

// Lazy heavy deps: importing jsdom (~400ms) and puppeteer-core (~130ms) at
// module load added ~540ms to the first web search even when the request never
// scraped HTML. Load them on first actual use and cache the resolved binding so
// repeat calls pay nothing. The search runtime itself is already dynamically
// imported, so this keeps that first-use cost proportional to what the request
// truly needs (a plain fetch path touches neither).
let _JSDOM = null
async function loadJSDOM() {
  if (!_JSDOM) ({ JSDOM: _JSDOM } = await import('jsdom'))
  return _JSDOM
}
let _puppeteer = null
async function loadPuppeteer() {
  if (!_puppeteer) _puppeteer = (await import('puppeteer-core')).default
  return _puppeteer
}


const PKG_VERSION = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version } catch { return '0.0.1' } })()
import {
  noteProviderFailure,
  noteProviderSuccess,
  rankScrapeExtractors,
  classifyProviderError,
} from './state.mjs'

const DEFAULT_EXTRACTORS = ['readability', 'puppeteer']

const COMMON_BROWSER_PATHS = (() => {
  const platform = process.platform
  if (platform === 'win32') {
    // Derive install roots from the environment so non-C: installs and the
    // per-user %LOCALAPPDATA% Chrome install are covered. Fall back to the
    // canonical C: paths (well-known locations, not guessed defaults) when an
    // env var is unset.
    const localAppData = process.env.LOCALAPPDATA
    const programFiles = process.env.PROGRAMFILES || 'C:/Program Files'
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)'
    return [
      `${programFiles}/Google/Chrome/Application/chrome.exe`,
      `${programFilesX86}/Google/Chrome/Application/chrome.exe`,
      localAppData && `${localAppData}/Google/Chrome/Application/chrome.exe`,
      `${programFiles}/Microsoft/Edge/Application/msedge.exe`,
      `${programFilesX86}/Microsoft/Edge/Application/msedge.exe`,
      localAppData && `${localAppData}/Microsoft/Edge/Application/msedge.exe`,
    ].filter(Boolean)
  }
  if (platform === 'linux') {
    // Native-Linux Chromium/Chrome binaries first. The /mnt/c Windows .exe
    // entries are reachable from WSL's filesystem but puppeteer-core CANNOT
    // drive a Windows GUI browser as a Linux child process (CDP over a pipe to
    // a Win32 binary launched from the Linux ABI does not work), so advertising
    // puppeteer-available off a Windows .exe yields launch failures at runtime.
    // Only offer the Windows .exe fallbacks on plain Linux (Wine/dual-mount
    // edge cases), never under WSL.
    const linuxNative = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/microsoft-edge',
    ]
    if (isWSL()) return linuxNative
    return [
      ...linuxNative,
      '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
      '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
      '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ]
  }
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ]
})()

export function getScrapeCapabilities() {
  const browserAvailable = Boolean(
    (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) ||
    COMMON_BROWSER_PATHS.some(item => fs.existsSync(item)),
  )

  return {
    readability: true,
    puppeteer: browserAvailable,
  }
}

function normalizeUrl(url) {
  const parsed = new URL(url)
  parsed.hash = ''
  return parsed.toString()
}

function assertPrivateIpv4(hostname) {
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!ipv4Match) return
  const [, a, b] = ipv4Match.map(Number)
  if (a === 127 || a === 10 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && b >= 18 && b <= 19) ||
      (a >= 224 && a <= 239) ||
      (a >= 240)) {
    throw new Error(`Blocked request to private address: ${hostname}`)
  }
}

// Detect IPv4-mapped IPv6 (::ffff:/96) in BOTH dotted and hex forms and
// return the embedded IPv4 as a dotted-quad string, or null when the input
// is not an IPv4-mapped address. WHATWG URL canonicalises `[::ffff:127.0.0.1]`
// to `[::ffff:7f00:1]`, so the hex form must be handled or assertPublicUrl /
// _validateIpv6 will miss mapped loopback / private addresses.
function _mappedIpv4FromIpv6(bare) {
  const lower = bare.toLowerCase()
  // Dotted form: ::ffff:a.b.c.d
  const dotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (dotted) return dotted[1]
  // Hex form: ::ffff:HHHH:LLLL — low 32 bits of the /96 prefix carry the IPv4.
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const high = parseInt(hex[1], 16)
    const low = parseInt(hex[2], 16)
    if (Number.isFinite(high) && Number.isFinite(low) && high <= 0xffff && low <= 0xffff) {
      const a = (high >> 8) & 0xff
      const b = high & 0xff
      const c = (low >> 8) & 0xff
      const d = low & 0xff
      return `${a}.${b}.${c}.${d}`
    }
  }
  return null
}

export function assertPublicUrl(url) {
  const parsed = new URL(url)

  // Block dangerous protocols
  const blockedProtocols = ['file:', 'ftp:', 'data:', 'javascript:']
  if (blockedProtocols.includes(parsed.protocol)) {
    throw new Error(`Blocked non-HTTP protocol: ${parsed.protocol}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked non-HTTP protocol: ${parsed.protocol}`)
  }

  const hostname = parsed.hostname.toLowerCase()

  // Reject userinfo (user:pass@host) — credential-injection / SSRF vector
  if (parsed.username || parsed.password) {
    throw new Error(`Blocked URL with userinfo credentials: ${hostname}`)
  }

  // Localhost
  if (hostname === 'localhost') {
    throw new Error(`Blocked request to private address: ${hostname}`)
  }

  // IPv4 private/reserved ranges
  assertPrivateIpv4(hostname)

  // Strip brackets for IPv6 analysis (URL parser stores IPv6 without brackets in .hostname)
  const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname

  // IPv6 loopback
  if (bare === '::1') {
    throw new Error(`Blocked request to private address: ${hostname}`)
  }

  // IPv6 unspecified (::)
  if (bare === '::') {
    throw new Error(`Blocked request to private address: ${hostname}`)
  }

  // IPv6 multicast (ff00::/8)
  if (/^ff/i.test(bare)) {
    throw new Error(`Blocked request to private address: ${hostname}`)
  }

  // IPv4-mapped IPv6 — ::ffff:a.b.c.d
  // Cover both dotted (::ffff:127.0.0.1) and hex (::ffff:7f00:1) forms —
  // WHATWG URL canonicalises bracketed mapped literals to the hex shape.
  const mappedIpv4 = _mappedIpv4FromIpv6(bare)
  if (mappedIpv4) {
    assertPrivateIpv4(mappedIpv4)
  }

  // IPv6 private (fc00::/7 — starts with fc or fd)
  if (/^f[cd]/i.test(bare)) {
    throw new Error(`Blocked request to private address: ${hostname}`)
  }

  // IPv6 link-local (fe80::/10 — starts with fe8, fe9, fea, feb)
  if (/^fe[89ab]/i.test(bare)) {
    throw new Error(`Blocked request to private address: ${hostname}`)
  }
}

function _validateIpv6(ip) {
  const lower = ip.toLowerCase()
  if (lower === '::1') {
    throw new Error(`Blocked request to private address: ${ip}`)
  }
  if (lower === '::') {
    throw new Error(`Blocked request to private address: ${ip}`)
  }
  if (/^ff/i.test(lower)) {
    throw new Error(`Blocked request to private address: ${ip}`)
  }
  if (/^f[cd]/i.test(lower)) {
    throw new Error(`Blocked request to private address: ${ip}`)
  }
  if (/^fe[89ab]/i.test(lower)) {
    throw new Error(`Blocked request to private address: ${ip}`)
  }
  // Cover both dotted and hex IPv4-mapped IPv6 forms — resolver output and
  // WHATWG-canonicalised URL hostnames may arrive as `::ffff:7f00:1`.
  const mappedIpv4 = _mappedIpv4FromIpv6(lower)
  if (mappedIpv4) {
    assertPrivateIpv4(mappedIpv4)
  }
}

// Resolve hostname once, validate EVERY returned address (so a DNS round-robin
// can't smuggle a private IP behind a public one), and return the de-duped
// `{address, family}` list. The caller pins the real connection to one of
// these addresses so a second uncontrolled resolution (DNS rebinding / TOCTOU)
// cannot flip the IP between validation and connect.
// Race a DNS promise against an abort signal so a hung resolver cannot
// outlive the request's timeout budget. The signal is the same one that
// bounds the outbound fetch (AbortSignal.timeout / requestTimeoutMs), so
// DNS is bounded by the same deadline as the connection.
function _abortRace(promise, signal, label) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason || new Error(`${label} aborted`))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error(`${label} aborted`))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err) },
    )
  })
}

export async function resolveAndValidate(hostname, { signal } = {}) {
  // Literal IPs bypass DNS entirely — validate directly.
  if (net.isIP(hostname)) {
    if (net.isIPv4(hostname)) {
      assertPrivateIpv4(hostname)
      return [{ address: hostname, family: 4 }]
    }
    _validateIpv6(hostname)
    return [{ address: hostname, family: 6 }]
  }

  const addresses = []
  const seen = new Set()
  const push = (address, family) => {
    const key = `${family}:${address}`
    if (seen.has(key)) return
    seen.add(key)
    addresses.push({ address, family })
  }

  // dns.lookup mirrors what the platform resolver will hand to the connector;
  // resolve4/resolve6 catch entries the stub resolver returns even when the
  // OS lookup table would omit them.
  let lookupAddrs = []
  try {
    lookupAddrs = await _abortRace(dns.promises.lookup(hostname, { all: true }), signal, 'dns.lookup')
  } catch (err) {
    if (err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') throw err
  }
  for (const entry of lookupAddrs) {
    if (entry.family === 4) assertPrivateIpv4(entry.address)
    else _validateIpv6(entry.address)
    push(entry.address, entry.family)
  }

  let v4Addrs = []
  try {
    v4Addrs = await _abortRace(dns.promises.resolve4(hostname), signal, 'dns.resolve4')
  } catch (err) {
    if (err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') throw err
  }
  for (const ip of v4Addrs) {
    assertPrivateIpv4(ip)
    push(ip, 4)
  }

  let v6Addrs = []
  try {
    v6Addrs = await _abortRace(dns.promises.resolve6(hostname), signal, 'dns.resolve6')
  } catch (err) {
    if (err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') throw err
  }
  for (const ip of v6Addrs) {
    _validateIpv6(ip)
    push(ip, 6)
  }

  return addresses
}

export async function assertResolvedIps(hostname) {
  // Backward-compatible wrapper: callers that only need validation (e.g. the
  // Puppeteer request interceptor, which cannot pin Chromium's connect) still
  // get the same throw-on-private behaviour.
  // Fail closed: an empty result (no DNS records, all lookups returned
  // ENODATA/ENOTFOUND) must NOT be treated as success — the Puppeteer path
  // would otherwise hand the raw hostname to Chromium for a second,
  // unvalidated resolution.
  // Callers pass `new URL(...).hostname`, which on Node/Bun keeps the
  // brackets around IPv6 literals (e.g. `[2606:4700::1111]`). Strip them
  // here so resolveAndValidate's net.isIP() path recognises the literal
  // instead of falling through to a doomed DNS lookup on `[..]`.
  const bare = _bareHost(hostname)
  const addresses = await resolveAndValidate(bare)
  if (!addresses || addresses.length === 0) {
    throw new Error(`DNS returned no addresses for ${hostname}`)
  }
}

// Bare hostname helper that strips IPv6 brackets — undici / WHATWG URL stores
// IPv6 hostnames with the brackets included.
function _bareHost(hostname) {
  return hostname.startsWith('[') ? hostname.slice(1, -1) : hostname
}

// SSRF-hardened fetch: resolves the host ONCE, validates every returned
// address, then connects to a single pre-validated IP via a per-request
// undici Agent whose `connect.lookup` returns that IP only. This closes the
// validate-then-fetch TOCTOU / DNS-rebinding window because the connector
// never performs a second resolution against the live DNS — the Host header
// (undici fills from the URL) and TLS SNI (likewise) are unaffected, so
// virtual hosts and HTTPS certificate validation keep working against
// legitimate public sites.
export async function pinnedFetch(url, options = {}) {
  const parsed = new URL(url)
  const host = _bareHost(parsed.hostname)
  // Bound the validating DNS lookups by the request's own abort signal so a
  // hung resolver cannot outlive the fetch timeout.
  const addresses = await resolveAndValidate(host, { signal: options.signal })
  if (addresses.length === 0) {
    throw new Error(`DNS returned no addresses for ${host}`)
  }
  // Deterministic: pin to the first validated address. Every entry in
  // `addresses` already passed assertPrivateIpv4 / IPv6 checks, so picking any
  // index is safe — first-match keeps behaviour stable across calls.
  const pinned = addresses[0]
  const dispatcher = new Agent({
    connect: {
      // Custom lookup invoked by undici's connector. We ignore the requested
      // hostname argument and unconditionally hand back the pre-validated IP,
      // so DNS rebinding cannot flip the address between assert and connect.
      lookup: (_hostname, opts, cb) => {
        if (opts && opts.all) {
          cb(null, [{ address: pinned.address, family: pinned.family }])
        } else {
          cb(null, pinned.address, pinned.family)
        }
      },
    },
  })
  // The per-request Agent owns a dedicated connection pool. If it is never
  // closed it leaks the kept-alive socket until GC. Destroy it once the body
  // is fully consumed, cancelled, or the request errors — wrapping the body
  // stream so the dispatcher outlives streaming reads but is always reclaimed.
  let response
  try {
    response = await undiciFetch(url, { ...options, dispatcher })
  } catch (err) {
    dispatcher.destroy().catch(() => {})
    throw err
  }
  let cleaned = false
  const cleanup = () => { if (!cleaned) { cleaned = true; dispatcher.destroy().catch(() => {}) } }
  // If there's no body to stream, the response is already complete.
  if (!response.body) {
    cleanup()
    return response
  }
  // Wrap the body in a ReadableStream that pulls from the original reader and
  // destroys the dispatcher when the stream ends, errors, or the consumer
  // cancels it. ReadableStream's underlying-source pull/cancel callbacks are
  // reliably invoked, so the per-request Agent is always reclaimed instead of
  // leaking its kept-alive socket until GC.
  const reader = response.body.getReader()
  const monitored = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          cleanup()
          return
        }
        controller.enqueue(value)
      } catch (err) {
        controller.error(err)
        cleanup()
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {})
      cleanup()
    },
  })
  return new Response(monitored, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function withTimeout(controller, timeoutMs) {
  return setTimeout(() => controller.abort(), timeoutMs)
}

function buildHeaders() {
  return {
    'User-Agent': `mixdog-search/${PKG_VERSION}`,
  }
}

function buildContentPayload(url, title, content, extractor, extra = {}) {
  // Whitespace-normalize extracted text so blank-line runs from page layout
  // don't eat the caller's maxLength window. Per-line interior spacing is
  // preserved (code blocks / <pre> stay intact) — only trailing spaces and
  // 3+ consecutive newlines are collapsed.
  const normalized = (content || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!normalized) {
    throw new Error(`${extractor} returned empty content`)
  }
  return {
    url,
    title: (title || '').trim(),
    content: normalized,
    excerpt: normalized.slice(0, 240),
    extractor,
    ...extra,
  }
}

function collapseTextForDetection(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function isKnownJavascriptGateUrl(url) {
  try {
    const parsed = new URL(String(url || ''))
    const path = `${parsed.pathname}${parsed.search}`.toLowerCase()
    return path.includes('/httpservice/retry/enablejs') || path.includes('enablejs')
  } catch {
    return false
  }
}

function classifyJavascriptRenderingPlaceholder(page) {
  if (!page || typeof page !== 'object') return null
  if (isKnownJavascriptGateUrl(page.url)) return 'javascript-required placeholder URL'

  const title = collapseTextForDetection(page.title)
  const content = collapseTextForDetection(page.content)
  const sample = `${title}\n${content}`.slice(0, 5000)
  if (!/javascript/i.test(sample)) return null

  const strongPlaceholder = [
    /you need to enable javascript to run this app/i,
    /please enable javascript/i,
    /(?:enable|turn on) javascript/i,
    /javascript\s+(?:is\s+)?(?:disabled|required)/i,
    /javascript\s+must\s+be\s+enabled/i,
    /requires? javascript/i,
  ].some(pattern => pattern.test(sample))
  const browserInstructionNames = ['chrome', 'edge', 'firefox', 'safari', 'opera']
    .filter(name => new RegExp(`\\b${name}\\b`, 'i').test(sample))
    .length
  if (!strongPlaceholder && browserInstructionNames < 3) return null

  // A long article can legitimately discuss JavaScript requirements. Only
  // auto-render compact placeholder/shell pages, plus the canonical React app
  // shell phrase regardless of surrounding boilerplate.
  if (content.length <= 4000 || /you need to enable javascript to run this app/i.test(sample)) {
    return 'javascript-required placeholder content'
  }
  return null
}

async function extractReadableArticle(url, html) {
  const JSDOM = await loadJSDOM()
  const dom = new JSDOM(html, { url })
  try {
    const doc = dom.window.document
    // <head> social/preview images: Readability + textContent strip every tag,
    // so og:image / twitter:image never survive text extraction. Capture them
    // here and prepend as labelled lines so callers get the image URL without a
    // second (native) fetch — closes the readability-drops-meta gap.
    const metaImg = (sel) => doc.querySelector(sel)?.getAttribute('content')?.trim() || ''
    const ogImage = metaImg('meta[property="og:image"]') || metaImg('meta[name="og:image"]') || metaImg('meta[property="og:image:url"]')
    const twImage = metaImg('meta[name="twitter:image"]') || metaImg('meta[property="twitter:image"]') || metaImg('meta[name="twitter:image:src"]')
    const _imgLines = []
    if (ogImage) _imgLines.push(`og:image: ${ogImage}`)
    if (twImage && twImage !== ogImage) _imgLines.push(`twitter:image: ${twImage}`)
    const imgPrefix = _imgLines.length ? `${_imgLines.join('\n')}\n\n` : ''
    const reader = new Readability(doc)
    const article = reader.parse()
    if (article?.textContent?.trim()) {
      return buildContentPayload(
        url,
        article.title || doc.title || '',
        imgPrefix + article.textContent,
        'readability',
      )
    }

    // Readability failed to find an article; fall back to the raw body text.
    // body.textContent concatenates script/style/template content and chrome
    // (nav/header/footer/aside) verbatim, which floods the result with noise.
    // Drop those non-content elements first so the fallback yields readable
    // prose rather than inlined JS/CSS and boilerplate.
    const body = dom.window.document.body
    let bodyText = ''
    if (body) {
      for (const node of body.querySelectorAll('script, style, noscript, template, nav, header, footer, aside, [hidden], [aria-hidden="true"]')) {
        node.remove()
      }
      bodyText = body.textContent?.trim() || ''
    }
    if (!bodyText) {
      throw new Error('readability returned no readable body')
    }

    return buildContentPayload(
      url,
      doc.title || '',
      imgPrefix + bodyText,
      'dom-text',
    )
  } finally {
    dom.window.close()
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5
// Hard cap on response body size (10 MB) to prevent memory DoS from a
// hostile / misconfigured URL returning a huge body. Applied in two places:
//   1. Content-Length pre-check (cheap reject before reading bytes).
//   2. Streaming byte counter (covers chunked transfer / missing header).
const MAX_BODY_BYTES = 10 * 1024 * 1024

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

async function readBodyWithCap(response, maxBytes) {
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
async function readBodyBytesWithCap(response, maxBytes) {
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

function headersToCdpPairs(headers) {
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
async function fetchPinnedForPausedRequest(url, { signal, method = 'GET', headers = {}, body } = {}) {
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
    const body = await readBodyBytesWithCap(response, MAX_BODY_BYTES)
    return {
      status: response.status,
      responseHeaders: headersToCdpPairs(response.headers),
      body,
    }
  }
}

async function fetchHtml(url, timeoutMs, signal) {
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
function _metaRefreshTarget(html, baseUrl) {
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

async function scrapeWithReadability(url, timeoutMs, signal) {
  let currentUrl = url
  let html = await fetchHtml(currentUrl, timeoutMs, signal)
  // Bounded meta-refresh chase: each hop re-enters fetchHtml, so the
  // SSRF/public-URL validation applies to every target.
  for (let hop = 0; hop < 3; hop += 1) {
    const target = _metaRefreshTarget(html, currentUrl)
    if (!target) break
    currentUrl = target
    html = await fetchHtml(currentUrl, timeoutMs, signal)
  }
  return await extractReadableArticle(currentUrl, html)
}

function resolveBrowserLaunchOptions() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
  }

  for (const executablePath of COMMON_BROWSER_PATHS) {
    if (fs.existsSync(executablePath)) {
      return { executablePath }
    }
  }

  return { channel: 'chrome' }
}

function puppeteerNoSandboxEnabled() {
  const raw = (process.env.PUPPETEER_NO_SANDBOX || process.env.MIXDOG_PUPPETEER_NO_SANDBOX || '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

function buildPuppeteerLaunchArgs() {
  const args = ['--disable-dev-shm-usage']
  if (puppeteerNoSandboxEnabled()) args.push('--no-sandbox')
  return args
}

const PUPPETEER_POOL_MAX_PAGES = Math.max(1, Number(process.env.PUPPETEER_POOL_MAX_PAGES) || 3)
const PUPPETEER_POOL_IDLE_MS = Math.max(5_000, Number(process.env.PUPPETEER_POOL_IDLE_MS) || 60_000)

let _poolBrowser = null
let _poolLaunching = null
let _poolActive = 0
let _poolLastActivity = Date.now()
let _poolIdleTimer = null
const _poolWaiters = []

function _notifyPoolWaiter() {
  const next = _poolWaiters.shift()
  if (next) next()
}

async function _acquirePoolSlot() {
  while (_poolActive >= PUPPETEER_POOL_MAX_PAGES) {
    await new Promise((resolve) => _poolWaiters.push(resolve))
  }
  _poolActive++
  _poolLastActivity = Date.now()
  if (_poolIdleTimer) {
    clearTimeout(_poolIdleTimer)
    _poolIdleTimer = null
  }
}

function _releasePoolSlot() {
  _poolActive = Math.max(0, _poolActive - 1)
  _poolLastActivity = Date.now()
  _notifyPoolWaiter()
  if (_poolActive === 0 && _poolBrowser) {
    _poolIdleTimer = setTimeout(() => {
      if (_poolActive === 0 && _poolBrowser) {
        const b = _poolBrowser
        _poolBrowser = null
        closeBrowserBounded(b).catch(() => {})
      }
    }, PUPPETEER_POOL_IDLE_MS)
  }
}

async function _getPoolBrowser() {
  if (_poolBrowser && _poolBrowser.isConnected?.() === false) {
    _poolBrowser = null
  }
  if (_poolBrowser) return _poolBrowser
  if (!_poolLaunching) {
    _poolLaunching = loadPuppeteer()
      .then((puppeteer) => puppeteer.launch({
        headless: true,
        ...resolveBrowserLaunchOptions(),
        args: buildPuppeteerLaunchArgs(),
      }))
      .then((browser) => {
        _poolBrowser = browser
        try {
          const proc = browser.process?.()
          startChildGuardian({ childPid: proc?.pid, label: 'puppeteer-browser' })
        } catch {}
        browser.on('disconnected', () => {
          if (_poolBrowser === browser) _poolBrowser = null
        })
        return browser
      })
      .finally(() => {
        _poolLaunching = null
      })
  }
  return _poolLaunching
}

// SSRF + DNS pin: CDP Fetch pauses every request; Node pinnedFetch connects to
// the validated IP and Fetch.fulfillRequest returns the body so Chromium never
// performs its own DNS for response bytes. Redirects and subresources each
// re-enter requestPaused and are validated again (fail-closed on block).
async function installPuppeteerSsrfGate(_page, cdp, signal) {
  await cdp.send('Fetch.enable', {
    handleAuthRequests: false,
    patterns: [{ urlPattern: '*', requestStage: 'Request' }],
  })
  cdp.on('Fetch.requestPaused', (event) => {
    void (async () => {
      const { requestId, request } = event
      try {
        const reqUrl = request?.url
        if (!reqUrl) {
          await cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' })
          return
        }
        const reqHeaders = { ...buildHeaders() }
        if (Array.isArray(request.headers)) {
          for (const entry of request.headers) {
            if (entry?.name) reqHeaders[entry.name] = entry.value ?? ''
          }
        } else if (request.headers && typeof request.headers === 'object') {
          for (const [name, value] of Object.entries(request.headers)) {
            reqHeaders[name] = value
          }
        }
        const fetchOpts = {
          signal,
          method: request.method || 'GET',
          headers: reqHeaders,
        }
        if (request.postData) fetchOpts.body = request.postData
        const result = await fetchPinnedForPausedRequest(reqUrl, fetchOpts)
        await cdp.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: result.status,
          responseHeaders: result.responseHeaders,
          body: result.body.toString('base64'),
        })
      } catch {
        try {
          await cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' })
        } catch {}
      }
    })()
  })
}

// Bounded browser teardown: browser.close() can hang if the Chromium process
// is wedged, which would leak the process and pin the timeout budget. Race the
// graceful close against a deadline and fall back to killing the OS process so
// the browser is always reclaimed.
async function closeBrowserBounded(browser, timeoutMs = 5000) {
  if (!browser) return
  let timer
  try {
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    try {
      const proc = browser.process?.()
      if (proc && proc.exitCode === null && !proc.killed) proc.kill('SIGKILL')
    } catch {}
  }
}

async function withPuppeteerPage(signal, fn) {
  await _acquirePoolSlot()
  let browser
  let context
  let page
  let cdp
  let onExternalAbort
  try {
    try {
      browser = await _getPoolBrowser()
    } catch (error) {
      throw new Error(`puppeteer launch failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (signal?.aborted) throw signal.reason || new Error('aborted')
    if (signal) {
      onExternalAbort = () => { closeBrowserBounded(browser) }
      signal.addEventListener('abort', onExternalAbort, { once: true })
    }
    context = await browser.createBrowserContext()
    page = await context.newPage()
    cdp = await page.createCDPSession()
    await installPuppeteerSsrfGate(page, cdp, signal)
    return await fn(page)
  } finally {
    if (onExternalAbort && signal) signal.removeEventListener('abort', onExternalAbort)
    try { await page?.close() } catch {}
    try { await context?.close() } catch {}
    _releasePoolSlot()
  }
}

async function scrapeWithPuppeteer(url, timeoutMs, signal) {
  return withPuppeteerPage(signal, async (page) => {
    const resp = await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: timeoutMs,
    })
    if (!resp || !resp.ok()) {
      const status = resp?.status?.() ?? 'unknown'
      const err = new Error(`HTTP ${status}`)
      err.status = typeof status === 'number' ? status : undefined
      throw err
    }
    const finalUrl = page.url()
    assertPublicUrl(finalUrl)
    await assertResolvedIps(new URL(finalUrl).hostname)
    const html = await page.content()
    const htmlBytes = Buffer.byteLength(html, 'utf8')
    if (htmlBytes > MAX_BODY_BYTES) {
      throw new Error(`puppeteer page content too large: ${htmlBytes} bytes > cap=${MAX_BODY_BYTES}`)
    }
    try {
      return {
        ...(await extractReadableArticle(finalUrl, html)),
        extractor: 'puppeteer',
      }
    } catch {
      const bodyText = await page.evaluate(() => document.body?.innerText || '')
      return buildContentPayload(finalUrl, await page.title(), bodyText, 'puppeteer')
    }
  })
}

async function tryExtractor(extractor, url, timeoutMs, signal) {
  switch (extractor) {
    case 'readability':
      return scrapeWithReadability(url, timeoutMs, signal)
    case 'puppeteer':
      return scrapeWithPuppeteer(url, timeoutMs, signal)
    default:
      throw new Error(`Unknown extractor: ${extractor}`)
  }
}

function filterLinks(rawLinks, baseUrl, { limit = 50, sameDomainOnly = true, search }) {
  const originHost = new URL(baseUrl).host
  const items = []
  const seen = new Set()

  for (const rawLink of rawLinks) {
    const href = rawLink?.href
    if (!href) continue

    let absolute
    try {
      absolute = normalizeUrl(new URL(href, baseUrl).toString())
    } catch {
      continue
    }

    if (sameDomainOnly && new URL(absolute).host !== originHost) {
      continue
    }

    const text = (rawLink.text || '').trim()
    if (search && !absolute.includes(search) && !text.includes(search)) {
      continue
    }

    if (seen.has(absolute)) continue
    seen.add(absolute)
    items.push({ url: absolute, text })
    if (items.length >= limit) break
  }

  return items
}

async function extractLinksFromHtml(baseUrl, html, options) {
  const JSDOM = await loadJSDOM()
  const dom = new JSDOM(html, { url: baseUrl })
  try {
    const links = Array.from(dom.window.document.querySelectorAll('a[href]')).map(link => ({
      href: link.getAttribute('href'),
      text: link.textContent || '',
    }))
    return filterLinks(links, baseUrl, options)
  } finally {
    dom.window.close()
  }
}

async function mapWithHttp(url, options, timeoutMs, signal) {
  const html = await fetchHtml(url, timeoutMs, signal)
  return await extractLinksFromHtml(url, html, options)
}

async function mapWithPuppeteer(url, options, timeoutMs, signal) {
  return withPuppeteerPage(signal, async (page) => {
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: timeoutMs,
    })
    const finalUrl = page.url()
    assertPublicUrl(finalUrl)
    await assertResolvedIps(new URL(finalUrl).hostname)
    const links = await page.$$eval('a[href]', nodes => nodes.map(node => ({
      href: node.getAttribute('href'),
      text: node.textContent || '',
    })))
    return filterLinks(links, url, options)
  })
}

export async function scrapeUrl(url, timeoutMs, usageState, signal) {
  const normalizedUrl = normalizeUrl(url)
  const host = new URL(normalizedUrl).host
  const extractors = rankScrapeExtractors(host, usageState, DEFAULT_EXTRACTORS)
  const failures = []

  for (let i = 0; i < extractors.length; i += 1) {
    const extractor = extractors[i]
    if (extractor === 'puppeteer') {
      try {
        await fetchHtml(normalizedUrl, timeoutMs, signal)
      } catch (error) {
        if (isFatalHttpPathPolicyError(error)) {
          const message = error instanceof Error ? error.message : String(error)
          failures.push({ extractor: 'http-policy', error: message })
          const err = error instanceof Error ? error : new Error(message)
          err.failures = failures
          throw err
        }
      }
    }
    try {
      const page = await tryExtractor(extractor, normalizedUrl, timeoutMs, signal)
      const placeholderReason = classifyJavascriptRenderingPlaceholder(page)
      if (placeholderReason) {
        if (extractor !== 'puppeteer' && extractors.slice(i + 1).includes('puppeteer')) {
          failures.push({ extractor, error: `${placeholderReason}; retrying puppeteer` })
          continue
        }
        throw new Error(`${extractor} returned ${placeholderReason}`)
      }
      noteProviderSuccess(usageState, extractor)
      return {
        ...page,
        triedExtractors: extractors,
        failures,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push({ extractor, error: message })
      if (extractor === 'readability' && isFatalHttpPathPolicyError(error)) {
        const err = error instanceof Error ? error : new Error(message)
        err.failures = failures
        throw err
      }
      const errorKind = classifyProviderError(error)
      noteProviderFailure(usageState, extractor, message, errorKind)
    }
  }

  throw new Error(`All extractors failed for ${normalizedUrl}: ${failures.map(item => `${item.extractor}: ${item.error}`).join(' | ')}`)
}

export async function scrapeUrls(urls, timeoutMs, usageState, signal) {
  for (const url of urls) assertPublicUrl(url)
  const settled = await Promise.allSettled(urls.map(url => scrapeUrl(url, timeoutMs, usageState, signal)))
  return settled.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value
    }
    return {
      url: urls[index],
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    }
  })
}

async function mapSite(url, { limit = 50, sameDomainOnly = true, search }, timeoutMs, signal) {
  assertPublicUrl(url)
  const options = { limit, sameDomainOnly, search }
  try {
    const links = await mapWithHttp(url, options, timeoutMs, signal)
    if (links.length > 0) {
      return links
    }
  } catch (error) {
    if (isFatalHttpPathPolicyError(error)) throw error
  }

  return mapWithPuppeteer(url, options, timeoutMs, signal)
}

export async function crawlSite(
  startUrl,
  { maxPages = 10, maxDepth = 1, sameDomainOnly = true },
  timeoutMs,
  usageState,
  signal,
) {
  assertPublicUrl(startUrl)
  const visited = new Set()
  const queue = [{ url: normalizeUrl(startUrl), depth: 0 }]
  const pages = []

  while (queue.length > 0 && pages.length < maxPages) {
    const current = queue.shift()
    if (!current || visited.has(current.url)) continue
    visited.add(current.url)

    try {
      const page = await scrapeUrl(current.url, timeoutMs, usageState, signal)
      pages.push({
        url: current.url,
        depth: current.depth,
        title: page.title,
        excerpt: page.excerpt,
        extractor: page.extractor,
      })
    } catch (error) {
      pages.push({
        url: current.url,
        depth: current.depth,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    if (current.depth >= maxDepth) {
      continue
    }

    let links = []
    try {
      links = await mapSite(
        current.url,
        {
          limit: maxPages,
          sameDomainOnly,
        },
        timeoutMs,
        signal,
      )
    } catch {
      links = []
    }

    for (const link of links) {
      if (!visited.has(link.url)) {
        try {
          assertPublicUrl(link.url)
        } catch {
          continue
        }
        queue.push({
          url: link.url,
          depth: current.depth + 1,
        })
      }
    }
  }

  return pages
}
