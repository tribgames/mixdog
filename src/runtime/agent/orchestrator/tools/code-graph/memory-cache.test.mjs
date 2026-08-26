import test from 'node:test';
import assert from 'node:assert/strict';

import { codeGraphCache } from '../code-graph-state.mjs';
import { _attachGraphRuntimeCaches, _estimateGraphRetainedBytes } from './graph-model.mjs';
import { _pruneCodeGraphMemoryCache } from './memory-cache.mjs';

function graphWithSource(text) {
  const graph = _attachGraphRuntimeCaches({
    cwd: '.',
    nodes: new Map([['src/a.ts', {
      rel: 'src/a.ts',
      abs: 'src/a.ts',
      lang: 'typescript',
      symbols: [{ name: 'alpha', kind: 'function', line: 1, endLine: 1 }],
    }]]),
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

test('memory pruning evicts a base graph that exceeds the total budget', () => {
  codeGraphCache.clear();
  try {
    const graph = graphWithSource('');
    codeGraphCache.set('a', { graph, ts: 1, lastAccess: 1 });
    const result = _pruneCodeGraphMemoryCache({ maxBytes: 1, maxEntries: 6 });
    assert.equal(codeGraphCache.size, 0);
    assert.ok(result.evicted.some((row) => row.reason === 'max-bytes-graph'));
  } finally {
    codeGraphCache.clear();
  }
});
