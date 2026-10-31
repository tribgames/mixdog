import assert from 'node:assert/strict';
import test from 'node:test';
import { cachedFolderBytes, forgetFolderSize } from './disk.mjs';

test('worktree sizes: measured once, served from the cache, refreshed in the background after the TTL', async () => {
  const path = '/virtual/worktree-size-cache';
  forgetFolderSize(path);
  let walks = 0;
  let bytes = 100;
  const measure = async () => {
    walks += 1;
    return { bytes, complete: true };
  };
  assert.equal((await cachedFolderBytes(path, { measure })).bytes, 100);
  assert.equal(walks, 1);
  // Fresh: no walk at all.
  bytes = 200;
  assert.equal((await cachedFolderBytes(path, { measure })).bytes, 100);
  assert.equal(walks, 1);
  // Stale (TTL 0): the cached value at once, one walk in the background.
  assert.equal((await cachedFolderBytes(path, { measure, ttlMs: 0 })).bytes, 100);
  assert.equal(walks, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await cachedFolderBytes(path, { measure })).bytes, 200, 'the refreshed size');
  assert.equal(walks, 2);
  // A removed (or re-created) worktree is measured again.
  forgetFolderSize(path);
  bytes = 5;
  assert.equal((await cachedFolderBytes(path, { measure })).bytes, 5);
  assert.equal(walks, 3);
  forgetFolderSize(path);
});

test('size-cache keys fold case only where the filesystem does (win32)', async () => {
  const measureAs = (bytes) => async () => ({ bytes, complete: true });
  const [upper, lower] = ['/virtual/case/Fix', '/virtual/case/fix'];
  for (const platform of ['linux', 'win32']) {
    forgetFolderSize(upper, platform);
    forgetFolderSize(lower, platform);
  }
  // Case-sensitive: two folders, two measurements; forgetting one keeps the other.
  assert.equal((await cachedFolderBytes(upper, { platform: 'linux', measure: measureAs(1) })).bytes, 1);
  assert.equal((await cachedFolderBytes(lower, { platform: 'linux', measure: measureAs(2) })).bytes, 2);
  forgetFolderSize(lower, 'linux');
  assert.equal((await cachedFolderBytes(upper, { platform: 'linux', measure: measureAs(9) })).bytes, 1);
  // Windows: the same folder.
  assert.equal((await cachedFolderBytes(upper, { platform: 'win32', measure: measureAs(3) })).bytes, 3);
  assert.equal((await cachedFolderBytes(lower, { platform: 'win32', measure: measureAs(4) })).bytes, 3);
  forgetFolderSize(lower, 'win32');
  assert.equal((await cachedFolderBytes(upper, { platform: 'win32', measure: measureAs(5) })).bytes, 5);
  forgetFolderSize(upper, 'linux');
  forgetFolderSize(upper, 'win32');
});
