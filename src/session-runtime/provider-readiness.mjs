// Provider readiness for the session runtime: the keychain prewarm gate, the
// provider-init single-flight keyed by normalized provider config, and the
// model/usage caches that auth or config mutations invalidate together.
// `reg` and `warmProviderModelCache` are late-bound getters because the
// registry import and the provider-models factory resolve after this gate is
// created, while ensureProvidersReady only reaches them on demand.
import { bootProfile } from './boot-profile.mjs';
import { providerInitCacheKey } from './provider-init-key.mjs';

const KEYCHAIN_PREWARM_WAIT_MS = 5000;

export function createProviderReadiness({
  rt,
  keychain,
  getReg,
  getWarmProviderModelCache,
}) {
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
    // Invoked here: the assignment used to store the async FUNCTION, so every
    // `await awaitKeychainPrewarm()` resolved instantly (awaiting a function is
    // a no-op) and callers silently skipped the wait they asked for.
    })();
    return rt.keychainPrewarmWaitPromise;
  }

  const modelMetaByRoute = new Map();
  const providerModelCaches = {
    providerModelsCache: { models: null, at: 0 },
    providerModelsPromise: null,
    providerModelsLoadSeq: 0,
    webSearchProviderModelsCache: { models: null, at: 0 },
  };
  const providerUsageCaches = {
    usageDashboardCache: { dashboard: null, at: 0 },
    usageDashboardPromise: null,
    providerSetupCache: { setup: null, at: 0 },
    providerSetupQuickCache: { setup: null, at: 0 },
    providerSetupPromise: null,
  };
  const providerInitPromises = new Map();

  function invalidateProviderCaches(options = {}) {
    providerModelCaches.providerModelsCache = { models: null, at: 0 };
    providerModelCaches.providerModelsPromise = null;
    providerModelCaches.providerModelsLoadSeq += 1;
    providerModelCaches.webSearchProviderModelsCache = { models: null, at: 0 };
    providerUsageCaches.usageDashboardCache = { dashboard: null, at: 0 };
    providerUsageCaches.usageDashboardPromise = null;
    providerUsageCaches.providerSetupCache = { setup: null, at: 0 };
    providerUsageCaches.providerSetupQuickCache = { setup: null, at: 0 };
    providerUsageCaches.providerSetupPromise = null;
    if (options.preserveProviderInit !== true) providerInitPromises.clear();
    modelMetaByRoute.clear();
  }

  async function ensureProvidersReady(providerConfig = rt.config.providers || {}) {
    await awaitKeychainPrewarm();
    const initKey = providerInitCacheKey(providerConfig);
    const existing = providerInitPromises.get(initKey);
    if (existing) return await existing;
    // Provider initialization is idempotent for one normalized config. Keep
    // the fulfilled promise, not only the in-flight one: session resume used
    // to rerun registry/keychain setup on every click even though neither the
    // provider config nor the registry had changed. Auth/config mutations call
    // invalidateProviderCaches(), which clears this gate and preserves the
    // existing refresh semantics.
    const providerInitPromise = Promise.resolve().then(() => getReg().initProviders(providerConfig));
    providerInitPromises.set(initKey, providerInitPromise);
    let result;
    try {
      result = await providerInitPromise;
    } catch (error) {
      if (providerInitPromises.get(initKey) === providerInitPromise) providerInitPromises.delete(initKey);
      throw error;
    }
    if (!rt.startupProviderCatalogRefreshStarted && !rt.closeRequested) {
      rt.startupProviderCatalogRefreshStarted = true;
      rt.startupProviderCatalogRefreshPending = true;
      try {
        void Promise.resolve(getReg().refreshProviderCatalogsOnStartup())
          .then(() => {
            // Fresh catalog rows invalidate model-derived caches, but the
            // already initialized provider registry remains valid.
            invalidateProviderCaches({ preserveProviderInit: true });
            rt.startupProviderCatalogRefreshPending = false;
            // Secrets-aware: a no-secrets rewarm bumps the load sequence and
            // is never adopted, so it discarded the in-flight authoritative
            // load and left the picker cache empty — every later consumer then
            // paid a full catalog load (measured ~560ms each).
            getWarmProviderModelCache()({ loadSecrets: true });
            bootProfile('provider-catalogs:refresh-ready');
          })
          .catch((error) => {
            rt.startupProviderCatalogRefreshPending = false;
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
    providerInitPromises,
  };
}
