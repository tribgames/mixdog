import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionRouteApi } from './routes.mjs';

test('getProviderSetup forwards its options (Unlock keyring / force / focus re-check) to the runtime', async () => {
  const seen = [];
  const api = createSessionRouteApi({
    runtime: {
      getProviderSetup: async (...args) => {
        seen.push(args);
        return { api: [] };
      },
    },
    getState: () => ({}),
    set() {},
  });
  await api.getProviderSetup({ force: true, unlockKeychain: true });
  await api.getProviderSetup({ recheckKeychain: true });
  await api.getProviderSetup();
  assert.deepEqual(seen, [[{ force: true, unlockKeychain: true }], [{ recheckKeychain: true }], [{}]]);
});