import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { feedByteRange, feedFilePath } from './dev-update-feed.mjs';

test('the dev feed serves only files inside its root, not a sibling that shares the prefix', () => {
  const root = resolve('feed-root', 'dist');
  assert.equal(feedFilePath(root, '/latest.yml'), join(root, 'latest.yml'));
  assert.equal(feedFilePath(root, '/nested/app.blockmap'), join(root, 'nested', 'app.blockmap'));
  assert.equal(feedFilePath(root, '/../dist2/secret.txt'), null);
  assert.equal(feedFilePath(root, '/..%2Fdist2%2Fsecret.txt'), null);
  assert.equal(feedFilePath(root, '/../../outside.txt'), null);
  assert.equal(feedFilePath(root, '/%E0%A4%A'), null);
});

test('the dev feed answers suffix ranges and clamps every range to the file', () => {
  assert.equal(feedByteRange(undefined, 100), null);
  assert.equal(feedByteRange('bytes=-', 100), null);
  assert.deepEqual(feedByteRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(feedByteRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(feedByteRange('bytes=90-500', 100), { start: 90, end: 99 });
  assert.deepEqual(feedByteRange('bytes=-30', 100), { start: 70, end: 99 });
  assert.deepEqual(feedByteRange('bytes=-500', 100), { start: 0, end: 99 });
  assert.equal(feedByteRange('bytes=-0', 100), 'unsatisfiable');
  assert.equal(feedByteRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(feedByteRange('bytes=20-10', 100), 'unsatisfiable');
  assert.equal(feedByteRange('bytes=0-', 0), 'unsatisfiable');
});
