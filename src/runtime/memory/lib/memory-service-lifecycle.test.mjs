import assert from 'node:assert/strict'
import http from 'node:http'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { createLoopbackListener } from '../../shared/loopback-listener.mjs'
import { createMemoryServiceLifecycle } from './memory-service-lifecycle.mjs'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(overrides = {}) {
  const calls = []
  const lifecycle = createMemoryServiceLifecycle({
    initialize: async () => { calls.push('initialize') },
    openListener: async () => { calls.push('listen'); return 3350 },
    closeListener: async () => { calls.push('close') },
    advertisePort: (port) => { calls.push(['advertise', port]) },
    withdraw: () => { calls.push('withdraw') },
    stopBackgroundWork: async () => { calls.push('stop-background') },
    shutdown: async () => { calls.push('shutdown') },
    onStart: () => { calls.push('start') },
    onReady: (port) => { calls.push(['ready', port]) },
    onInitError: (error) => { calls.push(['error', error]) },
    ...overrides,
  })
  return { lifecycle, calls }
}

test('concurrent initialization opens each owner and publishes readiness once', async () => {
  const { lifecycle, calls } = fixture()
  const started = lifecycle.init()
  assert.equal(lifecycle.init(), started)
  await started
  await lifecycle.init()
  assert.equal(lifecycle.getInitialized(), true)
  assert.equal(calls.filter((item) => item === 'initialize').length, 1)
  assert.equal(calls.filter((item) => item === 'listen').length, 1)
  assert.deepEqual(calls.filter(Array.isArray), [['advertise', 3350], ['ready', 3350]])
  await lifecycle.stop()
})

test('the bound port is advertised before runtime readiness, but ready waits for both', async () => {
  const runtime = deferred()
  const { lifecycle, calls } = fixture({ initialize: () => runtime.promise })
  const started = lifecycle.init()
  await setImmediate()
  assert.equal(lifecycle.getInitialized(), false)
  assert.ok(lifecycle.getInitPromise())
  assert.deepEqual(calls.filter(Array.isArray), [['advertise', 3350]])
  runtime.resolve()
  await started
  assert.deepEqual(calls.filter(Array.isArray), [['advertise', 3350], ['ready', 3350]])
  await lifecycle.stop()
})

test('shutdown waits for in-flight acquisition before releasing its resources', async () => {
  const runtime = deferred()
  let signal
  const { lifecycle, calls } = fixture({
    initialize: async (value) => { signal = value; await runtime.promise; calls.push('acquired') },
  })
  const rejected = assert.rejects(lifecycle.init(), /memory service stopping/)
  await setImmediate()
  const stopped = lifecycle.stop()
  assert.equal(lifecycle.stop(), stopped)
  assert.equal(signal.aborted, true)
  await assert.rejects(lifecycle.init(), /memory service stopping/)
  await setImmediate()
  assert.ok(calls.includes('withdraw'))
  assert.ok(calls.includes('close'))
  assert.equal(calls.includes('shutdown'), false)
  runtime.resolve()
  await Promise.all([rejected, stopped])
  assert.ok(calls.indexOf('acquired') < calls.indexOf('shutdown'))
  assert.equal(calls.some((item) => Array.isArray(item) && item[0] === 'ready'), false)
  assert.equal(lifecycle.getInitialized(), false)
  assert.equal(lifecycle.getInitPromise(), null)
})

test('same-tick shutdown cancels queued acquisition instead of starting it', async () => {
  const { lifecycle, calls } = fixture()
  const rejected = assert.rejects(lifecycle.init(), /memory service stopping/)
  await lifecycle.stop()
  await rejected
  assert.equal(calls.includes('initialize'), false)
  assert.equal(calls.includes('listen'), false)
  assert.ok(calls.includes('shutdown'))
})

test('a late listener result cannot re-advertise or report ready after stop', async () => {
  const bind = deferred()
  const { lifecycle, calls } = fixture({ openListener: () => bind.promise })
  const rejected = assert.rejects(lifecycle.init(), /memory service stopping/)
  await setImmediate()
  const stopped = lifecycle.stop()
  bind.resolve(3350)
  await Promise.all([rejected, stopped])
  assert.equal(calls.some(Array.isArray), false)
})

test('runtime failure during a pending HTTP bind is handled and releases both owners', async () => {
  const bind = deferred()
  const failure = new Error('database unavailable')
  const { lifecycle, calls } = fixture({
    initialize: async () => { throw failure },
    openListener: () => bind.promise,
    closeListener: async () => { calls.push('close'); bind.reject(new Error('bind cancelled')) },
  })
  await assert.rejects(lifecycle.init(), (error) => error === failure)
  assert.ok(calls.includes('close'))
  assert.ok(calls.includes('shutdown'))
  assert.equal(lifecycle.isStopping(), false)
})

test('listener failure waits for runtime acquisition and preserves the bind error', async () => {
  const runtime = deferred()
  const failure = new Error('bind denied')
  const { lifecycle, calls } = fixture({
    initialize: () => runtime.promise,
    openListener: async () => { throw failure },
  })
  const rejected = assert.rejects(lifecycle.init(), (error) => error === failure)
  await setImmediate()
  assert.equal(calls.includes('shutdown'), false)
  runtime.resolve()
  await rejected
  assert.ok(calls.includes('shutdown'))
})

test('integrated or secondary startup reports a null port without advertising', async () => {
  const { lifecycle, calls } = fixture({ openListener: async () => null })
  await lifecycle.init()
  assert.deepEqual(calls.filter(Array.isArray), [['ready', null]])
  await lifecycle.stop()
})

test('initialization can restart after shutdown and after a failed acquisition', async () => {
  let attempts = 0
  const failure = new Error('first attempt failed')
  const { lifecycle } = fixture({
    initialize: async () => { if (++attempts === 1) throw failure },
  })
  await assert.rejects(lifecycle.init(), (error) => error === failure)
  await lifecycle.init()
  assert.equal(lifecycle.getInitialized(), true)
  await lifecycle.stop()
  await lifecycle.init()
  assert.equal(attempts, 3)
  assert.equal(lifecycle.getInitialized(), true)
  await lifecycle.stop()
})

test('explicit shutdown reports cleanup failures and clears readiness', async () => {
  const failure = new Error('database close failed')
  const { lifecycle } = fixture({ shutdown: async () => { throw failure } })
  await lifecycle.init()
  await assert.rejects(lifecycle.stop(), (error) => error === failure)
  assert.equal(lifecycle.getInitialized(), false)
  assert.equal(lifecycle.isStopping(), false)
})

test('service shutdown closes a real listener while runtime initialization is pending', async (t) => {
  const server = http.createServer()
  const listener = createLoopbackListener({ server, onListening() {}, onError() {} })
  t.after(() => listener.stop())
  const runtime = deferred()
  const { lifecycle } = fixture({
    initialize: () => runtime.promise,
    openListener: listener.start,
    closeListener: listener.stop,
  })
  const rejected = assert.rejects(lifecycle.init(), /memory service stopping/)
  await setImmediate()
  const stopped = lifecycle.stop()
  runtime.resolve()
  await Promise.all([rejected, stopped])
  assert.equal(server.listening, false)
})

test('shutdown stops workers before waiting for requests that depend on those workers', async () => {
  const listenerClosed = deferred()
  const calls = []
  const { lifecycle } = fixture({
    closeListener: () => {
      calls.push('listener-closing')
      return listenerClosed.promise
    },
    stopBackgroundWork: async () => {
      calls.push('workers-stopped')
      listenerClosed.resolve()
    },
    shutdown: async () => { calls.push('storage-closed') },
  })
  await lifecycle.init()
  const stopped = lifecycle.stop()
  try {
    await setImmediate()
    assert.ok(calls.includes('workers-stopped'))
  } finally {
    listenerClosed.resolve()
    await stopped
  }
  assert.deepEqual(calls, ['listener-closing', 'workers-stopped', 'storage-closed'])
})

for (const step of ['withdraw', 'closeListener', 'stopBackgroundWork']) {
  test(`shutdown releases independent resources after ${step} fails`, async () => {
    const failure = new Error(`${step} failed`)
    const cleanup = []
    const overrides = Object.fromEntries(
      ['withdraw', 'closeListener', 'stopBackgroundWork', 'shutdown'].map((name) => [
        name,
        () => {
          cleanup.push(name)
          if (name === step) throw failure
        },
      ]),
    )
    const { lifecycle } = fixture(overrides)
    await lifecycle.init()
    await assert.rejects(lifecycle.stop(), (error) => error === failure)
    assert.deepEqual(cleanup, ['withdraw', 'closeListener', 'stopBackgroundWork', 'shutdown'])
  })
}

test('failed worker shutdown still drains active requests before storage closes', async () => {
  const drain = deferred()
  const failure = new Error('worker termination failed')
  let storageClosed = false
  const { lifecycle } = fixture({
    closeListener: () => drain.promise,
    stopBackgroundWork: async () => { throw failure },
    shutdown: async () => { storageClosed = true },
  })
  await lifecycle.init()
  let stopped = false
  const rejected = assert.rejects(lifecycle.stop(), (error) => error === failure)
    .then(() => { stopped = true })
  await setImmediate()
  assert.equal(stopped, false)
  assert.equal(storageClosed, false)
  drain.resolve()
  await rejected
  assert.equal(storageClosed, true)
})

test('multiple shutdown failures remain available after every cleanup is attempted', async () => {
  const failures = [new Error('listener close failed'), new Error('database close failed')]
  const { lifecycle, calls } = fixture({
    closeListener: async () => { throw failures[0] },
    shutdown: async () => { throw failures[1] },
  })
  await lifecycle.init()
  await assert.rejects(lifecycle.stop(), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, failures)
    return true
  })
  assert.ok(calls.includes('stop-background'))
})
