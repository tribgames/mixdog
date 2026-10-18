// provider-auth/setup.mjs — read-side provider surfaces: the setup snapshot
// (quick until the keychain is ready), usage dashboard, Codex reset credit and
// the model catalog.
import { refreshKeychainStatus, retryKeychain } from '../../runtime/shared/config.mjs';
import { keychainIssueFor } from '../services/provider-admin.mjs';
import { modelProxyClientMode } from '../../runtime/shared/model-proxy-mode.mjs';
import { providerCatalogFailure } from '../../runtime/agent/orchestrator/providers/catalog-failures.mjs';

// The keyring alert must reflect the live state (it can lock or unlock while a
// cached setup is served), so overlay it on every ready read.
function withLiveKeychain(setup) {
  if (!setup || typeof setup !== 'object') return setup;
  const { keychain: _stale, ...rest } = setup;
  const keychain = keychainIssueFor(true);
  return keychain ? { ...rest, keychain } : rest;
}

// A provider whose model list failed says why on its row (`catalogError`), so a
// view never shows its empty list as if nothing were wrong. Overlaid on every
// read like the keyring alert: the cached setup predates the failure.
export function withCatalogErrors(setup) {
  if (!setup || typeof setup !== 'object') return setup;
  const out = { ...setup };
  for (const group of ['api', 'oauth', 'local']) {
    if (!Array.isArray(setup[group])) continue;
    out[group] = setup[group].map((row) => {
      const { message, errorKind } = providerCatalogFailure(row?.id) ?? {};
      return message ? { ...row, catalogError: { message, errorKind } } : row;
    });
  }
  return out;
}

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
      if (modelProxyClientMode()) {
        return cachedProviderSetup({ force: force || options?.recheckKeychain === true });
      }
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
        return withCatalogErrors({ ...quick, pendingSecrets: !isKeychainPrewarmReady() });
      }
      await awaitKeychainPrewarm();
      // A keyring the user has since unlocked: rebuild the setup that was cached
      // while every stored key read as absent.
      const recovered = await retryKeychain({ interactive: options?.unlockKeychain === true });
      if (force || recovered) reloadFullConfig();
      // Passive: detects a re-locked keyring and re-snapshots a stale cache so
      // external (CLI / other process) changes show up.
      // `recheckKeychain` (window focus) skips the snapshot TTL.
      const changed = await refreshKeychainStatus({ force: options?.recheckKeychain === true });
      if (changed) reloadFullConfig();
      return withCatalogErrors(withLiveKeychain(await cachedProviderSetup({ force: force || recovered || changed })));
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
