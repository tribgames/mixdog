import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContextMap, contextShares } from './context-inspection.mjs';

test('block allocation conserves cells and reports free space as the rest of the window', () => {
  assert.deepEqual(contextShares([1, 1, 1], 10), [4, 3, 3]);
  const map = buildContextMap([{ key: 'system', tokens: 100 }, { key: 'messages', tokens: 300 }], {
    windowTokens: 800, cells: 100,
  });
  assert.equal(map.cells.length, 100);
  assert.equal(map.cells.filter((key) => key === 'system').length, 13);
  assert.equal(map.cells.filter((key) => key === 'messages').length, 37);
  assert.equal(map.cells.filter((key) => key === 'free').length, 50);
  assert.equal(map.blockTokens, 8);
  assert.equal(map.overflow, false);
});

test('fit view magnifies occupied context without inventing usage and overflow stays explicit', () => {
  const map = buildContextMap([{ key: 'system', tokens: 10 }], { windowTokens: 1000, cells: 32, fit: true });
  assert.deepEqual(map.cells, Array(32).fill('system'));
  assert.equal(map.scaleTokens, 10);
  assert.equal(buildContextMap([{ key: 'messages', tokens: 200 }], { windowTokens: 100 }).overflow, true);
  assert.deepEqual(buildContextMap([], { fit: true }).cells, []);
});
