import fs from 'fs'

import { Readability } from '@mozilla/readability'
import { isWSL } from '../../shared/wsl.mjs'
import { startChildGuardian } from '../../shared/child-guardian.mjs'
import {
  normalizeUrl,
  assertPublicUrl,
  assertResolvedIps,
} from './ssrf-guard.mjs'
import {
  buildHeaders,
  MAX_BODY_BYTES,
  isFatalHttpPathPolicyError,
  fetchPinnedForPausedRequest,
  fetchHtml,
  _metaRefreshTarget,
} from './http-fetch.mjs'

// Facade re-exports: SSRF-guard and HTTP-fetch clusters moved to dedicated
// modules; keep the original public surface resolving unchanged for importers.
export {
  assertPublicUrl,
  resolveAndValidate,
  assertResolvedIps,
  pinnedFetch,
} from './ssrf-guard.mjs'
export { isFatalHttpPathPolicyError } from './http-fetch.mjs'

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

async function scrapeUrl(url, timeoutMs, usageState, signal) {
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

async function crawlSite(
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
