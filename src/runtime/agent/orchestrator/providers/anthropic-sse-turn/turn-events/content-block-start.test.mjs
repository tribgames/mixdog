import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentBlockStart } from './content-block-start.mjs';

function start(block) {
  const kinds = [];
  const thinking = new Map();
  const blocks = { thinking, appendText() {}, appendCitation() {}, nativeServerTool: new Map(), pendingToolInputs: new Map(), pendingNativeToolInputs: new Map() };
  const turn = { fallbackEvents: [], contentBlockTypes: new Set() };
  createContentBlockStart({ turn, blocks, state: {}, progress: (kind) => kinds.push(kind), seedText() {} })(0, block);
  return kinds;
}

test('a thinking block opening reports reasoning progress before any delta streams', () => {
  assert.deepEqual(start({ type: 'thinking', thinking: '' }), ['reasoning']);
});

test('a redacted thinking block opening reports reasoning progress', () => {
  assert.deepEqual(start({ type: 'redacted_thinking', data: 'x' }), ['reasoning']);
});
