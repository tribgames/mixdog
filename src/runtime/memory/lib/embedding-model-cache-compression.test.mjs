import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compressEmbeddingModelCache,
  embeddingModelCachePath,
} from './embedding-model-cache-compression.mjs'

test('model cache path is confined below the configured cache root', () => {
  assert.match(
    embeddingModelCachePath('C:\\models', 'onnx-community/harrier'),
    /models[\\/]onnx-community[\\/]harrier$/,
  )
  assert.throws(
    () => embeddingModelCachePath('C:\\models', '../outside'),
    /Invalid embedding model id/,
  )
})

test('Windows model cache compression invokes transparent LZX once', async () => {
  const calls = []
  const result = await compressEmbeddingModelCache(
    'C:\\models',
    'onnx-community/harrier',
    {
      platform: 'win32',
      accessPath: async () => {},
      runCompact: async (...args) => { calls.push(args) },
    },
  )

  assert.equal(result.supported, true)
  assert.equal(result.compressed, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'compact.exe')
  assert.deepEqual(calls[0][1].slice(0, 5), [
    '/c',
    `/s:${result.modelDir}`,
    '/i',
    '/q',
    '/exe:lzx',
  ])
})

test('non-Windows platforms do not touch the model cache', async () => {
  const result = await compressEmbeddingModelCache('/models', 'org/model', {
    platform: 'linux',
    accessPath: async () => { throw new Error('must not access') },
    runCompact: async () => { throw new Error('must not execute') },
  })
  assert.deepEqual(result, { supported: false, compressed: false })
})
