// provider-auth/refresh.mjs — what the runtime refreshes after credentials
// change: config reload, provider caches, admission cooldowns and catalogs.
import { resetProviderAdmissionCooldowns } from '../../runtime/agent/orchestrator/providers/admission-scheduler.mjs';

export function createAuthRefresh({
  reloadFullConfig,
  invalidateProviderCaches,
  warmProviderModelCache,
  refreshProviderCatalogs,
}) {
  function refreshProviderCatalogsSoon() {
    if (typeof refreshProviderCatalogs !== 'function') return;
    try {
      void Promise.resolve(refreshProviderCatalogs({ force: true }))
        .then(() => {
          invalidateProviderCaches();
          warmProviderModelCache();
        })
        .catch(() => {});
    } catch {
      /* best-effort */
    }
  }

  // Auth mutation = the user changed credentials (re-login / account switch /
  // new key). Any admission-lane rate-limit cooldown belongs to the OLD
  // credentials, so release it immediately — otherwise a quota cooldown from
  // the previous account silently blocks the fresh account until restart.
  function releaseAdmissionCooldowns() {
    try {
      resetProviderAdmissionCooldowns();
    } catch {
      /* best-effort */
    }
  }

  /** New credentials are live: drop everything keyed to the old ones. */
  function adoptCredentials() {
    invalidateProviderCaches();
    releaseAdmissionCooldowns();
    refreshProviderCatalogsSoon();
    warmProviderModelCache();
  }

  function afterCredentialChange() {
    reloadFullConfig();
    adoptCredentials();
  }

  /** Usage-dashboard credentials affect no admission lane or catalog. */
  function afterUsageAuthChange() {
    reloadFullConfig();
    invalidateProviderCaches();
  }

  return { releaseAdmissionCooldowns, adoptCredentials, afterCredentialChange, afterUsageAuthChange };
}
