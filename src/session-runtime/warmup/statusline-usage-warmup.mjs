// OAuth usage snapshot for the statusline: one warmup after boot, then an idle
// keep-alive loop so the cachedAt stays "live-fresh" and the usage segment does
// not vanish after LIVE_USAGE_SNAPSHOT_MAX_AGE_MS while the session is idle.
// Turn-driven refreshes (recordStandaloneStatusTelemetry) cover active sessions.
import { clean } from '../session-text.mjs';

export function createStatuslineUsageWarmup({
  arm,
  busyReason,
  bootProfile,
  getRoute,
  getConfig,
  isCloseRequested,
  ensureConfigForRouteProvider,
  awaitKeychainPrewarm,
  ensureProvidersReady,
  ensureProviderEnabled,
  refreshStatuslineUsageSnapshot,
  delays,
}) {
  const { statuslineUsageWarmupDelayMs, statuslineUsageRefreshDelayMs, backgroundBusyRetryMs } = delays;
  const oauthProviderId = () => {
    const providerId = clean(getRoute()?.provider);
    return providerId?.includes('oauth') ? providerId : null;
  };

  async function refreshIdleStatuslineUsage() {
    await awaitKeychainPrewarm();
    if (isCloseRequested()) return null;
    ensureConfigForRouteProvider();
    const route = getRoute();
    await ensureProvidersReady(ensureProviderEnabled(getConfig(), route.provider));
    if (isCloseRequested()) return null;
    // Refresh the route whose provider was prepared, not a replacement route
    // selected while provider initialization was pending.
    refreshStatuslineUsageSnapshot(route);
    return route;
  }

  function scheduleStatuslineUsageWarmup(delayMs = statuslineUsageWarmupDelayMs) {
    if (!oauthProviderId()) {
      bootProfile('statusline-usage:warm-skipped', { provider: clean(getRoute()?.provider) || null });
      return;
    }
    arm('statuslineUsageWarmupTimer', delayMs, async () => {
      const busy = busyReason();
      if (busy) {
        bootProfile('statusline-usage:warm-deferred', { reason: busy });
        scheduleStatuslineUsageWarmup(backgroundBusyRetryMs);
        return;
      }
      try {
        const warmedRoute = await refreshIdleStatuslineUsage();
        if (warmedRoute) bootProfile('statusline-usage:warm-ready', { provider: clean(warmedRoute.provider) });
      } catch (error) {
        bootProfile('statusline-usage:warm-failed', { error: error?.message || String(error) });
      } finally {
        scheduleStatuslineUsageRefresh();
      }
    });
  }

  function scheduleStatuslineUsageRefresh(delayMs = statuslineUsageRefreshDelayMs) {
    if (!oauthProviderId()) return;
    arm('statuslineUsageRefreshTimer', delayMs, async () => {
      if (busyReason()) {
        // Active turns refresh usage on their own; just re-arm the idle loop.
        scheduleStatuslineUsageRefresh();
        return;
      }
      try {
        await refreshIdleStatuslineUsage();
      } catch {
        // Usage display must never affect the session runtime.
      } finally {
        scheduleStatuslineUsageRefresh();
      }
    });
  }

  return { scheduleStatuslineUsageWarmup, scheduleStatuslineUsageRefresh };
}
