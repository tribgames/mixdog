import assert from 'node:assert/strict';
import test from 'node:test';

import { _formatFullSymbolBody } from './search-references.mjs';

test('full symbol bodies are not elided at the old 120-line boundary', () => {
  const source = Array.from({ length: 180 }, (_, index) => `line ${index + 1}`).join('\n');
  const rendered = _formatFullSymbolBody(source, 1, 180);

  assert.equal(rendered.split('\n').length, 180);
  assert.match(rendered, /^1: line 1$/m);
  assert.match(rendered, /^180: line 180$/m);
  assert.doesNotMatch(rendered, /lines elided|full body: read/);
});

test('full symbol body formatting stays inside the source file', () => {
  const rendered = _formatFullSymbolBody('one\ntwo\nthree', 2, 99);

  assert.equal(rendered, '2: two\n3: three');
});
