// symbol_search reports a matched name whose record carries no declaration
// position as an unresolved variant instead of dropping it silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { _searchSymbolsByKeyword } from './search.mjs';

function graphOf(symbols) {
  return {
    cwd: '/repo',
    nodes: new Map([['a.mjs', { rel: 'a.mjs', abs: '/repo/a.mjs', lang: 'javascript', fingerprint: 'fp', symbols }]]),
    reverse: new Map(),
    _keywordSearchCache: new Map(),
  };
}

test('a keyword match without a declaration position is listed as unresolved', () => {
  const out = _searchSymbolsByKeyword(
    graphOf([
      { name: 'alphaHelper', kind: 'function', startLine: 3, endLine: 5 },
      { name: 'alphaGhost', kind: 'function' },
    ]),
    'alpha',
    '/repo'
  );
  assert.match(out, /^# search keyword=alpha matches=2 shown=1$/m);
  assert.match(out, /^alphaHelper\ta\.mjs:3-5:1\tfunction$/m);
  assert.match(out, /^\+1 unresolved name variants .*: alphaGhost$/m);
  assert.doesNotMatch(out, /^alphaGhost\t/m);
});

test('fully resolved matches print no unresolved line', () => {
  const out = _searchSymbolsByKeyword(
    graphOf([{ name: 'alphaHelper', kind: 'function', startLine: 3, endLine: 5 }]),
    'alpha',
    '/repo'
  );
  assert.match(out, /^# search keyword=alpha matches=1 shown=1$/m);
  assert.doesNotMatch(out, /unresolved name variants/);
});
