import assert from 'node:assert/strict';
import test from 'node:test';

test('a failing usage sweep never becomes an unhandled rejection', async (t) => {
  t.mock.module(new URL('../services/provider-admin.mjs', import.meta.url).href, {
    namedExports: {
      listProviderAccounts: () => ({ accounts: [{ id: 'a' }] }),
      materializeProviderAccounts: async () => ({ accounts: [{ id: 'a' }] }),
      updateProviderAccounts: () => ({}),
    },
  });
  t.mock.module(new URL('../../runtime/agent/orchestrator/providers/registry.mjs', import.meta.url).href, {
    namedExports: { getProvider: () => ({ forAccount: () => ({}) }) },
  });
  t.mock.module(new URL('../../runtime/agent/orchestrator/providers/oauth-usage.mjs', import.meta.url).href, {
    namedExports: { fetchOAuthUsageSnapshot: async () => null },
  });
  const { createAccountApi } = await import('./accounts.mjs');
  const api = createAccountApi(
    {
      awaitKeychainPrewarm: async () => {
        throw new Error('keychain unavailable');
      },
      reloadFullConfig() {},
      invalidateProviderCaches() {},
      warmProviderModelCache() {},
    },
    () => {}
  );
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  api.getProviderAccounts('p');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(unhandled, []);
});
