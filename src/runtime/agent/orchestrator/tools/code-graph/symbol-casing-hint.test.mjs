import assert from 'node:assert/strict';
import test from 'node:test';

import { _findSymbolAcrossGraph } from './search-references.mjs';

test('a symbol indexed only under a different casing is surfaced as a hint', () => {
  const node = { rel: 'a.ts', abs: 'a.ts', lang: 'ts', fingerprint: 'f', symbols: [] };
  const graph = {
    nodes: new Map([[node.rel, node]]),
    _symbolTokenIndex: new Map([['*|Widget', [node.rel]]]),
    _sourceTextCache: new Map([[node.rel, { fingerprint: 'f', text: 'const Widget = 1;\n' }]]),
    _sourceLinesCache: new Map(),
    _maskedLinesCache: new Map(),
  };

  const out = _findSymbolAcrossGraph(graph, 'widget', '/repo');

  assert.match(out, /^\(no symbol matches/);
  assert.match(out, /different casing: Widget/);
});
