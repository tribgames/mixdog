import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import http from 'node:http'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { createLoopbackListener } from './loopback-listener.mjs'

function fixture(t, { server = http.createServer(), basePort = 0, maxPort = basePort } = {}) {
  const logs = []
  const listener = createLoopbackListener({
    server, basePort, maxPort,
    onListening: (port) => logs.push(`HTTP listening ${port}`),
    onError: (error, fatal) => logs.push(`HTTP ${fatal ? 'fatal' : 'error'}: ${error.message}`),
  })
  t.after(() => listener.stop())
  return { server, listener, logs }
}

test('concurrent starts share one bind and shutdown permits a fresh start', async (t) => {
  const { server, listener, logs } = fixture(t)
  const first = listener.start()
  assert.equal(listener.start(), first)
  const port = await first
  assert.ok(port > 0)
  assert.equal(server.address().address, '127.0.0.1')
  assert.equal(await listener.start(), port)
  assert.equal(logs.length, 1)
  await listener.stop()
  assert.equal(server.listening, false)
  assert.ok(await listener.start() > 0)
  assert.equal(logs.length, 2)
})

test('an occupied fixed range falls through to one OS-assigned port', async (t) => {
  const occupied = http.createServer()
  occupied.listen(0, '127.0.0.1')
  await once(occupied, 'listening')
  t.after(() => new Promise((resolve) => occupied.close(resolve)))
  const occupiedPort = occupied.address().port
  const { listener, logs } = fixture(t, { basePort: occupiedPort })
  const port = await listener.start()
  assert.notEqual(port, occupiedPort)
  assert.equal(logs.length, 1)
})

test('stopping a pending bind settles startup and cannot leave a late listener', async (t) => {
  const { server, listener } = fixture(t)
  const started = listener.start()
  const rejected = assert.rejects(started, /HTTP listener stopped/)
  const stopped = listener.stop()
  assert.equal(listener.stop(), stopped)
  await assert.rejects(listener.start(), /HTTP listener is stopping/)
  await Promise.all([rejected, stopped])
  await setImmediate()
  assert.equal(server.listening, false)
  assert.ok(await listener.start() > 0)
})

class ControlledServer extends EventEmitter {
  ports = []
  listen({ port }) { this.ports.push(port) }
  address() { return { port: 54321 } }
  close(done) { queueMicrotask(done) }
}

test('fixed ports are tried in order without re-entering the range after port zero', async (t) => {
  const server = new ControlledServer()
  const { listener } = fixture(t, { server, basePort: 3350, maxPort: 3352 })
  const started = listener.start()
  const failure = Object.assign(new Error('ports busy'), { code: 'EADDRINUSE' })
  const rejected = assert.rejects(started, (error) => error === failure)
  for (let i = 0; i < 4; i += 1) server.emit('error', failure)
  await rejected
  assert.deepEqual(server.ports, [3350, 3351, 3352, 0])
})

test('fatal bind failures retain their error and do not poison a later start', async (t) => {
  const server = new ControlledServer()
  const { listener, logs } = fixture(t, { server })
  const failure = Object.assign(new Error('bind denied'), { code: 'EACCES' })
  const rejected = assert.rejects(listener.start(), (error) => error === failure)
  server.emit('error', failure)
  await rejected
  const next = listener.start()
  server.emit('listening')
  assert.equal(await next, 54321)
  assert.equal(logs.length, 2)
})

test('synchronous listen failures reject startup and allow a corrected retry', async (t) => {
  const server = new ControlledServer()
  const failure = new Error('invalid listen options')
  const { listener } = fixture(t, { server })
  server.listen = () => { throw failure }
  await assert.rejects(listener.start(), (error) => error === failure)
  server.listen = ControlledServer.prototype.listen
  const next = listener.start()
  server.emit('listening')
  assert.equal(await next, 54321)
})

test('errors after listening are logged without replacing the bound result', async (t) => {
  const server = new ControlledServer()
  const { listener, logs } = fixture(t, { server })
  const started = listener.start()
  server.emit('listening')
  assert.equal(await started, 54321)
  server.emit('error', new Error('socket failure'))
  assert.equal(await listener.start(), 54321)
  assert.match(logs[1], /HTTP error: socket failure/)
})

test('stop waits for active HTTP requests to finish before releasing the listener', async (t) => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const server = http.createServer(async (_req, res) => {
    entered.resolve()
    await release.promise
    res.end('finished')
  })
  const { listener } = fixture(t, { server })
  const port = await listener.start()
  const response = fetch(`http://127.0.0.1:${port}`, { headers: { connection: 'close' } }).then((res) => res.text())
  await entered.promise
  let stopped = false
  const closing = listener.stop().then(() => { stopped = true })
  await setImmediate()
  try {
    assert.equal(stopped, false)
  } finally {
    release.resolve()
    assert.equal(await response, 'finished')
    await closing
  }
})
