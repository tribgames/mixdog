// Provider-setup snapshot + usage-dashboard cache glue.
// Dependency-injected factory following the same
// pattern as createProviderModels: mutable cache state lives in a caller-owned
// `caches` object (so invalidateProviderCaches still resets the same
// references) and all config/registry reads flow through supplied accessors so
// live-binding is preserved.
import { clean } from './session-text.mjs';

// A post-redeem dashboard rebuild is best effort: past this budget the caller
// gets its confirmed outcome and the surface revalidates on its own cadence.
const REDEEM_REFRESH_BUDGET_MS = 15_000;

// A refresh is a live sweep of every connected provider's quota API, paced by
// the slowest one (seconds; tens of seconds for a stalled provider). Every
// surface asks for one — the desktop rail's cadence, each phone boot and wake,
// the TUI — so a phone opening while the desktop refreshed paid a second full
// sweep for the same numbers. A matching sweep already running is joined, and
// a complete sweep that finished within this window answers a plain refresh.
export const USAGE_REFRESH_REUSE_MS = 30_000;

/** Identity of the providers a refresh forces live; '' = all of them. */
function refreshScopeKey(options) {
  const requested = options?.refreshProviders;
  if (!Array.isArray(requested)) return '';
  return [
    ...new Set(
      requested
        .slice(0, 16)
        .map((value) => clean(value).toLowerCase())
        .filter(Boolean)
    ),
  ]
    .sort()
    .join(',');
}

export function createProviderUsage({
  caches,
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
  let quickSetupRequest = null;
  let dashboardRequest = null;
  /** In-flight usage refreshes by scope, each tied to the cache generation it
   *  started in: a sweep begun before an invalidation (credential change,
   *  reset-credit redeem) is never joined by a request made after it. */
  const liveRefreshes = new Map();

  function refreshStatuslineUsageSnapshot(routeLike = {}) {
    const providerId = clean(routeLike.provider);
    const modelId = clean(routeLike.model);
    if (!providerId?.includes('oauth')) return;
    const providerObj = reg().getProvider(providerId);
    if (!providerObj) return;
    void fetchOAuthUsageSnapshot({ provider: providerId, model: modelId }, providerObj, (message) => {
      if (process.env.MIXDOG_STATUSLINE_TRACE) {
        try {
          process.stderr.write(`[statusline] ${message}\n`);
        } catch {}
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
      const cache = caches.providerSetupQuickCache;
      const request = {};
      quickSetupRequest = request;
      const setup = await providerSetup(displayConfig(), { detectLocal: false, checkSecrets: false });
      if (quickSetupRequest === request && caches.providerSetupQuickCache === cache) {
        caches.providerSetupQuickCache = { setup, at: Date.now() };
        if (!caches.providerSetupPromise && !getProviderSetupWarmupTimer() && !isCloseRequested()) {
          scheduleProviderSetupWarmup(0);
        }
      }
      return setup;
    }
    if (caches.providerSetupPromise) {
      const pendingSetup = await caches.providerSetupPromise;
      if (!force) return pendingSetup;
    }
    const promise = providerSetup(displayConfig(), { detectLocal: true })
      .then((setup) => {
        if (caches.providerSetupPromise === promise) {
          caches.providerSetupCache = { setup, at: Date.now() };
        }
        return setup;
      })
      .finally(() => {
        if (caches.providerSetupPromise === promise) caches.providerSetupPromise = null;
      });
    caches.providerSetupPromise = promise;
    return await promise;
  }

  function cachedDashboard(options) {
    const cached = {
      ...caches.usageDashboardCache.dashboard,
      refresh: false,
      checking: false,
      cached: true,
      cachedAt: caches.usageDashboardCache.at,
    };
    if (typeof options?.onUpdate === 'function') {
      try {
        options.onUpdate(cached);
      } catch {}
    }
    return cached;
  }

  async function getUsageDashboard(options = {}) {
    const refreshUsage = options?.refresh === true;
    const forceSetup = options?.force === true || (refreshUsage && options?.refreshSetup !== false);
    if (!forceSetup && !refreshUsage && caches.usageDashboardCache.dashboard) {
      return cachedDashboard(options);
    }
    if (refreshUsage && !forceSetup) {
      const scope = refreshScopeKey(options);
      const cache = caches.usageDashboardCache;
      if (
        !scope &&
        cache.dashboard &&
        Number.isFinite(cache.liveAt) &&
        Date.now() - cache.liveAt < USAGE_REFRESH_REUSE_MS
      ) {
        return cachedDashboard(options);
      }
      const running = liveRefreshes.get(scope);
      if (running?.cache === cache) {
        const dashboard = await running.promise;
        if (typeof options?.onUpdate === 'function') {
          try {
            options.onUpdate(dashboard);
          } catch {}
        }
        return dashboard;
      }
      const entry = { cache, promise: buildUsageDashboard(options, { refreshUsage, forceSetup, scope }) };
      liveRefreshes.set(scope, entry);
      try {
        return await entry.promise;
      } finally {
        if (liveRefreshes.get(scope) === entry) liveRefreshes.delete(scope);
      }
    }
    return await buildUsageDashboard(options, { refreshUsage, forceSetup, scope: refreshScopeKey(options) });
  }

  async function buildUsageDashboard(options, { refreshUsage, forceSetup, scope }) {
    if (!forceSetup && !refreshUsage && caches.usageDashboardPromise) return await caches.usageDashboardPromise;
    const cache = caches.usageDashboardCache;
    const request = {};
    dashboardRequest = request;
    const quickSetup = options?.quickSetup !== false;
    const getProvider = (providerId) => reg().getProvider(providerId);
    const log = (message) => {
      if (process.env.MIXDOG_USAGE_TRACE) {
        try {
          process.stderr.write(`[usage] ${message}\n`);
        } catch {}
      }
    };
    const buildDashboard = async () => {
      // Preview belongs to this build's single-flight lifetime as well.
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
      // A newer refresh supersedes this request; replacing the cache object
      // invalidates all older requests, including pre-redeem quota snapshots.
      if (dashboardRequest === request && caches.usageDashboardCache === cache) {
        const at = Date.now();
        // Only a sweep that forced EVERY provider live may stand in for a
        // later refresh; a plain build or a scoped one served cached quotas.
        caches.usageDashboardCache = { dashboard, at, ...(refreshUsage && !scope ? { liveAt: at } : {}) };
      }
      return dashboard;
    };
    if (forceSetup || refreshUsage) return await buildDashboard();
    const promise = buildDashboard().finally(() => {
      if (caches.usageDashboardPromise === promise) caches.usageDashboardPromise = null;
    });
    caches.usageDashboardPromise = promise;
    return await promise;
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
      return await Promise.race([getUsageDashboard({ refresh: true, refreshSetup: false }).catch(() => null), budget]);
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
