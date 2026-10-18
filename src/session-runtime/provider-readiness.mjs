// Provider readiness for the session runtime: the keychain prewarm gate, the
// provider-init single-flight keyed by normalized provider config, and the
// model/usage caches that auth or config mutations invalidate together.
// `reg` and `warmProviderModelCache` are late-bound getters because the
// registry import and the provider-models factory resolve after this gate is
// created, while ensureProvidersReady only reaches them on demand.
import { bootProfile } from './boot-profile.mjs';
import { invalidateSharedProviderCatalog } from './provider-catalog-cache.mjs';
import { providerInitCacheKey } from './provider-init-key.mjs';

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

export function createProviderReadiness({ rt, keychain, getReg, getWarmProviderModelCache }) {
  const keychainPrewarmPromise = keychain.prewarmSecrets();
  rt.keychainPrewarmWaitDone = false;
  rt.keychainPrewarmWaitPromise = null;
  function awaitKeychainPrewarm() {
    if (rt.keychainPrewarmWaitDone) return Promise.resolve();
    rt.keychainPrewarmWaitPromise ??= (async () => {
      let timeoutId;
      const deadline = new Promise((resolveDeadline) => {
        timeoutId = setTimeout(resolveDeadline, KEYCHAIN_PREWARM_WAIT_MS);
        timeoutId.unref?.();
      });
      try {
        await Promise.race([keychainPrewarmPromise, deadline]);
      } finally {
        clearTimeout(timeoutId);
        rt.keychainPrewarmWaitDone = true;
      }
    })();
    return rt.keychainPrewarmWaitPromise;
  }

  const modelMetaByRoute = new Map();
  const providerModelCaches = { ...emptyModelCaches(), providerModelsLoadSeq: 0 };
  const providerUsageCaches = emptyUsageCaches();
  const providerInitPromises = new Map();

  function invalidateProviderCaches(options = {}) {
    // Auth/account/config changes alter what providers list: the process-wide
    // catalog (partial rows and retry backoffs included) starts a new epoch.
    invalidateSharedProviderCatalog();
    Object.assign(providerModelCaches, emptyModelCaches());
    providerModelCaches.providerModelsLoadSeq += 1;
    Object.assign(providerUsageCaches, emptyUsageCaches());
    if (options.preserveProviderInit !== true) providerInitPromises.clear();
    modelMetaByRoute.clear();
  }

  // A keyring unlocked after boot: every cache built while stored keys read as
  // absent (provider setup, init gates) is stale.
  keychain.onKeychainRecovered?.(() => invalidateProviderCaches());

  async function ensureProvidersReady(providerConfig = rt.config.providers || {}) {
    await awaitKeychainPrewarm();
    if (rt.closeRequested) throw new Error('runtime is closing');
    const initKey = providerInitCacheKey(providerConfig);
    // Provider initialization is idempotent for one normalized config. Keep
    // the fulfilled promise, not only the in-flight one: session resume used
    // to rerun registry/keychain setup on every click even though neither the
    // provider config nor the registry had changed. Auth/config mutations call
    // invalidateProviderCaches(), which clears this gate and preserves the
    // existing refresh semantics.
    let providerInitPromise = providerInitPromises.get(initKey);
    if (!providerInitPromise) {
      providerInitPromise = Promise.resolve().then(() => getReg().initProviders(providerConfig));
      providerInitPromises.set(initKey, providerInitPromise);
    }
    let result;
    try {
      result = await providerInitPromise;
    } catch (error) {
      if (providerInitPromises.get(initKey) === providerInitPromise) providerInitPromises.delete(initKey);
      throw error;
    }
    if (!rt.closeRequested) {
      try {
        // The registry memoizes the refresh per catalog epoch; a provider set
        // change yields a new promise, which gets its own completion handling.
        const refresh = getReg().refreshProviderCatalogsOnStartup();
        if (refresh === rt.startupProviderCatalogRefreshObserved) return result;
        rt.startupProviderCatalogRefreshObserved = refresh;
        rt.startupProviderCatalogRefreshPending = true;
        const isLatest = () => rt.startupProviderCatalogRefreshObserved === refresh;
        void Promise.resolve(refresh)
          .then(() => {
            if (isLatest()) rt.startupProviderCatalogRefreshPending = false;
            if (rt.closeRequested) return;
            // Fresh catalog rows invalidate model-derived caches, but the
            // already initialized provider registry remains valid.
            invalidateProviderCaches({ preserveProviderInit: true });
            // Secrets-aware: a no-secrets rewarm bumps the load sequence and
            // is never adopted, so it discarded the in-flight authoritative
            // load and left the picker cache empty — every later consumer then
            // paid a full catalog load (measured ~560ms each).
            getWarmProviderModelCache()({ loadSecrets: true });
            bootProfile('provider-catalogs:refresh-ready');
          })
          .catch((error) => {
            if (isLatest()) rt.startupProviderCatalogRefreshPending = false;
            bootProfile('provider-catalogs:refresh-failed', { error: error?.message || String(error) });
          });
        bootProfile('provider-catalogs:refresh-started');
      } catch (error) {
        rt.startupProviderCatalogRefreshPending = false;
        bootProfile('provider-catalogs:refresh-failed', { error: error?.message || String(error) });
      }
    }
    return result;
  }

  return {
    awaitKeychainPrewarm,
    invalidateProviderCaches,
    ensureProvidersReady,
    modelMetaByRoute,
    providerModelCaches,
    providerUsageCaches,
  };
}
