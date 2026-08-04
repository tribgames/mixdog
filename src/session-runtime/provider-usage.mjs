// Provider-setup snapshot + usage-dashboard cache glue, extracted from
// mixdog-session-runtime.mjs. Dependency-injected factory following the same
// pattern as createProviderModels: mutable cache state lives in a caller-owned
// `caches` object (so invalidateProviderCaches still resets the same
// references) and all config/registry reads flow through supplied accessors so
// live-binding is preserved.
import { clean } from './session-text.mjs';

// A post-redeem dashboard rebuild is best effort: past this budget the caller
// gets its confirmed outcome and the surface revalidates on its own cadence.
const REDEEM_REFRESH_BUDGET_MS = 15_000;

export function createProviderUsage({
  caches,
  getConfig,
  getReg,
  displayConfig,
  providerSetup,
  createUsageDashboard,
  fetchOAuthUsageSnapshot,
  consumeOpenAICodexResetCredit,
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
    const refreshUsage = options?.refresh === true;
    const forceSetup = options?.force === true || (refreshUsage && options?.refreshSetup !== false);
    if (!forceSetup && !refreshUsage && caches.usageDashboardCache.dashboard) {
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
    if (!forceSetup && !refreshUsage && caches.usageDashboardPromise) return await caches.usageDashboardPromise;
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
      let setup;
      try {
        setup = await cachedProviderSetup({ force: forceSetup, quick: false });
      } catch {
        // One unavailable keychain/provider descriptor must not take down the
        // whole dashboard. The no-secrets/no-local snapshot still lets cached
        // and provider-native quota windows refresh.
        log('provider setup failed; falling back to quick setup');
        setup = await cachedProviderSetup({ force: forceSetup, quick: true });
      }
      const dashboard = await createUsageDashboard(displayConfig(), {
        ...(options || {}),
        setup,
        getProvider,
        log,
      });
      caches.usageDashboardCache = { dashboard, at: Date.now() };
      return dashboard;
    };
    if (forceSetup || refreshUsage) return await buildDashboard();
    caches.usageDashboardPromise = buildDashboard()
      .finally(() => {
        caches.usageDashboardPromise = null;
      });
    return await caches.usageDashboardPromise;
  }

  async function consumeCodexRateLimitResetCredit(options = {}) {
    if (typeof consumeOpenAICodexResetCredit !== 'function') {
      throw new Error('Codex reset is unavailable');
    }
    const providerObj = reg().getProvider('openai-oauth');
    if (!providerObj) throw new Error('Codex is not signed in');
    const result = await consumeOpenAICodexResetCredit(providerObj, options);
    // The redeem is DONE and its outcome is authoritative. Rebuilding the whole
    // dashboard is a COURTESY refresh: it forces a sweep across every provider,
    // so binding the answer to it once turned a spent credit into "reset could
    // not be confirmed" whenever that sweep was slow or failed.
    caches.usageDashboardCache = {};
    const dashboard = await refreshedUsageDashboardWithin(REDEEM_REFRESH_BUDGET_MS);
    return { ...result, ...(dashboard ? { dashboard } : {}) };
  }

  async function refreshedUsageDashboardWithin(budgetMs) {
    let timer = null;
    const budget = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), budgetMs);
      timer?.unref?.();
    });
    try {
      return await Promise.race([
        getUsageDashboard({ refresh: true, refreshSetup: false }).catch(() => null),
        budget,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    refreshStatuslineUsageSnapshot,
    cachedProviderSetup,
    // True once a secrets-aware setup is cached: callers that must not block
    // (settings hydration) can serve the quick snapshot until then.
    hasProviderSetupCached: () => Boolean(caches.providerSetupCache.setup),
    getUsageDashboard,
    consumeCodexRateLimitResetCredit,
  };
}
