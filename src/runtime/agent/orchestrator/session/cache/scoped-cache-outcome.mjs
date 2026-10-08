/**
 * Mutable outcome ref threaded from the agent loop into scoped-cacheable tools.
 * Tools set `complete: false` only when the result is known incomplete/truncated.
 * `cacheSafe: false` independently rejects reuse when source watching failed.
 */
export function createScopedCacheOutcome() {
  return { complete: true, cacheSafe: true };
}

export function markScopedCacheIncomplete(outcome) {
  if (outcome && typeof outcome === 'object') outcome.complete = false;
}

export function markScopedCacheUnsafe(outcome) {
  if (outcome && typeof outcome === 'object') outcome.cacheSafe = false;
}
