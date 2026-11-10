import assert from 'node:assert/strict';
import test from 'node:test';
import { toolAggregateDetailFallback, toolResultText } from './tool-result-text.mjs';

test('content arrays flatten to newline-joined part text, dropping empty parts', () => {
  assert.equal(toolResultText(['a', { type: 'text', text: 'b' }, { type: 'text', text: '' }, null]), 'a\nb');
  assert.equal(toolResultText({ content: [{ type: 'output_text', text: 'x' }] }), 'x');
  assert.equal(toolResultText({ parts: [{ type: 'input_text', text: 'p' }, { type: 'text' }] }), 'p');
  assert.equal(toolResultText({ content: { type: 'text', text: 'single' } }), 'single');
});

test('images, nested tool results and empty results keep their current rendering', () => {
  assert.equal(toolResultText([{ type: 'image', mimeType: 'image/png' }]), '[image: image/png]');
  assert.equal(toolResultText([{ type: 'image' }]), '[image: image]');
  assert.equal(
    toolResultText({ source: { type: 'base64', data: 'AA', media_type: 'image/jpeg' } }),
    '[image: image/jpeg]'
  );
  assert.equal(toolResultText({ type: 'tool_result', content: [{ type: 'text', text: 'deep' }] }), 'deep');
  assert.equal(toolResultText({ type: 'tool_result', content: 'flat' }), 'flat');
  assert.equal(toolResultText({ type: 'tool_result', content: [] }), '');
});

test('object parts fall back through text/output/message before compact JSON', () => {
  assert.equal(toolResultText({ output: 'out' }), 'out');
  assert.equal(toolResultText({ message: 'msg' }), 'msg');
  assert.equal(toolResultText({ foo: 1 }), '{"foo":1}');
  assert.equal(toolResultText({}), '{}');
  assert.equal(toolResultText(null), '');
  assert.equal(toolResultText('plain'), 'plain');
});

test('part recursion stops at the depth cap', () => {
  assert.equal(toolResultText([[['x']]]), 'x');
  let deep = 'x';
  for (let level = 0; level < 20; level += 1) deep = [deep];
  assert.equal(toolResultText(deep), '');
});

test('collapsed details preserve explicit text and select the first nonblank result line', () => {
  assert.equal(toolAggregateDetailFallback('  summary  ', 'other result'), '  summary  ');
  assert.equal(toolAggregateDetailFallback('', '\ufeff \r\n\u00a0 result \t\r\nsecond line\n'), 'result');
});

test('collapsed fallback preserves empty values and its existing truncation boundary', () => {
  assert.equal(toolAggregateDetailFallback(null, '\ufeff \n\u00a0'), null);
  assert.equal(toolAggregateDetailFallback('', 'x'.repeat(80)), 'x'.repeat(80));
  assert.equal(toolAggregateDetailFallback('', 'x'.repeat(81)), `${'x'.repeat(77)}…`);
});
