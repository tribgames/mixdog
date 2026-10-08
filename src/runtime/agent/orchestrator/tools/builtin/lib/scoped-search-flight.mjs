import { runResultCacheInFlight } from '../cache-layers.mjs';
import {
  createScopedCacheOutcome,
  markScopedCacheIncomplete,
  markScopedCacheUnsafe,
} from '../../../session/cache/scoped-cache-outcome.mjs';

// A shared scan's outcome belongs to every subscriber, not only the caller
// whose computation won admission. Persisted cache hits contain safe text.
export async function runScopedSearchInFlight(key, compute, options, outcome) {
  const settled = await runResultCacheInFlight(key, async ({ signal }) => {
    const scopedCacheOutcome = createScopedCacheOutcome();
    const result = await compute({ signal, scopedCacheOutcome });
    return { result, scopedCacheOutcome };
  }, options);
  if (typeof settled === 'string') return settled;
  if (settled.scopedCacheOutcome.complete === false) markScopedCacheIncomplete(outcome);
  if (settled.scopedCacheOutcome.cacheSafe === false) markScopedCacheUnsafe(outcome);
  return settled.result;
}
