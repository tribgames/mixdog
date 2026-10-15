// provider-auth/accounts.mjs — the per-provider account roster and account
// switching, with the bounded background usage sweep that refreshes quotas.
import {
  listProviderAccounts,
  materializeProviderAccounts,
  updateProviderAccounts,
} from '../services/provider-admin.mjs';
import { getProvider } from '../../runtime/agent/orchestrator/providers/registry.mjs';
import { fetchOAuthUsageSnapshot } from '../../runtime/agent/orchestrator/providers/oauth-usage.mjs';

export function createAccountApi(
  { awaitKeychainPrewarm, reloadFullConfig, invalidateProviderCaches, warmProviderModelCache },
  refresh
) {
  // One in-flight usage sweep per provider; a reopened picker reuses it.
  const accountUsageSweeps = new Map();

  async function measureAccountUsage(providerId, provider, accounts, force = false) {
    await awaitKeychainPrewarm();
    for (let offset = 0; offset < accounts.length; offset += 4) {
      await Promise.all(
        accounts.slice(offset, offset + 4).map((account) => {
          const target = { provider: providerId, accountId: account.id };
          return fetchOAuthUsageSnapshot(target, provider.forAccount(account.id), () => {}, { force }).catch(
            () => null
          );
        })
      );
    }
  }

  async function sweepAccountUsage(providerId, provider, accounts) {
    try {
      await measureAccountUsage(providerId, provider, accounts);
    } finally {
      accountUsageSweeps.delete(providerId);
    }
  }

  // Switching the selected account makes every later request use a different
  // credential, so its quota is fetched RIGHT AWAY instead of when the surface
  // next asks. The fetch is keyed by provider+account, so the dashboard refresh
  // the picker starts next joins this one rather than queueing behind it.
  function prefetchSelectedAccountUsage(providerId, accountId) {
    if (!accountId) return;
    const provider = getProvider(providerId);
    if (typeof provider?.forAccount !== 'function') return;
    void fetchOAuthUsageSnapshot(
      { provider: providerId, model: '', accountId },
      provider.forAccount(accountId),
      () => {},
      { force: true }
    ).catch(() => {
      /* usage display must not affect the switch itself */
    });
  }

  return {
    // The account roster is a local file read: it must paint the moment the
    // picker opens. The roster never blocks on the keychain or on live quota
    // fetches; the persisted per-account usage
    // is returned as-is and a bounded background sweep refreshes it, which
    // lands in the next read.
    getProviderAccounts(providerId) {
      const pool = listProviderAccounts(providerId);
      const provider = getProvider(providerId);
      if (provider?.forAccount && !accountUsageSweeps.has(providerId)) {
        accountUsageSweeps.set(
          providerId,
          sweepAccountUsage(providerId, provider, pool.accounts).catch(() => {
            /* usage sweep is best-effort */
          })
        );
      }
      return pool;
    },
    async updateProviderAccounts(providerId, change) {
      // `{ refreshUsage: true }` re-measures every account now (the roster's
      // "Refresh usage") and changes nothing else in the roster. The implicit
      // signed-in account is stored first so its measurement has a row to land on.
      if (change?.refreshUsage === true && Object.keys(change).length === 1) {
        const provider = getProvider(providerId);
        if (typeof provider?.forAccount === 'function') {
          await awaitKeychainPrewarm();
          const { accounts } = await materializeProviderAccounts(providerId);
          await measureAccountUsage(providerId, provider, accounts, true);
        }
        return listProviderAccounts(providerId);
      }
      await awaitKeychainPrewarm();
      const result = await updateProviderAccounts(providerId, change);
      reloadFullConfig();
      invalidateProviderCaches();
      warmProviderModelCache();
      if (change?.selectedId !== undefined) {
        refresh.releaseAdmissionCooldowns();
        prefetchSelectedAccountUsage(providerId, result.selectedId);
      }
      return result;
    },
  };
}
