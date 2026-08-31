import assert from 'node:assert/strict'
import test from 'node:test'

import { embedRecallQuery } from './recall-embedding-readiness.mjs'

const vector = [0.25, 0.75]

test('ready recall embeds immediately as a query', async () => {
  const calls = []
  const result = await embedRecallQuery('memory query', {
    isReady: () => true,
    canWarmup: () => false,
    warmup: async () => { throw new Error('must not warm') },
    embed: async (text, options) => {
      calls.push({ text, options })
      return vector
    },
  })

  assert.deepEqual(result, { vector, state: 'ready' })
  assert.deepEqual(calls, [{
    text: 'memory query',
    options: { priority: true, inputType: 'query' },
  }])
})

test('cold recall waits for warmup and keeps dense retrieval in the same request', async () => {
  let warmed = false
  const result = await embedRecallQuery('교차 language query', {
    isReady: () => false,
    canWarmup: () => true,
    warmup: async () => { warmed = true },
    embed: async () => vector,
    waitMs: 50,
  })

  assert.equal(warmed, true)
  assert.deepEqual(result, { vector, state: 'warmed' })
})

test('cold recall falls back after the bounded wait while warmup continues', async () => {
  let resolveWarmup
  const warmup = new Promise((resolve) => { resolveWarmup = resolve })
  let embedded = false
  const result = await embedRecallQuery('bounded wait', {
    isReady: () => false,
    canWarmup: () => true,
    warmup: () => warmup,
    embed: async () => {
      embedded = true
      return vector
    },
    waitMs: 5,
  })

  assert.deepEqual(result, { vector: null, state: 'timeout' })
  assert.equal(embedded, false)
  resolveWarmup()
  await warmup
})

test('cold recall reports warmup failure and preserves lexical fallback', async () => {
  const errors = []
  const failure = new Error('load failed')
  const result = await embedRecallQuery('fallback query', {
    isReady: () => false,
    canWarmup: () => true,
    warmup: async () => { throw failure },
    embed: async () => vector,
    onWarmupError: (error) => errors.push(error),
    waitMs: 50,
  })

  assert.equal(result.vector, null)
  assert.equal(result.state, 'failed')
  assert.equal(result.error, failure)
  assert.deepEqual(errors, [failure])
})

test('cold recall aborts without waiting for the timeout', async () => {
  const controller = new AbortController()
  const reason = new Error('cancelled')
  const pending = embedRecallQuery('cancel query', {
    isReady: () => false,
    canWarmup: () => true,
    warmup: () => new Promise(() => {}),
    embed: async () => vector,
    signal: controller.signal,
    waitMs: 5_000,
  })
  controller.abort(reason)

  await assert.rejects(pending, reason)
})
