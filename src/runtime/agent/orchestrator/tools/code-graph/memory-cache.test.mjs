import test from 'node:test';
import assert from 'node:assert/strict';

import { codeGraphCache } from '../code-graph-state.mjs';
import { _attachGraphRuntimeCaches, _estimateGraphRetainedBytes } from './graph-model.mjs';
import { _pruneCodeGraphMemoryCache } from './memory-cache.mjs';

function graphWithSource(text) {
  const graph = _attachGraphRuntimeCaches({
    cwd: '.',
    nodes: new Map([
      [
        'src/a.ts',
        {
          rel: 'src/a.ts',
          abs: 'src/a.ts',
          lang: 'typescript',
          symbols: [{ name: 'alpha', kind: 'function', line: 1, endLine: 1 }],
        },
      ],
    ]),
    reverse: new Map(),
  });
  graph._sourceTextCache.set('src/a.ts', { fingerprint: '', text });
  return graph;
}

test('memory pruning clears runtime data before evicting a base graph', () => {
  codeGraphCache.clear();
  try {
    const graph = graphWithSource('x'.repeat(16_000));
    const before = _estimateGraphRetainedBytes(graph);
    graph._sourceTextCache.clear();
    const base = _estimateGraphRetainedBytes(graph);
    graph._sourceTextCache.set('src/a.ts', { fingerprint: '', text: 'x'.repeat(16_000) });
    assert.ok(before > base);
    codeGraphCache.set('a', { graph, ts: 1, lastAccess: 1 });

    const result = _pruneCodeGraphMemoryCache({ maxBytes: base, maxEntries: 6 });
    assert.equal(codeGraphCache.has('a'), true);
    assert.equal(graph._sourceTextCache.size, 0);
    assert.ok(result.totalRetainedBytes <= base);
  } finally {
    codeGraphCache.clear();
  }
});

test('memory pruning evicts older base graphs but keeps the most recently used one', () => {
  codeGraphCache.clear();
  try {
    const older = graphWithSource('');
    const newest = graphWithSource('x'.repeat(16_000));
    codeGraphCache.set('a', { graph: older, ts: 1, lastAccess: 1 });
    codeGraphCache.set('b', { graph: newest, ts: 2, lastAccess: 2 });
    const result = _pruneCodeGraphMemoryCache({ maxBytes: 1, maxEntries: 6 });
    assert.deepEqual([...codeGraphCache.keys()], ['b']);
    assert.ok(result.evicted.some((row) => row.cwd === 'a' && row.reason === 'max-bytes-graph'));
    // Its rebuildable source cache still goes, so the resident size is the base graph.
    assert.equal(newest._sourceTextCache.size, 0);
    assert.equal(result.totalRetainedBytes, _estimateGraphRetainedBytes(newest));
  } finally {
    codeGraphCache.clear();
  }
});

test('a worker-built graph arrives with its base size, matching a main-thread walk of the clone', async () => {
  const { _postCodeGraphWorkerSuccess, _codeGraphWorkerReceiver } = await import('./build.mjs');
  const { _estimateGraphBaseBytes, _seedGraphBaseBytes } = await import('./graph-model.mjs');
  const graph = graphWithSource('x'.repeat(4_000));
  graph.signature = 'sig';
  let message = null;
  const receive = _codeGraphWorkerReceiver();
  await _postCodeGraphWorkerSuccess(
    graph,
    (posted) => (message = receive(structuredClone(posted)) || message),
    () => {}
  );
  const fresh = structuredClone(message.graph);
  assert.equal(message.baseBytes, _estimateGraphBaseBytes(fresh));
  _seedGraphBaseBytes(message.graph, message.baseBytes);
  assert.equal(_estimateGraphRetainedBytes(message.graph), _estimateGraphRetainedBytes(fresh));
});

test('retained-size estimate tracks runtime caches and call hydration of a memoized base', () => {
  const graph = graphWithSource('');
  graph._sourceTextCache.clear();
  const base = _estimateGraphRetainedBytes(graph);
  graph._sourceTextCache.set('src/b.ts', { fingerprint: '', text: 'y'.repeat(10_000) });
  assert.ok(_estimateGraphRetainedBytes(graph) >= base + 20_000);
  graph._sourceTextCache.clear();
  assert.equal(_estimateGraphRetainedBytes(graph), base);
  graph._callsHydration = 'done';
  graph.nodes.get('src/a.ts').calls = Array.from({ length: 100 }, (_, i) => ({ name: `c${i}`, line: i }));
  assert.ok(_estimateGraphRetainedBytes(graph) > base + 100 * 48);
});
