import test from 'node:test'
import assert from 'node:assert/strict'
import { HostPacer, runFetchPipeline } from './fetch-pipeline.mjs'

const url = 'https://example.com/docs'
const page = { url, format: 'html', title: 'Guide', content: 'Useful page content.' }
const options = () => ({ timeoutMs: 3000, hostPacer: new HostPacer({ intervalMs: 0 }) })
const error = (message, props) => Object.assign(new Error(message), props)

test('HTTP success avoids browser startup and reports only actual attempts', async () => {
  const result = await runFetchPipeline(url, {
    ...options(), http: async () => page,
    browser: async () => assert.fail('browser must remain lazy'),
  })
  assert.deepEqual(result.triedExtractors, ['http'])
  assert.equal(result.attempts[0].status, 'success')
})

test('empty documents, HTTP 403 and explicit challenge responses escalate once', async () => {
  for (const http of [
    async () => ({ ...page, content: '' }),
    async () => { throw error('HTTP 403', { status: 403 }) },
    async () => { throw error('No readable content', { code: 'EMPTY_CONTENT' }) },
    ...[200, 403, 503].map(status => async () => { throw error('Explicit challenge response', { code: 'BLOCKED_CONTENT', status }) }),
  ]) {
    const result = await runFetchPipeline(url, { ...options(), http, browser: async () => page })
    assert.deepEqual(result.triedExtractors, ['http', 'puppeteer'])
    assert.equal(result.failures.length, 1)
  }
  await assert.rejects(runFetchPipeline(url, {
    ...options(), http: async () => { throw error('HTTP 403', { status: 403 }) },
    browser: async () => { throw error('Explicit challenge response', { code: 'BLOCKED_CONTENT', status: 200 }) },
  }), failure => failure.code === 'BLOCKED_CONTENT' && failure.failures.length === 2)
})

test('security blocks and terminal HTTP errors do not retry or launch a browser', async () => {
  for (const failure of [error('Blocked request to private address'), error('HTTP 404', { status: 404 }), error('HTTP 401', { status: 401 })]) {
    let attempts = 0
    await assert.rejects(runFetchPipeline(url, {
      ...options(), http: async () => { attempts++; throw failure },
      browser: async () => assert.fail('terminal failures cannot escalate'),
    }))
    assert.equal(attempts, 1)
  }
})

test('transient HTTP failures retry within budget and respect Retry-After', async () => {
  let attempts = 0
  const start = Date.now()
  const result = await runFetchPipeline(url, {
    ...options(),
    http: async () => {
      if (++attempts === 1) throw error('HTTP 429', { status: 429, retryAfterMs: 450 })
      return page
    },
  })
  assert.equal(result.content, page.content)
  assert.equal(attempts, 2)
  assert.ok(Date.now() - start >= 450)
  let count = 0
  await assert.rejects(runFetchPipeline(url, {
    ...options(), timeoutMs: 100,
    http: async () => { count++; throw error('HTTP 429', { status: 429, retryAfterMs: 10000 }) },
    browser: async () => assert.fail('rate limits cannot be evaded by switching engines'),
  }), { code: 'RATE_LIMITED' })
  assert.equal(count, 1)
  await assert.rejects(runFetchPipeline(url, {
    ...options(), timeoutMs: 100,
    http: async () => { throw error('Rate limited challenge', { status: 429, code: 'BLOCKED_CONTENT', retryAfterMs: 10000 }) },
    browser: async () => assert.fail('challenge headers do not override rate limits'),
  }), { code: 'BLOCKED_CONTENT' })
})

test('total deadline and caller cancellation stop queued or hanging stages', async () => {
  const signals = []
  await assert.rejects(runFetchPipeline(url, {
    ...options(), timeoutMs: 120,
    http: async (_budget, signal) => { signals.push(signal); return new Promise(() => {}) },
    browser: async (_budget, signal) => { signals.push(signal); return new Promise(() => {}) },
  }), { code: 'FETCH_TIMEOUT' })
  assert.ok(signals.every(signal => signal.aborted))
  const controller = new AbortController()
  const pending = runFetchPipeline(url, {
    ...options(), signal: controller.signal,
    http: async () => { controller.abort(new Error('user stopped')); return page },
    browser: async () => assert.fail('cancelled work cannot escalate'),
  })
  await assert.rejects(pending, { code: 'FETCH_CANCELLED' })
})

test('host pacing serializes a site, isolates other sites and skips cancelled waiters', async () => {
  const pacer = new HostPacer({ intervalMs: 0 })
  const calls = []
  let release
  const blocker = new Promise(resolve => { release = resolve })
  const first = pacer.run(url, undefined, async () => { calls.push('first'); await blocker })
  const controller = new AbortController()
  const cancelled = pacer.run(url, controller.signal, async () => assert.fail('cancelled waiter executed'))
  const third = pacer.run(url, undefined, async () => { calls.push('third') })
  controller.abort(new Error('cancel queued'))
  await assert.rejects(cancelled, /cancel queued/)
  await pacer.run('https://example.org', undefined, async () => { calls.push('other') })
  assert.deepEqual(calls, ['first', 'other'])
  release()
  await Promise.all([first, third])
  assert.deepEqual(calls, ['first', 'other', 'third'])
})
