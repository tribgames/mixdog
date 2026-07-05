// Background warmup/refresh schedulers, extracted from
// mixdog-session-runtime.mjs. Dependency-injected factory: the timer handles
// live in a caller-owned `timers` object (so the facade's clearTimeout teardown
// still sees them) and all route/config/state reads go through supplied
// accessors. Returns the schedule* functions plus a clearAll() teardown helper.
import { performance } from 'node:perf_hooks';
import { clean } from './session-text.mjs';

export function createWarmupSchedulers({
  timers,
  bootProfile,
  getRoute,
  getConfig,
  isCloseRequested,
  getActiveTurnCount,
  getSessionCreatePromise,
  getProviderModelsCache,
  getProviderModelsPromise,
  reloadFullConfig,
  ensureConfigForRouteProvider,
  ensureProvidersReady,
  ensureProviderEnabled,
  refreshStatuslineUsageSnapshot,
  warmProviderModelCache,
  cachedProviderSetup,
  warmCatalogsInBackground,
  isFirstTurnCompleted,
  envFlag,
  delays,
  flags,
}) {
  const {
    providerWarmupDelayMs,
    providerSetupWarmupDelayMs,
    providerModelWarmupDelayMs,
    modelCatalogWarmupDelayMs,
    statuslineUsageWarmupDelayMs,
    statuslineUsageRefreshDelayMs,
    backgroundBusyRetryMs,
  } = delays;
  const {
    providerWarmupEnabled,
    modelPrefetchEnabled,
    modelCatalogWarmupEnabled,
  } = flags;

  function scheduleProviderWarmup(delayMs = providerWarmupDelayMs) {
    if (!providerWarmupEnabled) {
      bootProfile('providers:warm-skipped');
      return;
    }
    if (timers.providerWarmupTimer || isCloseRequested()) return;
    timers.providerWarmupTimer = setTimeout(() => {
      timers.providerWarmupTimer = null;
      if (isCloseRequested()) return;
      if (!isFirstTurnCompleted() && !envFlag('MIXDOG_PROVIDER_WARMUP_BEFORE_FIRST_TURN')) {
        bootProfile('providers:warm-deferred', { reason: 'first-turn-pending' });
        return;
      }
      if (getActiveTurnCount() > 0 || getSessionCreatePromise()) {
        bootProfile('providers:warm-deferred', { reason: getActiveTurnCount() > 0 ? 'turn-active' : 'session-create' });
        scheduleProviderWarmup(backgroundBusyRetryMs);
        return;
      }
      const providersStartedAt = performance.now();
      try {
        reloadFullConfig();
      } catch (error) {
        bootProfile('config:full-failed', { error: error?.message || String(error) });
      }
      void ensureProvidersReady(getConfig().providers || {})
        .then(() => {
          bootProfile('providers:init:ready', { ms: (performance.now() - providersStartedAt).toFixed(1) });
          if (isCloseRequested()) return null;
          return true;
        })
        .catch((error) => bootProfile('providers:warm-failed', { error: error?.message || String(error) }));
    }, delayMs);
    timers.providerWarmupTimer.unref?.();
  }

  function scheduleProviderSetupWarmup(delayMs = providerSetupWarmupDelayMs) {
    if (timers.providerSetupWarmupTimer || isCloseRequested()) return;
    timers.providerSetupWarmupTimer = setTimeout(() => {
      timers.providerSetupWarmupTimer = null;
      if (isCloseRequested()) return;
      void cachedProviderSetup()
        .then(() => bootProfile('provider-setup:warm-ready'))
        .catch((error) => bootProfile('provider-setup:warm-failed', { error: error?.message || String(error) }));
    }, delayMs);
    timers.providerSetupWarmupTimer.unref?.();
  }

  function scheduleProviderModelWarmup(delayMs = providerModelWarmupDelayMs) {
    if (!modelPrefetchEnabled) return;
    if (timers.providerModelWarmupTimer || isCloseRequested()) return;
    timers.providerModelWarmupTimer = setTimeout(() => {
      timers.providerModelWarmupTimer = null;
      if (isCloseRequested() || Array.isArray(getProviderModelsCache().models) || getProviderModelsPromise()) return;
      if (getActiveTurnCount() > 0 || getSessionCreatePromise()) {
        bootProfile('provider-models:warm-deferred', { reason: getActiveTurnCount() > 0 ? 'turn-active' : 'session-create' });
        scheduleProviderModelWarmup(backgroundBusyRetryMs);
        return;
      }
      warmProviderModelCache();
    }, delayMs);
    timers.providerModelWarmupTimer.unref?.();
  }

  function scheduleModelCatalogWarmup(delayMs = modelCatalogWarmupDelayMs) {
    if (!modelCatalogWarmupEnabled) {
      bootProfile('model-catalog:warm-skipped', { reason: 'disabled' });
      return;
    }
    if (timers.modelCatalogWarmupTimer || isCloseRequested()) return;
    timers.modelCatalogWarmupTimer = setTimeout(() => {
      timers.modelCatalogWarmupTimer = null;
      if (isCloseRequested()) return;
      if (getActiveTurnCount() > 0 || getSessionCreatePromise()) {
        bootProfile('model-catalog:warm-deferred', { reason: getActiveTurnCount() > 0 ? 'turn-active' : 'session-create' });
        scheduleModelCatalogWarmup(backgroundBusyRetryMs);
        return;
      }
      void warmCatalogsInBackground()
        .then(() => bootProfile('model-catalog:warm-ready'))
        .catch((error) => bootProfile('model-catalog:warm-failed', { error: error?.message || String(error) }));
    }, delayMs);
    timers.modelCatalogWarmupTimer.unref?.();
  }

  function scheduleStatuslineUsageWarmup(delayMs = statuslineUsageWarmupDelayMs) {
    const route = getRoute();
    const providerId = clean(route?.provider);
    if (!providerId || !providerId.includes('oauth')) {
      bootProfile('statusline-usage:warm-skipped', { provider: providerId || null });
      return;
    }
    if (timers.statuslineUsageWarmupTimer || isCloseRequested()) return;
    timers.statuslineUsageWarmupTimer = setTimeout(async () => {
      timers.statuslineUsageWarmupTimer = null;
      if (isCloseRequested()) return;
      if (getActiveTurnCount() > 0 || getSessionCreatePromise()) {
        bootProfile('statusline-usage:warm-deferred', { reason: getActiveTurnCount() > 0 ? 'turn-active' : 'session-create' });
        scheduleStatuslineUsageWarmup(backgroundBusyRetryMs);
        return;
      }
      try {
        ensureConfigForRouteProvider();
        await ensureProvidersReady(ensureProviderEnabled(getConfig(), getRoute().provider));
        if (isCloseRequested()) return;
        refreshStatuslineUsageSnapshot(getRoute());
        bootProfile('statusline-usage:warm-ready', { provider: clean(getRoute()?.provider) });
      } catch (error) {
        bootProfile('statusline-usage:warm-failed', { error: error?.message || String(error) });
      } finally {
        scheduleStatuslineUsageRefresh();
      }
    }, delayMs);
    timers.statuslineUsageWarmupTimer.unref?.();
  }

  // Idle keep-alive loop: periodically re-fetch the OAuth usage snapshot so its
  // cachedAt stays "live-fresh" and the statusline usage segment does not vanish
  // after LIVE_USAGE_SNAPSHOT_MAX_AGE_MS while the session is idle. Turn-driven
  // refreshes (recordStandaloneStatusTelemetry) already cover active sessions.
  function scheduleStatuslineUsageRefresh(delayMs = statuslineUsageRefreshDelayMs) {
    const route = getRoute();
    const providerId = clean(route?.provider);
    if (!providerId || !providerId.includes('oauth')) return;
    if (timers.statuslineUsageRefreshTimer || isCloseRequested()) return;
    timers.statuslineUsageRefreshTimer = setTimeout(async () => {
      timers.statuslineUsageRefreshTimer = null;
      if (isCloseRequested()) return;
      if (getActiveTurnCount() > 0 || getSessionCreatePromise()) {
        // Active turns refresh usage on their own; just re-arm the idle loop.
        scheduleStatuslineUsageRefresh();
        return;
      }
      try {
        ensureConfigForRouteProvider();
        await ensureProvidersReady(ensureProviderEnabled(getConfig(), getRoute().provider));
        if (isCloseRequested()) return;
        refreshStatuslineUsageSnapshot(getRoute());
      } catch {
        // Usage display must never affect the session runtime.
      } finally {
        scheduleStatuslineUsageRefresh();
      }
    }, delayMs);
    timers.statuslineUsageRefreshTimer.unref?.();
  }

  return {
    scheduleProviderWarmup,
    scheduleProviderSetupWarmup,
    scheduleProviderModelWarmup,
    scheduleModelCatalogWarmup,
    scheduleStatuslineUsageWarmup,
    scheduleStatuslineUsageRefresh,
  };
}
