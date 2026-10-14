import assert from 'node:assert/strict';
import test from 'node:test';

test('refreshing usage re-measures every account and changes nothing in the roster', async (t) => {
  const roster = { selectedId: 'a', accounts: [{ id: 'a' }, { id: 'b' }] };
  let updates = 0;
  t.mock.module(new URL('../services/provider-admin.mjs', import.meta.url).href, {
    namedExports: {
      listProviderAccounts: () => roster,
      materializeProviderAccounts: async () => roster,
      updateProviderAccounts: () => {
        updates += 1;
        return roster;
      },
    },
  });
  t.mock.module(new URL('../../runtime/agent/orchestrator/providers/registry.mjs', import.meta.url).href, {
    namedExports: { getProvider: () => ({ forAccount: (id) => ({ id }) }) },
  });
  const measured = [];
  t.mock.module(new URL('../../runtime/agent/orchestrator/providers/oauth-usage.mjs', import.meta.url).href, {
    namedExports: {
      fetchOAuthUsageSnapshot: async (target, provider, _log, options) => {
        measured.push([target.accountId, provider.id, options?.force]);
        return null;
      },
    },
  });
  const { createAccountApi } = await import('./accounts.mjs');
  let reloads = 0;
  const api = createAccountApi(
    {
      awaitKeychainPrewarm: async () => {},
      reloadFullConfig() {
        reloads += 1;
      },
      invalidateProviderCaches() {},
      warmProviderModelCache() {},
    },
    { releaseAdmissionCooldowns() {} }
  );
  assert.equal(await api.updateProviderAccounts('p', { refreshUsage: true }), roster);
  assert.deepEqual(measured, [
    ['a', 'a', true],
    ['b', 'b', true],
  ]);
  assert.equal(updates, 0);
  assert.equal(reloads, 0);
});
