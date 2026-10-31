import '../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCredentialCache } from './oauth-credentials.mjs';

test('a token refresh is stored without a settings change; sign-in and sign-out are announced', async () => {
  const stored = new Map();
  const writes = [];
  const credentialStore = {
    getSecretAsync: async (account) => stored.get(account) ?? null,
    setSecretAsync: async (account, value, { announce = true } = {}) => {
      stored.set(account, value);
      writes.push(['set', announce]);
    },
    deleteSecretAsync: async (account, { announce = true } = {}) => {
      stored.delete(account);
      writes.push(['delete', announce]);
    },
  };
  const cache = createCredentialCache({
    url: 'https://mcp.example.test/mcp',
    credentialStore,
    account: 'mcp-oauth.refresh-test',
  });
  await cache.ready();
  const { creds } = cache;
  await cache.update(() => {
    creds.clientInformation = { client_id: 'registered' };
  });
  await cache.update(() => {
    creds.tokens = { access_token: 'first', refresh_token: 'r1' };
  });
  await cache.update(() => {
    creds.tokens = { access_token: 'refreshed', refresh_token: 'r2' };
  });
  await cache.update(
    () => {
      creds.tokens = undefined;
    },
    { remove: true }
  );
  assert.deepEqual(writes, [
    ['set', false], // a client registration alone signs nothing in
    ['set', true], // sign-in
    ['set', false], // refresh: other processes follow its revision marker
    ['delete', true], // sign-out
  ]);
});
