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
import { resetProviderAdmissionCooldowns } from '../runtime/agent/orchestrator/providers/admission-scheduler.mjs';
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
  isKeychainPrewarmReady = () => true,
  hasProviderSetupCached = () => true,
  invalidateProviderCaches,
  warmProviderModelCache,
  refreshProviderCatalogs,
  cachedProviderSetup,
  getUsageDashboard,
  consumeCodexRateLimitResetCredit,
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

  // Auth mutation = the user changed credentials (re-login / account switch /
  // new key). Any admission-lane rate-limit cooldown belongs to the OLD
  // credentials, so release it immediately — otherwise a quota cooldown from
  // the previous account silently blocks the fresh account until restart.
  function releaseAdmissionCooldowns() {
    try { resetProviderAdmissionCooldowns(); } catch { /* best-effort */ }
  }

  return {
    listProviders() {
      return renderProviderStatus(displayConfig());
    },
    async getProviderSetup(options = {}) {
      const force = options?.force === true || options?.refresh === true;
      // An unforced read never blocks: the authoritative setup waits on the OS
      // keychain AND probes local provider ports, which together take seconds on
      // a cold start and used to stall the whole settings sweep behind it. Serve
      // the no-secrets snapshot until the real one is cached — flagged, so the
      // caller shows "checking" instead of a wrong "not connected" — and let the
      // scheduled warmup publish the authoritative result for the next read.
      if (!force && (!isKeychainPrewarmReady() || !hasProviderSetupCached())) {
        const quick = await cachedProviderSetup({ quick: true });
        void Promise.resolve(awaitKeychainPrewarm())
          .then(() => cachedProviderSetup({}))
          .catch(() => {});
        return { ...quick, pendingSecrets: !isKeychainPrewarmReady() };
      }
      await awaitKeychainPrewarm();
      if (force) reloadFullConfig();
      return await cachedProviderSetup({ force });
    },
    async getUsageDashboard(options = {}) {
      return await getUsageDashboard(options);
    },
    async consumeCodexRateLimitResetCredit(options = {}) {
      await awaitKeychainPrewarm();
      if (typeof consumeCodexRateLimitResetCredit !== 'function') {
        throw new Error('Codex reset is unavailable');
      }
      return await consumeCodexRateLimitResetCredit(options);
    },
    async authenticateProvider(providerId, secret) {
      await awaitKeychainPrewarm();
      const result = String(secret || '').trim()
        ? saveProviderApiKey(cfgMod, providerId, secret)
        : await loginOAuthProvider(cfgMod, providerId);
      reloadFullConfig();
      invalidateProviderCaches();
      releaseAdmissionCooldowns();
      refreshProviderCatalogsSoon();
      warmProviderModelCache();
      return result;
    },
    async loginOAuthProvider(providerId) {
      await awaitKeychainPrewarm();
      const result = await loginOAuthProvider(cfgMod, providerId);
      reloadFullConfig();
      invalidateProviderCaches();
      releaseAdmissionCooldowns();
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
            releaseAdmissionCooldowns();
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
          releaseAdmissionCooldowns();
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
      releaseAdmissionCooldowns();
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
      releaseAdmissionCooldowns();
      refreshProviderCatalogsSoon();
      warmProviderModelCache();
      return result;
    },
    forgetProviderAuth(providerId) {
      const result = forgetProviderAuth(cfgMod, providerId);
      reloadFullConfig();
      invalidateProviderCaches();
      releaseAdmissionCooldowns();
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
