import {
  beginOAuthProviderLogin,
  forgetProviderAuth,
  isKnownProvider,
  loginOAuthProvider,
  renderProviderStatus,
  saveOpenAIUsageSessionKey,
  saveOpenCodeGoUsageAuth,
  loginOpenCodeGoUsage,
  saveProviderApiKey,
  setLocalProvider,
} from '../standalone/provider-admin.mjs';
import { clean } from './session-text.mjs';

// Provider auth / catalog / preset surface. Extracted verbatim from the runtime
// API object; the stateless admin helpers are imported directly and the runtime
// injects the closure-owned config/cache callbacks. `isKnownProvider` is
// re-imported here from provider-admin (same binding the runtime uses).
export function createProviderAuthApi({
  cfgMod,
  getConfig,
  saveConfigAndAdopt,
  displayConfig,
  reloadFullConfig,
  awaitKeychainPrewarm,
  invalidateProviderCaches,
  warmProviderModelCache,
  refreshProviderCatalogs,
  cachedProviderSetup,
  getUsageDashboard,
  collectProviderModels,
}) {
  function refreshProviderCatalogsSoon() {
    if (typeof refreshProviderCatalogs !== 'function') return;
    try {
      void Promise.resolve(refreshProviderCatalogs())
        .then(() => {
          invalidateProviderCaches();
          warmProviderModelCache();
        })
        .catch(() => {});
    } catch { /* best-effort */ }
  }

  return {
    listProviders() {
      return renderProviderStatus(displayConfig());
    },
    async getProviderSetup() {
      return await cachedProviderSetup();
    },
    async getUsageDashboard(options = {}) {
      return await getUsageDashboard(options);
    },
    async authenticateProvider(providerId, secret) {
      await awaitKeychainPrewarm();
      const result = String(secret || '').trim()
        ? saveProviderApiKey(cfgMod, providerId, secret)
        : await loginOAuthProvider(cfgMod, providerId);
      reloadFullConfig();
      invalidateProviderCaches();
      refreshProviderCatalogsSoon();
      warmProviderModelCache();
      return result;
    },
    async loginOAuthProvider(providerId) {
      await awaitKeychainPrewarm();
      const result = await loginOAuthProvider(cfgMod, providerId);
      reloadFullConfig();
      invalidateProviderCaches();
      refreshProviderCatalogsSoon();
      warmProviderModelCache();
      return result;
    },
    async beginOAuthProviderLogin(providerId) {
      await awaitKeychainPrewarm();
      const result = await beginOAuthProviderLogin(cfgMod, providerId);
      reloadFullConfig();
      return {
        ...result,
        waitForCallback: result.waitForCallback?.then(async (completed) => {
          await awaitKeychainPrewarm();
          reloadFullConfig();
          if (completed) {
            invalidateProviderCaches();
            refreshProviderCatalogsSoon();
            warmProviderModelCache();
          }
          return completed;
        }),
        completeCode: async (code) => {
          const completed = await result.completeCode(code);
          await awaitKeychainPrewarm();
          reloadFullConfig();
          invalidateProviderCaches();
          refreshProviderCatalogsSoon();
          warmProviderModelCache();
          return completed;
        },
      };
    },
    saveProviderApiKey(providerId, secret) {
      const result = saveProviderApiKey(cfgMod, providerId, secret);
      reloadFullConfig();
      invalidateProviderCaches();
      refreshProviderCatalogsSoon();
      warmProviderModelCache();
      return result;
    },
    saveOpenAIUsageSessionKey(secret) {
      const result = saveOpenAIUsageSessionKey(cfgMod, secret);
      reloadFullConfig();
      invalidateProviderCaches();
      return result;
    },
    saveOpenCodeGoUsageAuth(opts) {
      const result = saveOpenCodeGoUsageAuth(cfgMod, opts);
      reloadFullConfig();
      invalidateProviderCaches();
      return result;
    },
    async loginOpenCodeGoUsage() {
      await awaitKeychainPrewarm();
      const result = await loginOpenCodeGoUsage(cfgMod);
      reloadFullConfig();
      invalidateProviderCaches();
      return result;
    },
    setLocalProvider(providerId, opts) {
      const result = setLocalProvider(cfgMod, providerId, opts);
      reloadFullConfig();
      invalidateProviderCaches();
      refreshProviderCatalogsSoon();
      warmProviderModelCache();
      return result;
    },
    forgetProviderAuth(providerId) {
      const result = forgetProviderAuth(cfgMod, providerId);
      reloadFullConfig();
      invalidateProviderCaches();
      refreshProviderCatalogsSoon();
      warmProviderModelCache();
      return result;
    },
    listPresets() {
      return cfgMod.listPresets(displayConfig());
    },
    async listProviderModels(options = {}) {
      return await collectProviderModels({
        force: options.force === true || options.refresh === true,
        quick: options.quick === true,
      });
    },
    async setDefaultProvider(provider) {
      const requested = clean(provider);
      if (!requested) throw new Error('provider is required');
      if (!isKnownProvider(requested)) throw new Error(`unknown provider "${provider}"`);
      saveConfigAndAdopt({ ...getConfig(), defaultProvider: requested });
      return requested;
    },
  };
}
