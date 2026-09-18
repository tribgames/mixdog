import assert from 'node:assert/strict';
import test from 'node:test';

import { clearBrowserData } from './browsing-data.ts';

function session(overrides = {}) {
  const calls = [];
  return {
    calls,
    clearCache: async () => {
      calls.push(['clearCache']);
      await overrides.cache?.();
    },
    clearCodeCaches: async (options) => {
      calls.push(['clearCodeCaches', options]);
    },
    clearStorageData: async (options) => {
      calls.push(['clearStorageData', options.storages]);
      await overrides.storage?.(options);
    },
  };
}

test('each scope clears exactly what it owns, and cookies never leave with site data', async () => {
  const target = session();
  const result = await clearBrowserData(target, ['cache', 'siteData']);

  assert.deepEqual(result.cleared, ['cache', 'siteData']);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(target.calls[0], ['clearCache']);
  // Compiled script caches survive clearCache; clearing them is part of cache.
  assert.deepEqual(target.calls[1], ['clearCodeCaches', { urls: [] }]);
  const [, storages] = target.calls[2];
  assert.equal(storages.includes('cookies'), false, 'site data must not sign the user out');
  assert.ok(storages.includes('localstorage') && storages.includes('indexdb'));

  const cookies = session();
  assert.deepEqual((await clearBrowserData(cookies, ['cookies'])).cleared, ['cookies']);
  assert.deepEqual(cookies.calls, [['clearStorageData', ['cookies']]]);
});

test('clearing cookies rewrites the sealed session store, and a store failure is not reported as cleared', async () => {
  const order = [];
  const target = session();
  const saved = await clearBrowserData(target, ['cookies'], {
    persistCookieState: async () => {
      order.push('persist');
    },
  });
  order.push('done');
  assert.deepEqual(saved.cleared, ['cookies']);
  // The sealed copy is rewritten before the scope counts as cleared; otherwise
  // the next restore signs the user back in.
  assert.deepEqual(order, ['persist', 'done']);

  const failing = await clearBrowserData(session(), ['cache', 'cookies'], {
    persistCookieState: async () => {
      throw new Error('session store is locked');
    },
  });
  assert.deepEqual(failing.cleared, ['cache']);
  assert.equal(failing.errors.cookies, 'session store is locked');
});

test('one failing scope is reported without stopping or faking the others', async () => {
  const target = session({
    cache: () => {
      throw new Error('cache directory is locked');
    },
  });
  const result = await clearBrowserData(target, ['cache', 'siteData', 'cookies', 'cache']);

  assert.deepEqual(result.cleared, ['siteData', 'cookies']);
  assert.equal(result.errors.cache, 'cache directory is locked');
  // The repeated scope runs once, so a retry cannot double-report success.
  assert.equal(target.calls.filter(([method]) => method === 'clearCache').length, 1);
});
