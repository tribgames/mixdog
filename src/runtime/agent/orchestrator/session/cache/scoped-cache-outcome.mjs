import { classifyResultKind } from '../result-classification.mjs';

/**
 * Mutable outcome ref threaded from the agent loop into scoped-cacheable tools.
 * Tools set `complete: false` only when the result is known incomplete/truncated.
 * `cacheSafe: false` independently rejects reuse when source watching failed.
 */
export function createScopedCacheOutcome() {
  return { complete: true, cacheSafe: true };
}

/**
 * A tool that resolves its own roots records the absolute paths its answer
 * actually depends on. Absent evidence (`dependencyRoots` undefined) means
 * the cache cannot place the entry for invalidation.
 */
export function recordScopedCacheDependency(outcome, absPath) {
  if (!outcome || typeof outcome !== 'object' || typeof absPath !== 'string' || !absPath) return;
  (outcome.dependencyRoots ??= new Set()).add(absPath);
}

/** A child section whose body is an error cannot be part of a complete cached answer. */
export function markScopedCacheIncompleteIfError(outcome, body) {
  if (classifyResultKind(body) === 'error') markScopedCacheIncomplete(outcome);
}

export function markScopedCacheIncomplete(outcome) {
  if (outcome && typeof outcome === 'object') outcome.complete = false;
}

export function markScopedCacheUnsafe(outcome) {
  if (outcome && typeof outcome === 'object') outcome.cacheSafe = false;
}
