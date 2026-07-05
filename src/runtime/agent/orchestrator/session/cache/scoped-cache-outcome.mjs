/**
 * Mutable outcome ref threaded from the agent loop into scoped-cacheable tools.
 * Tools set `complete: false` only when the result is known incomplete/truncated.
 */
export function createScopedCacheOutcome() {
    return { complete: true };
}

export function markScopedCacheIncomplete(outcome) {
    if (outcome && typeof outcome === 'object') outcome.complete = false;
}