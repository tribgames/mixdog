// Background warmup/refresh schedulers.
// Dependency-injected factory: the timer handles
// live in a caller-owned `timers` object (so the facade's clearTimeout teardown
// still sees them) and all route/config/state reads go through supplied
// accessors. Teardown clears the caller-owned timers; resumed async work checks
// the same close state before starting another operation.
import { createWarmupTimers } from './warmup/timer-arm.mjs';
import { createProviderWarmups } from './warmup/provider-warmups.mjs';
import { createCatalogWarmup } from './warmup/catalog-warmup.mjs';
import { createStatuslineUsageWarmup } from './warmup/statusline-usage-warmup.mjs';

export function createWarmupSchedulers({ isCatalogRefreshPending = () => false, ...deps }) {
  const ctx = { ...deps, isCatalogRefreshPending, ...createWarmupTimers(deps) };
  return {
    ...createProviderWarmups(ctx),
    ...createCatalogWarmup(ctx),
    ...createStatuslineUsageWarmup(ctx),
  };
}
