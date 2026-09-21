import assert from 'node:assert/strict';
import test from 'node:test';
import { toolAggregateDetailFallback } from './tool-result-text.mjs';

test('collapsed details preserve explicit text and select the first nonblank result line', () => {
  assert.equal(toolAggregateDetailFallback('  summary  ', 'other result'), '  summary  ');
  assert.equal(toolAggregateDetailFallback('', '\ufeff \r\n\u00a0 result \t\r\nsecond line\n'), 'result');
});

test('collapsed fallback preserves empty values and its existing truncation boundary', () => {
  assert.equal(toolAggregateDetailFallback(null, '\ufeff \n\u00a0'), null);
  assert.equal(toolAggregateDetailFallback('', 'x'.repeat(80)), 'x'.repeat(80));
  assert.equal(toolAggregateDetailFallback('', 'x'.repeat(81)), `${'x'.repeat(77)}…`);
});
