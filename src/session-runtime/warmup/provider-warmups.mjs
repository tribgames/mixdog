// Provider warmups: provider initialization, the cached provider setup and
// the provider model catalog.
import { performance } from 'node:perf_hooks';

export function createProviderWarmups({
  arm,
  park,
  busyReason,
  bootProfile,
  getConfig,
  isCloseRequested,
  getProviderModelsCache,
  getProviderModelsPromise,
  reloadFullConfig,
  awaitKeychainPrewarm,
  ensureProvidersReady,
  warmProviderModelCache,
  cachedProviderSetup,
  isFirstTurnCompleted,
  isCatalogRefreshPending,
  envFlag,
  delays,
  flags,
}) {
  const { providerWarmupDelayMs, providerSetupWarmupDelayMs, providerModelWarmupDelayMs } = delays;
  const { providerWarmupEnabled, modelPrefetchEnabled } = flags;
  const warmupBeforeFirstTurn = () => isFirstTurnCompleted() || envFlag('MIXDOG_PROVIDER_WARMUP_BEFORE_FIRST_TURN');

  function scheduleProviderWarmup(delayMs = providerWarmupDelayMs) {
    if (!providerWarmupEnabled) {
      bootProfile('providers:warm-skipped');
      return;
    }
    arm('providerWarmupTimer', delayMs, async function warmProviders() {
      if (!warmupBeforeFirstTurn()) {
        bootProfile('providers:warm-deferred', { reason: 'first-turn-pending' });
        return;
      }
      const busy = busyReason();
      if (busy) {
        bootProfile('providers:warm-deferred', { reason: busy });
        park('providerWarmupTimer', warmProviders);
        return;
      }
      const providersStartedAt = performance.now();
      try {
        await awaitKeychainPrewarm();
        if (isCloseRequested()) return;
        reloadFullConfig();
      } catch (error) {
        bootProfile('config:full-failed', { error: error?.message || String(error) });
      }
      if (isCloseRequested()) return;
      void ensureProvidersReady(getConfig().providers || {})
        .then(() => {
          if (!isCloseRequested()) {
            bootProfile('providers:init:ready', { ms: (performance.now() - providersStartedAt).toFixed(1) });
          }
        })
        .catch((error) => bootProfile('providers:warm-failed', { error: error?.message || String(error) }));
    });
  }

  function scheduleProviderSetupWarmup(delayMs = providerSetupWarmupDelayMs) {
    arm('providerSetupWarmupTimer', delayMs, () => {
      void cachedProviderSetup()
        .then(() => bootProfile('provider-setup:warm-ready'))
        .catch((error) => bootProfile('provider-setup:warm-failed', { error: error?.message || String(error) }));
    });
  }

  function scheduleProviderModelWarmup(delayMs = providerModelWarmupDelayMs) {
    if (!modelPrefetchEnabled) return;
    arm('providerModelWarmupTimer', delayMs, function warmProviderModels() {
      if (Array.isArray(getProviderModelsCache().models) || getProviderModelsPromise()) return;
      const busy = busyReason();
      if (busy) {
        bootProfile('provider-models:warm-deferred', { reason: busy });
        park('providerModelWarmupTimer', warmProviderModels);
        return;
      }
      // The startup catalog refresh invalidates every model-derived cache when
      // it lands, so warming before it finishes throws the whole load away.
      if (isCatalogRefreshPending()) {
        bootProfile('provider-models:warm-deferred', { reason: 'catalog-refresh-pending' });
        park('providerModelWarmupTimer', warmProviderModels);
        return;
      }
      if (!warmupBeforeFirstTurn()) {
        // Secrets-aware even before the first turn: the no-secrets variant is
        // never adopted as the picker cache, so every consumer immediately
        // reloaded the whole catalog (measured ~900ms of duplicate provider
        // I/O on a desktop boot). This runs on a background timer and the
        // keychain prewarm is already in flight, so nothing user-facing waits.
        // The first turn's settle schedules this warmup again; no timer waits
        // for it.
        bootProfile('provider-models:warm-deferred', { reason: 'first-turn-pending' });
      }
      warmProviderModelCache({ loadSecrets: true });
    });
  }

  return { scheduleProviderWarmup, scheduleProviderSetupWarmup, scheduleProviderModelWarmup };
}
