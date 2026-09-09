import fs from 'fs'

import { isWSL } from '../../shared/wsl.mjs'
import { startChildGuardian } from '../../shared/child-guardian.mjs'
import {
  normalizeUrl,
  assertPublicUrl,
} from './ssrf-guard.mjs'
import {
  buildHeaders,
  MAX_BODY_BYTES,
  fetchPinnedForPausedRequest,
  fetchDocument,
  assertDocumentResponse,
  _metaRefreshTarget,
} from './http-fetch.mjs'
import { extractDocument } from './document-content.mjs'
import { abortable, runFetchPipeline } from './fetch-pipeline.mjs'

// Facade re-exports: SSRF-guard and HTTP-fetch clusters moved to dedicated
// modules; keep the original public surface resolving unchanged for importers.
export {
  assertPublicUrl,
  resolveAndValidate,
  assertResolvedIps,
  pinnedFetch,
} from './ssrf-guard.mjs'
export { isFatalHttpPathPolicyError } from './http-fetch.mjs'

// Browser automation is loaded only when the HTTP path needs rendering.
let _puppeteer = null
async function loadPuppeteer() {
  if (!_puppeteer) _puppeteer = (await import('puppeteer-core')).default
  return _puppeteer
}
import {
  noteProviderFailure,
  noteProviderSuccess,
  classifyProviderError,
} from './state.mjs'

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

async function scrapeWithReadability(url, timeoutMs, signal) {
  const redirects = []
  const session = {}
  let document = await fetchDocument(url, timeoutMs, signal, { session })
  for (let hop = 0; ; hop++) {
    redirects.push(...document.redirects)
    const html = /(?:text\/html|application\/xhtml\+xml)/i.test(document.contentType)
    const target = html ? _metaRefreshTarget(document.body, document.url) : null
    if (!target) break
    if (hop >= 3) throw new Error('Too many redirects (meta refresh)')
    redirects.push({ url: document.url, location: target, status: 'meta-refresh' })
    document = await fetchDocument(target, timeoutMs, signal, { session })
  }
  return { ...(await extractDocument(document.url, document.body, document.contentType)), httpStatus: document.status, redirects }
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

async function _acquirePoolSlot(signal) {
  const abortError = () => signal?.reason || new Error('aborted')
  // Waiting for a pool slot used to be uncancellable: an aborted tool call kept
  // queueing until a slot freed, then launched a page nobody was waiting for.
  while (_poolActive >= PUPPETEER_POOL_MAX_PAGES) {
    if (signal?.aborted) throw abortError()
    await new Promise((resolve, reject) => {
      let onAbort = null
      const waiter = () => {
        if (onAbort) signal.removeEventListener('abort', onAbort)
        resolve()
      }
      if (signal) {
        onAbort = () => {
          const index = _poolWaiters.indexOf(waiter)
          if (index >= 0) _poolWaiters.splice(index, 1)
          reject(abortError())
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      _poolWaiters.push(waiter)
    })
  }
  if (signal?.aborted) {
    // Woken but cancelled: pass the wake-up on so a live waiter isn't stranded.
    _notifyPoolWaiter()
    throw abortError()
  }
  _poolActive++
  _poolLastActivity = Date.now()
  if (_poolIdleTimer) {
    clearTimeout(_poolIdleTimer)
    _poolIdleTimer = null
  }
}

function schedulePoolIdleClose() {
  if (_poolIdleTimer) clearTimeout(_poolIdleTimer)
  if (_poolActive === 0 && _poolBrowser) {
    _poolIdleTimer = setTimeout(() => {
      if (_poolActive === 0 && _poolBrowser) {
        const b = _poolBrowser
        _poolBrowser = null
        closeBrowserBounded(b).catch(() => {})
      }
    }, PUPPETEER_POOL_IDLE_MS)
    _poolIdleTimer.unref?.()
  }
}

function _releasePoolSlot() {
  _poolActive = Math.max(0, _poolActive - 1)
  _poolLastActivity = Date.now()
  _notifyPoolWaiter()
  schedulePoolIdleClose()
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
        schedulePoolIdleClose()
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
  const { frameTree } = await cdp.send('Page.getFrameTree')
  const gate = { documentError: null }
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
        const reqHeaders = new Headers(buildHeaders())
        if (Array.isArray(request.headers)) {
          for (const entry of request.headers) {
            if (entry?.name) reqHeaders.set(entry.name, entry.value ?? '')
          }
        } else if (request.headers && typeof request.headers === 'object') {
          for (const [name, value] of Object.entries(request.headers)) {
            reqHeaders.set(name, value)
          }
        }
        const fetchOpts = {
          signal,
          method: request.method || 'GET',
          headers: Object.fromEntries(reqHeaders),
        }
        if (request.postData) fetchOpts.body = request.postData
        const result = await fetchPinnedForPausedRequest(reqUrl, fetchOpts)
        await cdp.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: result.status,
          responseHeaders: result.responseHeaders,
          body: result.body.toString('base64'),
        })
      } catch (error) {
        if (event.resourceType === 'Document' && event.frameId === frameTree.frame.id) gate.documentError = error
        try {
          await cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' })
        } catch {}
      }
    })()
  })
  return gate
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

export async function closeScrapeBrowserPool() {
  if (_poolIdleTimer) clearTimeout(_poolIdleTimer)
  _poolIdleTimer = null
  const browser = _poolBrowser
  _poolBrowser = null
  await closeBrowserBounded(browser)
}

async function withPuppeteerPage(signal, fn) {
  await _acquirePoolSlot(signal)
  let browser
  let context
  let page
  let cdp
  let onExternalAbort
  try {
    try {
      browser = await abortable(_getPoolBrowser(), signal)
    } catch (error) {
      throw new Error(`puppeteer launch failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (signal?.aborted) throw signal.reason || new Error('aborted')
    if (signal) {
      // Tear down THIS call's page/context only. The browser is pooled and
      // shared with every concurrent scrape, so closing it here killed
      // unrelated in-flight pages.
      onExternalAbort = () => {
        try { void page?.close()?.catch?.(() => {}) } catch {}
        try { void context?.close()?.catch?.(() => {}) } catch {}
      }
      signal.addEventListener('abort', onExternalAbort, { once: true })
    }
    // Creation is multi-step and awaits between each step: without a checkpoint
    // per step an abort landing mid-setup was lost and the page ran anyway.
    // (The finally below closes whatever was created by then.)
    context = await browser.createBrowserContext()
    if (signal?.aborted) throw signal.reason || new Error('aborted')
    page = await context.newPage()
    if (signal?.aborted) throw signal.reason || new Error('aborted')
    cdp = await page.createCDPSession()
    if (signal?.aborted) throw signal.reason || new Error('aborted')
    await page.setBypassServiceWorker(true)
    const gate = await installPuppeteerSsrfGate(page, cdp, signal)
    if (signal?.aborted) throw signal.reason || new Error('aborted')
    try { return await fn(page) }
    catch (error) { throw gate.documentError || error }
  } finally {
    if (onExternalAbort && signal) signal.removeEventListener('abort', onExternalAbort)
    try {
      await abortable(Promise.allSettled([page?.close(), context?.close()]), AbortSignal.timeout(2000))
    } catch {}
    _releasePoolSlot()
  }
}

async function scrapeWithPuppeteer(url, timeoutMs, signal) {
  return withPuppeteerPage(signal, async (page) => {
    const resp = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    })
    if (!resp) throw new Error('Browser navigation returned no HTTP response')
    assertDocumentResponse(resp.status(), new Headers(resp.headers()), page.url())
    // Wait for useful DOM content, not analytics or long-lived connections.
    try {
      await page.waitForFunction(() => {
        const text = (document.querySelector('main,[role="main"],article') || document.body)?.innerText?.trim() || ''
        return Boolean(text)
      }, { timeout: Math.min(5000, Math.max(1, timeoutMs / 3)), polling: 100 })
    } catch (error) {
      signal?.throwIfAborted()
      if (error.name !== 'TimeoutError') throw error
    }
    try {
      await page.waitForNetworkIdle({ idleTime: 400, concurrency: 2, timeout: Math.min(2500, Math.max(1, timeoutMs / 4)) })
    } catch (error) {
      signal?.throwIfAborted()
      if (error.name !== 'TimeoutError') throw error
    }
    const finalUrl = page.url()
    assertPublicUrl(finalUrl)
    const html = await page.content()
    const htmlBytes = Buffer.byteLength(html, 'utf8')
    if (htmlBytes > MAX_BODY_BYTES) {
      throw new Error(`puppeteer page content too large: ${htmlBytes} bytes > cap=${MAX_BODY_BYTES}`)
    }
    return {
      ...(await extractDocument(finalUrl, html, 'text/html')),
      extractor: 'puppeteer',
      httpStatus: resp.status(),
    }
  })
}

async function scrapeUrl(url, timeoutMs, usageState, signal) {
  const normalizedUrl = normalizeUrl(url)
  return runFetchPipeline(normalizedUrl, {
    timeoutMs, signal,
    http: (budget, abort) => scrapeWithReadability(normalizedUrl, budget, abort),
    browser: (budget, abort) => scrapeWithPuppeteer(normalizedUrl, budget, abort),
    onAttempt(stage, error) {
      if (!usageState) return
      const provider = stage === 'http' ? 'readability' : stage
      if (!error) noteProviderSuccess(usageState, provider)
      else noteProviderFailure(usageState, provider, error.message, classifyProviderError(error), { siteScoped: true })
    },
  })
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
      errorCode: result.reason?.code || 'FETCH_FAILED',
      failures: result.reason?.failures || [],
      attempts: result.reason?.attempts || [],
    }
  })
}
