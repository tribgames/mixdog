import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapText } from './pdf-draw.mjs';

test('PDF wrapping keeps supplementary characters and lone surrogates intact', () => {
  const font = { widthOfTextAtSize: (text, size) => [...text].length * size };
  assert.deepEqual(wrapText('A😀B𠀀C', font, 10, 20), ['A😀', 'B𠀀', 'C']);
  assert.deepEqual(wrapText('a\uD800b', font, 10, 20), ['a\uD800', 'b']);
});
