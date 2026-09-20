// Model catalog refresh loop: re-armed on the catalog's own retry hint, with a
// one-minute backoff after a failure.
const CATALOG_REFRESH_DEFAULT_MS = 6 * 60 * 60 * 1000;
const CATALOG_REFRESH_FAILURE_MS = 60_000;

export function createCatalogWarmup({ arm, busyReason, bootProfile, warmCatalogsInBackground, delays, flags }) {
  const { modelCatalogWarmupDelayMs, backgroundBusyRetryMs } = delays;

  function scheduleModelCatalogWarmup(delayMs = modelCatalogWarmupDelayMs) {
    if (!flags.modelCatalogWarmupEnabled) {
      bootProfile('model-catalog:warm-skipped', { reason: 'disabled' });
      return;
    }
    arm('modelCatalogWarmupTimer', delayMs, () => {
      const busy = busyReason();
      if (busy) {
        bootProfile('model-catalog:warm-deferred', { reason: busy });
        scheduleModelCatalogWarmup(backgroundBusyRetryMs);
        return;
      }
      void warmCatalogsInBackground()
        .then((result) => {
          bootProfile('model-catalog:warm-ready');
          scheduleModelCatalogWarmup(result?.retryAfterMs ?? CATALOG_REFRESH_DEFAULT_MS);
        })
        .catch((error) => {
          bootProfile('model-catalog:warm-failed', { error: error?.message || String(error) });
          scheduleModelCatalogWarmup(CATALOG_REFRESH_FAILURE_MS);
        });
    });
  }

  return { scheduleModelCatalogWarmup };
}
