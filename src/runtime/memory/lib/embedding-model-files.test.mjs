import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { ensureModelFile, ensureModelGraph } from './embedding-model-files.mjs';

test('an intact cached graph with empty or NUL external weights fetches only the weights', async (t) => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'mixdog-embedding-graph-'));
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return new Response('weights');
  });
  try {
    const graph = join(cacheDir, 'org', 'model', 'onnx', 'model.onnx');
    mkdirSync(dirname(graph), { recursive: true });
    writeFileSync(graph, 'graph');
    for (const damaged of [Buffer.alloc(0), Buffer.alloc(64)]) {
      writeFileSync(`${graph}_data`, damaged);
      assert.equal(await ensureModelGraph(cacheDir, 'org/model', 'onnx/model.onnx'), graph);
      assert.equal(readFileSync(`${graph}_data`, 'utf8'), 'weights');
      assert.equal(readFileSync(graph, 'utf8'), 'graph');
    }
    assert.deepEqual(
      requested.map((url) => url.split('/').pop()),
      ['model.onnx_data', 'model.onnx_data']
    );
    await ensureModelGraph(cacheDir, 'org/model', 'onnx/model.onnx');
    assert.equal(requested.length, 2, 'intact graph and weights are reused');
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('empty, NUL-filled or unparsable cached model files are fetched again', async (t) => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'mixdog-embedding-files-'));
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(url);
    return new Response('{"model_max_length":256}');
  });
  try {
    const target = join(cacheDir, 'org', 'model', 'tokenizer_config.json');
    mkdirSync(dirname(target), { recursive: true });
    for (const damaged of [Buffer.alloc(0), Buffer.alloc(48), Buffer.from('{"model_max')]) {
      writeFileSync(target, damaged);
      assert.equal(await ensureModelFile(cacheDir, 'org/model', 'tokenizer_config.json'), target);
      assert.equal(readFileSync(target, 'utf8'), '{"model_max_length":256}');
    }
    assert.equal(requested.length, 3);
    await ensureModelFile(cacheDir, 'org/model', 'tokenizer_config.json');
    assert.equal(requested.length, 3, 'a healthy cached file is reused');
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
