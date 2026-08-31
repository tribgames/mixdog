import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getConfiguredEmbeddingModelId,
  getEmbeddingModelLoadOptions,
  getEmbeddingOutputName,
  getEmbeddingPooling,
  getKnownEmbeddingDims,
  normalizeEmbeddingDtype,
  normalizeEmbeddingInputType,
  prepareEmbeddingInput,
} from './embedding-model-config.mjs'

const E5_SMALL = 'Xenova/multilingual-e5-small'

test('multilingual E5-small is the fixed production default', () => {
  const prior = process.env.MIXDOG_EMBED_MODEL
  delete process.env.MIXDOG_EMBED_MODEL
  try {
    assert.equal(getConfiguredEmbeddingModelId(), E5_SMALL)
  } finally {
    if (prior == null) delete process.env.MIXDOG_EMBED_MODEL
    else process.env.MIXDOG_EMBED_MODEL = prior
  }
  assert.equal(getKnownEmbeddingDims(E5_SMALL), 384)
  assert.equal(normalizeEmbeddingDtype(E5_SMALL, ''), 'q8')
  assert.equal(normalizeEmbeddingDtype(E5_SMALL, 'q4'), 'q8')
  assert.deepEqual(getEmbeddingModelLoadOptions(E5_SMALL), {})
  assert.equal(getEmbeddingOutputName(E5_SMALL), '')
  assert.equal(getEmbeddingPooling(E5_SMALL), 'mean')
})

test('multilingual E5-small applies asymmetric retrieval prefixes', () => {
  const text = 'Windows 음성 런타임의 메모리 사용량'
  assert.equal(normalizeEmbeddingInputType('QUERY'), 'query')
  assert.equal(normalizeEmbeddingInputType('passage'), 'document')
  assert.equal(prepareEmbeddingInput(text, 'query', E5_SMALL), `query: ${text}`)
  assert.equal(prepareEmbeddingInput(text, 'document', E5_SMALL), `passage: ${text}`)
})

test('Granite fallback keeps its official CLS pooling contract', () => {
  assert.equal(getEmbeddingPooling('ibm-granite/granite-embedding-97m-multilingual-r2'), 'cls')
})
