import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

// Replace the keychain provider before config.mjs loads it, so the wrappers in
// config.mjs and the setup api run against a recording fake.
const require = createRequire(import.meta.url);
const keychainPath = require.resolve('../../lib/keychain-cjs.cjs');
const calls = [];
let refreshResult = false;
require.cache[keychainPath] = {
  id: keychainPath,
  filename: keychainPath,
  loaded: true,
  exports: {
    keychainStatus: () => ({ state: 'ok', message: '' }),
    retryKeychain: async (options) => {
      calls.push(['retry', options]);
      return false;
    },
    refreshKeychainStatus: async (options) => {
      calls.push(['refresh', options]);
      return refreshResult;
    },
  },
};
const { createSetupApi } = await import('./setup.mjs');

function api() {
  const reloads = [];
  const setups = [];
  const setupApi = createSetupApi({
    awaitKeychainPrewarm: async () => {},
    isKeychainPrewarmReady: () => true,
    hasProviderSetupCached: () => true,
    reloadFullConfig: () => reloads.push(1),
    cachedProviderSetup: async (options) => {
      setups.push(options);
      return { api: [] };
    },
  });
  return { setupApi, reloads, setups };
}

test('Unlock keyring (unlockKeychain) reaches the keychain as an interactive retry', async () => {
  calls.length = 0;
  const { setupApi } = api();
  await setupApi.getProviderSetup({ force: true, unlockKeychain: true });
  assert.deepEqual(calls[0], ['retry', { interactive: true }]);
  calls.length = 0;
  await setupApi.getProviderSetup({});
  assert.deepEqual(calls[0], ['retry', { interactive: false }]);
});

test('a snapshot that changed the stored keys rebuilds the cached setup (the changed flag is not lost)', async () => {
  calls.length = 0;
  refreshResult = true;
  const { setupApi, reloads, setups } = api();
  await setupApi.getProviderSetup({});
  assert.equal(reloads.length, 1, 'config reloaded');
  assert.equal(setups.at(-1).force, true, 'setup rebuilt, not served from cache');
  refreshResult = false;
  await setupApi.getProviderSetup({});
  assert.equal(setups.at(-1).force, false);
});

test('window focus (recheckKeychain) skips the snapshot TTL; a plain read does not', async () => {
  calls.length = 0;
  const { setupApi } = api();
  await setupApi.getProviderSetup({ recheckKeychain: true });
  assert.deepEqual(calls.find((call) => call[0] === 'refresh'), ['refresh', { force: true }]);
  calls.length = 0;
  await setupApi.getProviderSetup({});
  assert.deepEqual(calls.find((call) => call[0] === 'refresh'), ['refresh', { force: false }]);
});