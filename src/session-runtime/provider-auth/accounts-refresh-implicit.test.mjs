import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-accounts-refresh-implicit-'));
process.env.MIXDOG_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

test('refreshing usage of an implicit signed-in account stores and returns its measurement', async (t) => {
  const provider = 'anthropic-oauth';
  const { writeJsonAtomicSync } = await import('../../runtime/shared/atomic-file.mjs');
  writeJsonAtomicSync(
    join(dir, 'anthropic-oauth-credentials.json'),
    {
      claudeAiOauth: {
        accessToken: 'access-default',
        refreshToken: 'refresh-default',
        expiresAt: Date.now() + 3600_000,
        scopes: ['user:inference', 'user:profile'],
      },
    },
    { mode: 0o600, secret: true }
  );
  const resetAt = Date.now() + 3_600_000;
  const { readProviderAccountPool, recordProviderAccountUsage } = await import(
    '../../runtime/shared/provider-accounts.mjs'
  );
  t.mock.module(new URL('../../runtime/agent/orchestrator/providers/registry.mjs', import.meta.url).href, {
    namedExports: { getProvider: () => ({ forAccount: (id) => ({ id }) }) },
  });
  // A successful measurement lands through the same store call the real
  // fetcher makes (oauth-usage.mjs records every contentful snapshot).
  t.mock.module(new URL('../../runtime/agent/orchestrator/providers/oauth-usage.mjs', import.meta.url).href, {
    namedExports: {
      readCachedOAuthUsageSnapshot: () => null,
      async fetchOAuthUsageSnapshot(target) {
        const snapshot = { quotaWindows: [{ label: '5H', usedPct: 42, resetAt }] };
        await recordProviderAccountUsage(target.provider, target.accountId, snapshot);
        return snapshot;
      },
    },
  });
  const { createAccountApi } = await import('./accounts.mjs');
  assert.equal(readProviderAccountPool(provider).accounts.length, 0, 'the account starts implicit');
  const api = createAccountApi(
    {
      awaitKeychainPrewarm: async () => {},
      reloadFullConfig() {},
      invalidateProviderCaches() {},
      warmProviderModelCache() {},
    },
    { releaseAdmissionCooldowns() {} }
  );
  const roster = await api.updateProviderAccounts(provider, { refreshUsage: true });
  assert.deepEqual(
    roster.accounts.map((row) => row.id),
    ['default']
  );
  assert.equal(roster.accounts[0].usage?.windows?.[0]?.usedPct, 42);
});
