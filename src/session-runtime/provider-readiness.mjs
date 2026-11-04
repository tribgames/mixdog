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
  // Whether this runtime has started its providers: a rebuild after a change
  // follows it, a failed initialization (whose gate is dropped) included.
  let providersStarted = false;
  // Advances whenever the init gates are cleared (a provider config or
  // credential change): an initialization registered before it is superseded
  // and never writes the shared registry.
  let providerInitGeneration = 0;

  function invalidateProviderCaches(options = {}) {
    // Auth/account/config changes alter what providers list: the process-wide
    // catalog (partial rows and retry backoffs included) starts a new epoch.
    invalidateSharedProviderCatalog();
    Object.assign(providerModelCaches, emptyModelCaches());
    providerModelCaches.providerModelsLoadSeq += 1;
    Object.assign(providerUsageCaches, emptyUsageCaches());
    if (options.preserveProviderInit !== true) {
      providerInitPromises.clear();
      providerInitGeneration += 1;
    }
    modelMetaByRoute.clear();
  }

  // A keyring unlocked after boot: every cache built while stored keys read as
  // absent (provider setup, init gates) is stale. The keychain module outlives
  // every runtime, so the listener (which holds this runtime and its caches)
  // is released by dispose().
  const unsubscribeKeychainRecovered = keychain.onKeychainRecovered?.(() => invalidateProviderCaches());

  /** Release the keychain subscription; the runtime's teardown calls it. Idempotent. */
  function dispose() {
    unsubscribeKeychainRecovered?.();
  }

  // The one edit a caller makes to the provider config it passes is turning a
  // route's provider on (ensureProviderEnabled); those providers, judged
  // against the runtime's config when the request was made.
  function forcedProviders(requested, base) {
    return Object.keys(requested || {}).filter(
      (name) => requested[name]?.enabled === true && base?.[name]?.enabled !== true
    );
  }

  // Waits for the keychain, then initializes the registry with
  // `providerConfig` unless a change superseded it meanwhile: a superseded
  // request is replayed on the latest config (with the providers it turned on),
  // so the latest config always wins.
  async function initializeProviders(providerConfig) {
    const generation = providerInitGeneration;
    const forced = forcedProviders(providerConfig, rt.config.providers);
    await awaitKeychainPrewarm();
    if (rt.closeRequested) throw new Error('runtime is closing');
    if (generation === providerInitGeneration) return getReg().initProviders(providerConfig);
    const latest = { ...(rt.config.providers || {}) };
    for (const name of forced) latest[name] = { ...(latest[name] || {}), enabled: true };
    return ensureProvidersReady(latest);
  }

  async function ensureProvidersReady(providerConfig = rt.config.providers || {}) {
    if (rt.closeRequested) throw new Error('runtime is closing');
    providersStarted = true;
    const initKey = providerInitCacheKey(providerConfig);
    // Provider initialization is idempotent for one normalized config. Keep
    // the fulfilled promise, not only the in-flight one: session resume used
    // to rerun registry/keychain setup on every click even though neither the
    // provider config nor the registry had changed. Auth/config mutations call
    // invalidateProviderCaches(), which clears this gate and preserves the
    // existing refresh semantics. Registered before any await, so a change
    // applied while it waits on the keychain sees (and supersedes) it.
    let providerInitPromise = providerInitPromises.get(initKey);
    if (!providerInitPromise) {
      providerInitPromise = initializeProviders(providerConfig);
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
        const settle = () => {
          if (!isLatest()) return;
          rt.startupProviderCatalogRefreshPending = false;
          rt.wakeDeferredWarmups();
        };
        void Promise.resolve(refresh)
          .then(() => {
            settle();
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
            settle();
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

  // Provider config or secrets changed: drop everything keyed to the old ones
  // and, when this runtime had initialized providers, rebuild the shared
  // registry from its reloaded config now, so no runtime's stale copy is the
  // last one to have initialized it. Rejects when that rebuild failed.
  function reinitProviders() {
    invalidateProviderCaches();
    if (!providersStarted || rt.closeRequested) return Promise.resolve();
    return ensureProvidersReady().catch((error) => {
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
