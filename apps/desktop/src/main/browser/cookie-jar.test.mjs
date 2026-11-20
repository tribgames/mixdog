import assert from 'node:assert/strict';
import test from 'node:test';
import { cookiePartitionKey, createBrowserCookieJar, isBrowserInternalCookiePartition } from './cookie-jar.ts';

test('cookie reads release the idle helper without interrupting queued commands or changing partition', async (t) => {
  const partition = {};
  let opened = 0;
  let closed = 0;
  let unblock;
  const deferred = new Promise((resolve) => {
    unblock = resolve;
  });
  let commands = 0;
  class View {
    constructor({ webPreferences }) {
      assert.equal(webPreferences.session, partition);
      opened++;
      let destroyed = false;
      this.webContents = {
        session: partition,
        setWindowOpenHandler() {},
        async loadURL() {},
        isDestroyed: () => destroyed,
        close() {
          assert.equal(destroyed, false);
          destroyed = true;
          closed++;
        },
        debugger: {
          attach() {},
          async sendCommand() {
            if (++commands === 2) await deferred;
            assert.equal(destroyed, false);
            return { cookies: [] };
          },
        },
      };
    }
  }
  const jar = createBrowserCookieJar(partition, async () => View);
  t.after(() => {
    unblock();
    return jar.dispose();
  });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  await jar.get({});
  const second = jar.get({});
  await tick();
  assert.deepEqual([opened, closed], [1, 0]);
  unblock();
  await second;
  await tick();
  assert.deepEqual([opened, closed], [1, 1]);
  await jar.get({});
  await jar.dispose();
  await tick();
  assert.deepEqual([opened, closed], [2, 2]);
});

test('exact removal rejects a missing or empty path before opening a cookie target', async () => {
  let opened = 0;
  const jar = createBrowserCookieJar({}, async () => {
    opened++;
    throw new Error('unexpected target');
  });
  try {
    for (const scope of [{}, { path: '' }]) {
      await assert.rejects(jar.removeExact({ name: 'sid', domain: 'example.test', ...scope }), /requires a path/);
    }
    assert.equal(opened, 0);
  } finally {
    await jar.dispose();
  }
});

test('cookie partition validation preserves both identity components and rejects widening inputs', () => {
  for (const hasCrossSiteAncestor of [true, false]) {
    const key = { topLevelSite: 'https://example.test', hasCrossSiteAncestor };
    assert.deepEqual(cookiePartitionKey(key), key);
  }
  assert.equal(cookiePartitionKey(undefined), undefined);
  for (const value of [
    null,
    {},
    [],
    'https://example.test',
    { topLevelSite: 'https://example.test' },
    { topLevelSite: 'https://example.test', hasCrossSiteAncestor: 'false' },
    { topLevelSite: 'https://example.test/path', hasCrossSiteAncestor: true },
    { topLevelSite: 'https://user:private-token@example.test', hasCrossSiteAncestor: true },
    { topLevelSite: 'file:///private-token', hasCrossSiteAncestor: true },
  ]) {
    assert.throws(
      () => cookiePartitionKey(value),
      (error) => {
        assert.match(error.message, /partition identity is invalid/);
        assert.doesNotMatch(error.message, /private-token/);
        return true;
      }
    );
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
    'https://example.test',
    'chrome-extension://extension-id',
    'chrome://whats-new/extra',
    'chrome://user:secret@whats-new',
  ]) {
    assert.equal(isBrowserInternalCookiePartition({ topLevelSite, hasCrossSiteAncestor: true }), false);
  }
  assert.throws(
    () =>
      isBrowserInternalCookiePartition({
        topLevelSite: 'chrome://whats-new',
        hasCrossSiteAncestor: 'true',
      }),
    /partition identity is invalid/
  );
});
