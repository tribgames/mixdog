import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toolAggregateDetailFallback,
  toolGroupedDisplayFallback,
  toolResultText,
} from './engine.mjs';

test('toolResultText prefers nested content over empty scalar fields', () => {
  assert.equal(
    toolResultText({ text: '', content: [{ type: 'text', text: 'nested body' }] }),
    'nested body',
  );
});

test('toolResultText unwraps nested tool_result blocks', () => {
  assert.equal(
    toolResultText({
      type: 'tool_result',
      content: [{ type: 'tool_result', content: 'inner payload' }],
    }),
    'inner payload',
  );
});

test('toolResultText preserves explicit empty tool_result clears', () => {
  assert.equal(toolResultText({ type: 'tool_result', content: '' }), '');
});

test('toolResultText preserves empty tool_result content arrays', () => {
  assert.equal(toolResultText({ type: 'tool_result', content: [] }), '');
  assert.notEqual(toolResultText({ type: 'tool_result', content: [] }), '{"type":"tool_result","content":[]}');
});

test('toolResultText preserves empty typed text parts inside tool_result', () => {
  assert.equal(
    toolResultText({ type: 'tool_result', content: [{ type: 'text', text: '' }] }),
    '',
  );
});

test('toolResultText preserves empty object-shaped tool_result inner content', () => {
  assert.equal(toolResultText({ type: 'tool_result', content: {} }), '');
  assert.equal(
    toolResultText({ type: 'tool_result', content: { type: 'text', text: '' } }),
    '',
  );
});

test('toolResultText still extracts plain strings and structured bodies', () => {
  assert.equal(toolResultText('plain body'), 'plain body');
  assert.equal(
    toolResultText([{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }]),
    'line one\nline two',
  );
});

test('toolResultText maps every top-level array element without using index as depth', () => {
  const parts = Array.from({ length: 14 }, (_, i) => ({ type: 'text', text: `line-${i}` }));
  const out = toolResultText(parts);
  assert.match(out, /^line-0\n/);
  assert.match(out, /\nline-13$/);
  assert.equal(out.split('\n').length, 14);
});

test('toolAggregateDetailFallback uses raw body when summary detail is empty', () => {
  assert.equal(toolAggregateDetailFallback('', 'file contents here'), 'file contents here');
});

test('toolGroupedDisplayFallback uses later extracted body when grouped text is empty', () => {
  assert.equal(toolGroupedDisplayFallback('', '', 'recovered body'), 'recovered body');
  assert.equal(toolGroupedDisplayFallback('group summary', '', 'later body'), 'group summary');
});


