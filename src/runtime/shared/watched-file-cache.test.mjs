import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWatchedFileCache } from './watched-file-cache.mjs';
import { trackWatchers } from './watched-file-cache.test-helpers.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-watched-cache-'));
  const cache = createWatchedFileCache((path) => ({ stamp: 'x', value: readFileSync(path, 'utf8') }));
  t.after(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const file = (name, text) => {
    writeFileSync(join(dir, name), text);
    return join(dir, name);
  };
  return { dir, cache, file };
}

test('a directory watch is shared by its entries and closes with the last of them', (t) => {
  const watching = trackWatchers(t);
  const { dir, cache, file } = fixture(t);
  const a = file('a.json', 'A');
  const b = file('b.json', 'B');
  assert.equal(cache.get(a), 'A');
  cache.set(b, 'B2');
  assert.deepEqual(watching(), [dir], 'one watcher for the directory');
  cache.delete(a);
  assert.deepEqual(watching(), [dir], 'still held by the other entry');
  cache.delete(b);
  assert.deepEqual(watching(), [], 'released with its last entry');
});

test('closing a cache releases its watchers, and later reads leave none behind', (t) => {
  const watching = trackWatchers(t);
  const { cache, file } = fixture(t);
  const a = file('a.json', 'A');
  cache.get(a);
  cache.close();
  assert.deepEqual(watching(), []);
  file('a.json', 'A2');
  assert.equal(cache.get(a), 'A2', 'a closed cache reads the disk');
  assert.deepEqual(watching(), []);
});
