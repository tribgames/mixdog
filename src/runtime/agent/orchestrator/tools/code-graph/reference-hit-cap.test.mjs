import assert from 'node:assert/strict';
import test from 'node:test';

import { _cheapReferenceSearch } from './search.mjs';

test('the reference truncation notice reports the cap the scan actually applied', () => {
  const previous = process.env.REFERENCE_HIT_CAP;
  process.env.REFERENCE_HIT_CAP = '2';
  try {
    const node = { rel: 'a.ts', abs: 'a.ts', lang: 'ts', fingerprint: 'f' };
    const graph = {
      nodes: new Map([[node.rel, node]]),
      _sourceTextCache: new Map([[node.rel, { fingerprint: 'f', text: 'target;\ntarget;\ntarget;\n' }]]),
      _sourceLinesCache: new Map(),
      _maskedLinesCache: new Map(),
    };

    const out = _cheapReferenceSearch(graph, 'target', '/repo', { nodes: [node] });

    assert.match(out, /total hits exceeded 2, showing first 2/);
  } finally {
    if (previous === undefined) delete process.env.REFERENCE_HIT_CAP;
    else process.env.REFERENCE_HIT_CAP = previous;
  }
});
