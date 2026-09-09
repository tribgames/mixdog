import assert from 'node:assert/strict';
import test from 'node:test';
import { cookiePartitionKey, isBrowserInternalCookiePartition } from './cookie-jar.ts';

test('cookie partition validation preserves both identity components and rejects widening inputs', () => {
  for (const hasCrossSiteAncestor of [true, false]) {
    const key = { topLevelSite: 'https://example.test', hasCrossSiteAncestor };
    assert.deepEqual(cookiePartitionKey(key), key);
  }
  assert.equal(cookiePartitionKey(undefined), undefined);
  for (const value of [
    null, {}, [], 'https://example.test',
    { topLevelSite: 'https://example.test' },
    { topLevelSite: 'https://example.test', hasCrossSiteAncestor: 'false' },
    { topLevelSite: 'https://example.test/path', hasCrossSiteAncestor: true },
    { topLevelSite: 'https://user:private-token@example.test', hasCrossSiteAncestor: true },
    { topLevelSite: 'file:///private-token', hasCrossSiteAncestor: true },
  ]) {
    assert.throws(() => cookiePartitionKey(value), (error) => {
      assert.match(error.message, /partition identity is invalid/);
      assert.doesNotMatch(error.message, /private-token/);
      return true;
    });
  }
});

test('only valid browser-internal partitions qualify for normal exclusion', () => {
  for (const topLevelSite of ['chrome://whats-new', 'chrome://settings', 'chrome-untrusted://new-tab-page']) {
    const key = { topLevelSite, hasCrossSiteAncestor: true };
    assert.equal(isBrowserInternalCookiePartition(key), true);
    assert.throws(() => cookiePartitionKey(key), /partition identity is invalid/);
  }
  assert.equal(isBrowserInternalCookiePartition(undefined), false);
  for (const topLevelSite of [
    'https://example.test', 'chrome-extension://extension-id',
    'chrome://whats-new/extra', 'chrome://user:secret@whats-new',
  ]) {
    assert.equal(isBrowserInternalCookiePartition({ topLevelSite, hasCrossSiteAncestor: true }), false);
  }
  assert.throws(() => isBrowserInternalCookiePartition({
    topLevelSite: 'chrome://whats-new', hasCrossSiteAncestor: 'true',
  }), /partition identity is invalid/);
});
