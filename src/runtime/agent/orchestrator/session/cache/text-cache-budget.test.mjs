import assert from 'node:assert/strict';
import test from 'node:test';
import { setBoundedTextCacheEntry } from './text-cache-budget.mjs';

test('text caches enforce count and UTF-16 byte bounds with eviction callbacks', () => {
  const map = new Map();
  const evicted = [];
  const options = { maxEntries: 2, maxBytes: 16, onEvict: (key) => evicted.push(key) };
  const put = (key, content) => setBoundedTextCacheEntry(map, key, { content }, options);
  put('a', '가가');
  put('b', 'bb');
  put('c', 'cc');
  assert.deepEqual([...map.keys()], ['b', 'c']);
  assert.deepEqual(evicted, ['a']);
  put('b', 'bbbb');
  assert.deepEqual([...map.keys()], ['c', 'b']);
  put('d', 'dddd');
  assert.deepEqual([...map.keys()], ['d']);
  assert.deepEqual(evicted, ['a', 'b', 'c', 'b']);
});

test('an oversized replacement drops only its old value, not healthy entries', () => {
  const map = new Map();
  const options = { maxEntries: 2, maxBytes: 12 };
  setBoundedTextCacheEntry(map, 'a', { content: 'aa' }, options);
  setBoundedTextCacheEntry(map, 'b', { content: 'bb' }, options);
  assert.equal(setBoundedTextCacheEntry(map, 'a', { content: '123456' }, options), false);
  assert.deepEqual([...map.keys()], ['b']);
  assert.equal(setBoundedTextCacheEntry(map, 'c', { content: 'cc' }, options), true);
});
