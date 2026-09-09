import test, { after, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as guard from './ssrf-guard.mjs'

const seen = []
let slowStarted
const slowReady = new Promise(resolve => { slowStarted = resolve })
const content = 'Rendered documentation includes the actual explanation, examples and configuration details needed to use this feature correctly.'
const html = (body, headers = {}) => new Response(body, { headers: { 'content-type': 'text/html', ...headers } })
const render = (text, extra = '') => `<title>Documentation</title><main id="root"></main>${extra}<script>
setTimeout(() => { document.getElementById('root').textContent = ${JSON.stringify(text)}; }, 250)
</script>`

mock.module(new URL('./ssrf-guard.mjs', import.meta.url).href, {
  namedExports: {
    ...guard,
    pinnedFetch: async (url, options = {}) => {
      const headers = new Headers(options.headers)
      const browser = !headers.get('user-agent')?.startsWith('mixdog-web-search/')
      const parsed = new URL(url)
      seen.push({ url, browser, cookie: headers.get('cookie') || '' })
      if (parsed.pathname === '/start') return new Response(null, {
        status: 302, headers: { location: '/bridge', 'set-cookie': 'visit=1; Secure; Path=/' },
      })
      if (parsed.pathname === '/bridge') {
        assert.match(headers.get('cookie') || '', /visit=1/)
        return new Response(null, { status: 302, headers: { location: 'https://example.org/landing' } })
      }
      if (parsed.pathname === '/landing') return html(render(content + ' Final landing page.'), { 'set-cookie': 'landing=1; Secure; Path=/' })
      if (parsed.pathname === '/dynamic') return html(render(content))
      if (parsed.pathname === '/challenge' || parsed.pathname === '/challenge-pass') {
        if (parsed.pathname === '/challenge-pass' && browser) return html(render(content))
        return html('Explicit challenge', { 'cf-mitigated': 'challenge' })
      }
      if (parsed.pathname === '/resources') return html(render(content, '<img src="http://127.0.0.1/private"><iframe src="http://10.0.0.1/private"></iframe>'))
      if (parsed.pathname === '/slow') {
        if (browser) slowStarted()
        return html('<title>Documentation</title><div id="root"></div>')
      }
      return new Response('not found', { status: 404 })
    },
  },
})

const { scrapeUrls, closeScrapeBrowserPool } = await import('./web-tools.mjs')
after(async () => { await closeScrapeBrowserPool(); mock.restoreAll() })

test('real Chromium renders an initially empty JS document', async () => {
  const [result] = await scrapeUrls(['https://example.com/dynamic'], 15000)
  assert.equal(result.error, undefined, JSON.stringify(result))
  assert.match(result.content, /Rendered documentation includes/)
  assert.equal(result.extractor, 'puppeteer')
  assert.deepEqual(result.triedExtractors, ['http', 'puppeteer'])
})

test('browser redirects preserve the landing URL and cookie domain isolation', async () => {
  const [result] = await scrapeUrls(['https://example.com/start'], 15000)
  assert.equal(result.error, undefined, JSON.stringify(result))
  assert.equal(result.url, 'https://example.org/landing')
  assert.match(result.content, /Final landing page/)
  assert.ok(seen.some(request => request.browser && request.url.endsWith('/bridge') && request.cookie.includes('visit=1')))
  assert.ok(seen.filter(request => new URL(request.url).hostname === 'example.org').every(request => !request.cookie.includes('visit=1')))
})

test('browser subresources cannot reach private HTTP targets', async () => {
  const [result] = await scrapeUrls(['https://example.com/resources'], 15000)
  assert.equal(result.error, undefined, JSON.stringify(result))
  assert.match(result.content, /Rendered documentation/)
  assert.ok(seen.every(request => !/127\.0\.0\.1|10\.0\.0\.1/.test(request.url)))
})

test('cancelling one browser context leaves another document usable', async () => {
  const controller = new AbortController()
  const slow = scrapeUrls(['https://example.net/slow'], 15000, undefined, controller.signal)
  const healthy = scrapeUrls(['https://example.com/dynamic'], 15000)
  await slowReady
  controller.abort(new Error('cancel slow document'))
  const [[cancelled], [completed]] = await Promise.all([slow, healthy])
  assert.equal(cancelled.errorCode, 'FETCH_CANCELLED')
  assert.equal(completed.error, undefined, JSON.stringify(completed))
  assert.match(completed.content, /Rendered documentation/)
})

test('browser challenge handling uses response headers, including on HTTP 200', async () => {
  const [blocked, recovered] = await scrapeUrls([
    'https://example.com/challenge', 'https://example.org/challenge-pass',
  ], 15000)
  assert.equal(blocked.errorCode, 'BLOCKED_CONTENT', JSON.stringify(blocked))
  assert.deepEqual(blocked.attempts.map(attempt => attempt.stage), ['http', 'puppeteer'])
  assert.equal(recovered.error, undefined, JSON.stringify(recovered))
  assert.match(recovered.content, /Rendered documentation/)
})
