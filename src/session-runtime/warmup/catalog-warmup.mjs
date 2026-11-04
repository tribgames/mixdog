// Model catalog refresh loop: one refresh every 6 h. The periodic refresh
// follows the reference coding-agent server's own model refresh worker; as
// there, a failed refresh only waits for the next regular cycle, and an
// on-demand catalog read in between fetches for itself. The catalog's short
// retry hint (returned after a failed fetch) is for those on-demand reads, not
// for this loop.
const CATALOG_REFRESH_DEFAULT_MS = 6 * 60 * 60 * 1000;

export function createCatalogWarmup({ arm, park, busyReason, bootProfile, warmCatalogsInBackground, delays, flags }) {
  const { modelCatalogWarmupDelayMs } = delays;

  function scheduleModelCatalogWarmup(delayMs = modelCatalogWarmupDelayMs) {
    if (!flags.modelCatalogWarmupEnabled) {
      bootProfile('model-catalog:warm-skipped', { reason: 'disabled' });
      return;
    }
    arm('modelCatalogWarmupTimer', delayMs, function warmCatalogs() {
      const busy = busyReason();
      if (busy) {
        bootProfile('model-catalog:warm-deferred', { reason: busy });
        park('modelCatalogWarmupTimer', warmCatalogs);
        return;
      }
      void warmCatalogsInBackground()
        .then(() => {
          bootProfile('model-catalog:warm-ready');
          scheduleModelCatalogWarmup(CATALOG_REFRESH_DEFAULT_MS);
        })
        .catch((error) => {
          bootProfile('model-catalog:warm-failed', { error: error?.message || String(error) });
          scheduleModelCatalogWarmup(CATALOG_REFRESH_DEFAULT_MS);
        });
    });
  }

  return { scheduleModelCatalogWarmup };
}
