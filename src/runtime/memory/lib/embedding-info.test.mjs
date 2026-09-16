import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configureEmbedding,
  getEmbeddingInfo,
  getEmbeddingModelId,
  isEmbeddingModelReady,
  getEmbeddingDims,
  primeEmbeddingDims,
} from './embedding-provider.mjs';
import { getKnownEmbeddingDims, normalizeEmbeddingDtype } from './embedding-model-config.mjs';

test('embedding info exposes current configuration without warming the model', () => {
  const model = getEmbeddingModelId();
  const prior = getEmbeddingInfo().dtype;
  try {
    configureEmbedding({ dtype: 'q4' });
    const info = getEmbeddingInfo();
    assert.equal(info.model, model);
    assert.equal(info.dtype, normalizeEmbeddingDtype(model, 'q4'));
    assert.equal(info.dimensions, getKnownEmbeddingDims(model));
    assert.equal(info.device, '');
    assert.equal(info.engine, 'Transformers.js · ONNX Runtime');
    assert.equal(isEmbeddingModelReady(), false);
  } finally {
    configureEmbedding({ dtype: prior });
  }
});

test('reapplying an unchanged embedding configuration preserves known dimensions', () => {
  const info = getEmbeddingInfo();
  primeEmbeddingDims(info.dimensions);
  configureEmbedding({ dtype: info.dtype });
  assert.equal(getEmbeddingDims(), info.dimensions);
});
