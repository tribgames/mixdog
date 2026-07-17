// Provider-setup snapshot + usage-dashboard cache glue, extracted from
// mixdog-session-runtime.mjs. Dependency-injected factory following the same
// pattern as createProviderModels: mutable cache state lives in a caller-owned
// `caches` object (so invalidateProviderCaches still resets the same
// references) and all config/registry reads flow through supplied accessors so
// live-binding is preserved.
import { clean } from './session-text.mjs';

export function createProviderUsage({
  caches,
  getConfig,
  getReg,
  displayConfig,
  providerSetup,
  createUsageDashboard,
  fetchOAuthUsageSnapshot,
  isCloseRequested,
  getProviderSetupWarmupTimer,
  scheduleProviderSetupWarmup,
}) {
  const reg = () => getReg();

  function refreshStatuslineUsageSnapshot(routeLike = {}) {
    const providerId = clean(routeLike.provider);
    const modelId = clean(routeLike.model);
    if (!providerId || !providerId.includes('oauth')) return;
    const providerObj = reg().getProvider(providerId);
    if (!providerObj) return;
    void fetchOAuthUsageSnapshot({ provider: providerId, model: modelId }, providerObj, (message) => {
      if (process.env.MIXDOG_STATUSLINE_TRACE) {
        try { process.stderr.write(`[statusline] ${message}\n`); } catch {}
      }
    }).catch(() => {});
  }

  async function cachedProviderSetup({ force = false, quick = false } = {}) {
    if (!force && caches.providerSetupCache.setup) {
      return caches.providerSetupCache.setup;
    }
    if (quick) {
      if (!force && caches.providerSetupQuickCache.setup) {
        return caches.providerSetupQuickCache.setup;
      }
      const setup = await providerSetup(displayConfig(), { detectLocal: false, checkSecrets: false });
      caches.providerSetupQuickCache = { setup, at: Date.now() };
      if (!caches.providerSetupPromise && !getProviderSetupWarmupTimer() && !isCloseRequested()) {
        scheduleProviderSetupWarmup(0);
      }
      return setup;
    }
    if (caches.providerSetupPromise) {
      const pendingSetup = await caches.providerSetupPromise;
      if (!force) return pendingSetup;
    }
    caches.providerSetupPromise = providerSetup(displayConfig(), { detectLocal: true })
      .then((setup) => {
        caches.providerSetupCache = { setup, at: Date.now() };
        return setup;
      })
      .finally(() => {
        caches.providerSetupPromise = null;
      });
    return await caches.providerSetupPromise;
  }

  async function getUsageDashboard(options = {}) {
    const forceSetup = options?.force === true || options?.refresh === true;
    if (!forceSetup && caches.usageDashboardCache.dashboard) {
      const cached = {
        ...caches.usageDashboardCache.dashboard,
        refresh: false,
        checking: false,
        cached: true,
        cachedAt: caches.usageDashboardCache.at,
      };
      if (typeof options?.onUpdate === 'function') {
        try { options.onUpdate(cached); } catch {}
      }
      return cached;
    }
    if (!forceSetup && caches.usageDashboardPromise) return await caches.usageDashboardPromise;
    const quickSetup = options?.quickSetup !== false;
    const getProvider = (providerId) => reg().getProvider(providerId);
    const log = (message) => {
      if (process.env.MIXDOG_USAGE_TRACE) {
        try { process.stderr.write(`[usage] ${message}\n`); } catch {}
      }
    };
    if (quickSetup && typeof options?.onUpdate === 'function') {
      const previewConfig = displayConfig();
      const previewSetup = await cachedProviderSetup({ force: false, quick: true });
      await createUsageDashboard(previewConfig, {
        ...(options || {}),
        preview: true,
        setup: previewSetup,
        getProvider,
        log,
      });
    }
    const buildDashboard = async () => {
      const dashboard = await createUsageDashboard(displayConfig(), {
        ...(options || {}),
        setup: await cachedProviderSetup({ force: forceSetup, quick: false }),
        getProvider,
        log,
      });
      caches.usageDashboardCache = { dashboard, at: Date.now() };
      return dashboard;
    };
    if (forceSetup) return await buildDashboard();
    caches.usageDashboardPromise = buildDashboard()
      .finally(() => {
        caches.usageDashboardPromise = null;
      });
    return await caches.usageDashboardPromise;
  }

  return {
    refreshStatuslineUsageSnapshot,
    cachedProviderSetup,
    getUsageDashboard,
  };
}
