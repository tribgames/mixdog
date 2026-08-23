import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getEmbeddingModelLoadOptions,
  getEmbeddingOutputName,
  getEmbeddingPooling,
  getKnownEmbeddingDims,
  normalizeEmbeddingDtype,
  normalizeEmbeddingInputType,
  prepareEmbeddingInput,
} from './embedding-model-config.mjs'

const HARRIER = 'onnx-community/harrier-oss-v1-270m-ONNX'

test('Harrier uses its fixed ONNX profile and last-token pooling', () => {
  assert.equal(getKnownEmbeddingDims(HARRIER), 640)
  assert.equal(normalizeEmbeddingDtype(HARRIER, ''), 'q4')
  assert.deepEqual(getEmbeddingModelLoadOptions(HARRIER), { model_file_name: 'model' })
  assert.equal(getEmbeddingOutputName(HARRIER), 'sentence_embedding')
  assert.equal(getEmbeddingPooling(HARRIER), 'last_token')
})

test('Harrier applies its retrieval instruction only to queries', () => {
  const text = 'Windows 음성 런타임의 메모리 사용량'
  assert.equal(normalizeEmbeddingInputType('QUERY'), 'query')
  assert.equal(normalizeEmbeddingInputType('passage'), 'document')
  assert.equal(prepareEmbeddingInput(text, 'document', HARRIER), text)
  assert.equal(
    prepareEmbeddingInput(text, 'query', HARRIER),
    `Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ${text}`,
  )
})
