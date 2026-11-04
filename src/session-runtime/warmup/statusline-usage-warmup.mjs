// OAuth usage snapshot for the statusline: one warmup after boot, then a
// refresh after every settled turn (the turn is what spends the quota). An
// opened usage panel reads it on demand (getUsageDashboard), which writes the
// same snapshot cache. Nothing polls while the session is idle: the statusline
// keeps the last snapshot of this process visible (allowStale reads).
import { clean } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';

export function createStatuslineUsageWarmup({
  arm,
  park,
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
  const { statuslineUsageWarmupDelayMs } = delays;
  const oauthProviderId = () => {
    const providerId = clean(getRoute()?.provider);
    return providerId.includes('oauth') ? providerId : null;
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
    arm('statuslineUsageWarmupTimer', delayMs, async function warmStatuslineUsage() {
      // A parked run may wake after the route left OAuth.
      if (!oauthProviderId()) return;
      const busy = busyReason();
      if (busy) {
        bootProfile('statusline-usage:warm-deferred', { reason: busy });
        park('statuslineUsageWarmupTimer', warmStatuslineUsage);
        return;
      }
      try {
        const warmedRoute = await refreshIdleStatuslineUsage();
        if (warmedRoute) bootProfile('statusline-usage:warm-ready', { provider: clean(warmedRoute.provider) });
      } catch (error) {
        bootProfile('statusline-usage:warm-failed', { error: error?.message || String(error) });
      }
    });
  }

  /** A turn settled: re-read the usage it spent. The snapshot fetch answers
   *  from its own short live cache between back-to-back turns. */
  function refreshStatuslineUsageAfterTurn() {
    if (!oauthProviderId() || isCloseRequested()) return;
    void refreshIdleStatuslineUsage().catch(() => {
      // Usage display must never affect the session runtime.
    });
  }

  return { scheduleStatuslineUsageWarmup, refreshStatuslineUsageAfterTurn };
}
