import assert from 'node:assert/strict';
import test from 'node:test';
import { retainRecordKeys } from './studio-pane-thumbnails.ts';

test('retaining keeps only the assets still present and the same object when nothing leaves', () => {
  const thumbs = { a: 'data:a', b: 'data:b' };
  assert.equal(retainRecordKeys(thumbs, () => true), thumbs);
  assert.deepEqual(retainRecordKeys(thumbs, (id) => id === 'b'), { b: 'data:b' });
  assert.deepEqual(retainRecordKeys(thumbs, () => false), {});
});
