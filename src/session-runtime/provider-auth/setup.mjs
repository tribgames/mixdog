// provider-auth/setup.mjs — read-side provider surfaces: the setup snapshot
// (quick until the keychain is ready), usage dashboard, Codex reset credit and
// the model catalog.
export function createSetupApi({
  awaitKeychainPrewarm,
  isKeychainPrewarmReady,
  hasProviderSetupCached,
  reloadFullConfig,
  cachedProviderSetup,
  getUsageDashboard,
  consumeCodexRateLimitResetCredit,
  collectProviderModels,
}) {
  return {
    async getProviderSetup(options = {}) {
      const force = options?.force === true || options?.refresh === true;
      // An unforced read never blocks: the authoritative setup waits on the OS
      // keychain, which can take seconds on a cold start and used to stall the
      // whole settings sweep behind it. Serve
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
    async listProviderModels(options = {}) {
      return await collectProviderModels({
        force: options.force === true || options.refresh === true,
        quick: options.quick === true,
      });
    },
  };
}
