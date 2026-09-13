import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { createHttpRouter } from './http-router.mjs'

function request(url, callId = null) {
  const req = new PassThrough()
  req.method = 'POST'
  req.url = url
  req.headers = { host: '127.0.0.1', ...(callId ? { 'x-mixdog-call-id': callId } : {}) }
  return req
}

class Response extends EventEmitter {
  writableFinished = false
  statusCode = 0
  value = null
  writeHead(status) { this.statusCode = status }
  end(body) { this.value = JSON.parse(body); this.writableFinished = true }
}

function fixture() {
  let draining = false
  const calls = []
  const router = createHttpRouter({
    getInitialized: () => true,
    getInitPromise: () => null,
    getDraining: () => draining,
    handleToolCall: async (name) => { calls.push(name); return { content: [] } },
  })
  return { router, calls, drain: () => { draining = true } }
}

async function cancel(router, callId) {
  const req = request('/api/cancel')
  const res = new Response()
  const pending = router.requestHandler(req, res)
  req.end(JSON.stringify({ callId }))
  await pending
  return res.value
}

test('a tool request whose body finishes during shutdown cannot start new memory work', async () => {
  const f = fixture()
  const req = request('/api/tool', 'slow-body')
  const res = new Response()
  const pending = f.router.requestHandler(req, res)
  await setImmediate()
  f.drain()
  req.end(JSON.stringify({ name: 'remember', arguments: {} }))
  await pending
  assert.deepEqual(f.calls, [])
  assert.equal(res.statusCode, 503)
  assert.equal(res.value.content[0].text, 'memory worker draining')
})

test('cancellation received during body parsing prevents tool invocation', async () => {
  const f = fixture()
  const req = request('/api/tool', 'canceled-body')
  const res = new Response()
  const pending = f.router.requestHandler(req, res)
  await setImmediate()
  assert.equal((await cancel(f.router, 'canceled-body')).cancelled, true)
  req.end(JSON.stringify({ name: 'remember', arguments: {} }))
  await pending
  assert.deepEqual(f.calls, [])
  assert.equal(res.value.isError, true)
})

test('a canceled request cannot remove cancellation ownership from a later reuse of its call id', async () => {
  const f = fixture()
  const first = request('/api/tool', 'reused')
  const firstPending = f.router.requestHandler(first, new Response())
  await setImmediate()
  await cancel(f.router, 'reused')
  const second = request('/api/tool', 'reused')
  const secondPending = f.router.requestHandler(second, new Response())
  await setImmediate()
  first.end(JSON.stringify({ name: 'old', arguments: {} }))
  await firstPending
  const canceled = await cancel(f.router, 'reused')
  second.end(JSON.stringify({ name: 'new', arguments: {} }))
  await secondPending
  assert.equal(canceled.cancelled, true)
  assert.deepEqual(f.calls, [])
})
