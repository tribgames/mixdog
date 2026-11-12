// Provider readiness for the session runtime: the keychain prewarm gate, the
// runtime's requests to the process-global provider registry, and the
// model/usage caches that auth or config mutations invalidate together.
// The registry's provider set is owned by the config of record — the full,
// secrets-aware config (ensureFullConfig) and its stored provider decisions —
// never by the view a caller happens to hold: ensureProvidersReady asks the
// registry to register what the record enables plus the providers the caller
// requested (additive), and a config change syncs the registry to the record
// (rebuilds and stored-decision removals).
// `reg`, `warmProviderModelCache`, `ensureFullConfig` and the stored providers
// are late-bound getters because they resolve after this gate is created.
import {
  builtinProviderKeyAccounts,
  customProviderKeyAccounts,
} from '../runtime/agent/orchestrator/config-providers-merge.mjs';
import { bootProfile } from './boot-profile.mjs';
import { invalidateSharedProviderCatalog } from './provider-catalog-cache.mjs';

const KEYCHAIN_PREWARM_WAIT_MS = 5000;

// Empty cache fields. Invalidation assigns them onto the caller-held objects,
// so every holder of those references sees the reset.
const emptyModelCaches = () => ({
  providerModelsCache: { models: null, at: 0 },
  providerModelsPromise: null,
  webSearchProviderModelsCache: { models: null, at: 0 },
});
const emptyUsageCaches = () => ({
  usageDashboardCache: { dashboard: null, at: 0 },
  usageDashboardPromise: null,
  providerSetupCache: { setup: null, at: 0 },
  providerSetupQuickCache: { setup: null, at: 0 },
  providerSetupPromise: null,
});

export function createProviderReadiness({
  rt,
  keychain,
  getReg,
  getWarmProviderModelCache,
  getEnsureFullConfig,
  getStoredProviders,
}) {
  const keychainPrewarmPromise = keychain.prewarmSecrets(builtinProviderKeyAccounts());
  rt.keychainPrewarmWaitDone = false;
  rt.keychainPrewarmWaitPromise = null;
  async function untilDeadline(promise) {
    let timeoutId;
    const deadline = new Promise((resolveDeadline) => {
      timeoutId = setTimeout(resolveDeadline, KEYCHAIN_PREWARM_WAIT_MS);
      timeoutId.unref?.();
    });
    try {
      await Promise.race([promise, deadline]);
    } finally {
      clearTimeout(timeoutId);
    }
  }
  function awaitKeychainPrewarm() {
    if (rt.keychainPrewarmWaitDone) return Promise.resolve();
    rt.keychainPrewarmWaitPromise ??= untilDeadline(keychainPrewarmPromise).finally(() => {
      rt.keychainPrewarmWaitDone = true;
    });
    return rt.keychainPrewarmWaitPromise;
  }

  const modelMetaByRoute = new Map();
  const providerModelCaches = { ...emptyModelCaches(), providerModelsLoadSeq: 0 };
  const providerUsageCaches = emptyUsageCaches();

  function invalidateProviderCaches() {
    // Auth/account/config changes alter what providers list: the process-wide
    // catalog (partial rows and retry backoffs included) starts a new epoch.
    invalidateSharedProviderCatalog();
    Object.assign(providerModelCaches, emptyModelCaches());
    providerModelCaches.providerModelsLoadSeq += 1;
    Object.assign(providerUsageCaches, emptyUsageCaches());
    modelMetaByRoute.clear();
  }

  // A keyring unlocked after boot: every cache built while stored keys read as
  // absent (provider setup, model rows) is stale. The keychain module outlives
  // every runtime, so the listener (which holds this runtime and its caches)
  // is released by dispose().
  const unsubscribeKeychainRecovered = keychain.onKeychainRecovered?.(() => invalidateProviderCaches());

  /** Release the keychain subscription; the runtime's teardown calls it. Idempotent. */
  function dispose() {
    unsubscribeKeychainRecovered?.();
  }

  // The config of record: the runtime's full, secrets-aware config, read after
  // the keychain warm (an injected config is its own record).
  function providerRecord() {
    return getEnsureFullConfig()().providers || {};
  }

  /** Ensure the providers the record enables, and every provider
   *  `providerConfig` enables (a route's provider turned on with
   *  ensureProviderEnabled), are registered. Additive: it never replaces or
   *  removes a registered provider. Each call asks the registry again — a
   *  registered provider answers at once — so it never reports ready from an
   *  earlier answer while a requested provider has since left the registry. */
  async function ensureProvidersReady(providerConfig = {}) {
    if (rt.closeRequested) throw new Error('runtime is closing');
    const requested = Object.keys(providerConfig).filter((name) => providerConfig[name]?.enabled === true);
    // The built-in warm plus the configured custom providers' keys, warmed per
    // account the same way so the first send reads them from the cache: one
    // wait under one deadline (the account reads themselves run one at a time).
    await untilDeadline(
      Promise.all([keychainPrewarmPromise, keychain.prewarmSecrets(customProviderKeyAccounts(providerConfig))])
    );
    if (rt.closeRequested) throw new Error('runtime is closing');
    // Read after the wait: a change applied meanwhile is what gets registered.
    const desired = { ...providerRecord() };
    for (const name of requested) {
      if (desired[name]?.enabled !== true) desired[name] = { ...(desired[name] || {}), enabled: true };
    }
    const result = await getReg().initProviders(desired);
    if (!rt.closeRequested) observeStartupCatalogRefresh();
    return result;
  }

  // Attach this runtime's completion handling to the registry's boot catalog
  // refresh. The registry memoizes it and opens a new epoch only for a provider
  // added or rebuilt; each new promise gets its own completion handling.
  function observeStartupCatalogRefresh() {
    try {
      const refresh = getReg().refreshProviderCatalogsOnStartup();
      if (refresh === rt.startupProviderCatalogRefreshObserved) return;
      rt.startupProviderCatalogRefreshObserved = refresh;
      rt.startupProviderCatalogRefreshPending = true;
      const isLatest = () => rt.startupProviderCatalogRefreshObserved === refresh;
      const settle = () => {
        if (!isLatest()) return;
        rt.startupProviderCatalogRefreshPending = false;
        rt.wakeDeferredWarmups();
      };
      void Promise.resolve(refresh)
        .then(() => {
          settle();
          if (rt.closeRequested) return;
          // Fresh catalog rows invalidate model-derived caches.
          invalidateProviderCaches();
          // Secrets-aware: a no-secrets rewarm bumps the load sequence and
          // is never adopted, so it discarded the in-flight authoritative
          // load and left the picker cache empty — every later consumer then
          // paid a full catalog load (measured ~560ms each).
          getWarmProviderModelCache()({ loadSecrets: true });
          bootProfile('provider-catalogs:refresh-ready');
        })
        .catch((error) => {
          settle();
          bootProfile('provider-catalogs:refresh-failed', { error: error?.message || String(error) });
        });
      bootProfile('provider-catalogs:refresh-started');
    } catch (error) {
      rt.startupProviderCatalogRefreshPending = false;
      bootProfile('provider-catalogs:refresh-failed', { error: error?.message || String(error) });
    }
  }

  // Provider config or secrets changed: drop everything keyed to the old ones
  // and sync the shared registry to the reloaded record — registered providers
  // whose config changed are rebuilt, the ones a stored decision turned off
  // (disable, logout, a deleted custom provider) removed. Every runtime of the
  // process runs it on the same record; it never registers a provider no one
  // asked for. Rejects when that sync failed.
  function reinitProviders() {
    invalidateProviderCaches();
    if (rt.closeRequested) return Promise.resolve();
    return Promise.resolve()
      .then(() => getReg().syncProviders(providerRecord(), { decisions: getStoredProviders() }))
      .catch((error) => {
        bootProfile('providers:reinit-failed', { error: error?.message || String(error) });
        throw error;
      });
  }

  return {
    awaitKeychainPrewarm,
    invalidateProviderCaches,
    reinitProviders,
    ensureProvidersReady,
    dispose,
    modelMetaByRoute,
    providerModelCaches,
    providerUsageCaches,
  };
}
