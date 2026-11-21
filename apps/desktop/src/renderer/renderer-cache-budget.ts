// Chars, not bytes: probes count JS string length and V8 stores these as
// UTF-16, so the real cost is roughly twice the number below.
const RENDERER_CACHE_BUDGET_CHARS = 24 * 1024 * 1024;

interface BudgetedCache {
  /** Stable identity; re-registering the same name replaces the entry. */
  name: string;
  /** Currently retained characters. */
  chars(): number;
  /** Drop entries (oldest first) until at most `targetChars` remain. */
  trim(targetChars: number): void;
}

const caches = new Map<string, BudgetedCache>();

/** Register a cache with the shared budget. Returns the unregister handle;
 *  module-level registrations simply never call it. */
export function registerBudgetedCache(cache: BudgetedCache): () => void {
  caches.set(cache.name, cache);
  return () => {
    if (caches.get(cache.name) === cache) caches.delete(cache.name);
  };
}

export function totalBudgetedChars(): number {
  let total = 0;
  for (const cache of caches.values()) {
    // A throwing probe must not strand the caches behind it.
    try {
      total += cache.chars();
    } catch {
      /* treat as empty this pass */
    }
  }
  return total;
}

/** Trim registered caches, largest first, until the total fits the budget.
 *  Returns the resulting total so callers/tests can assert convergence. */
export function enforceRendererCacheBudget(budget = RENDERER_CACHE_BUDGET_CHARS): number {
  let total = totalBudgetedChars();
  if (total <= budget) return total;
  const ordered = [...caches.values()].sort((a, b) => {
    try {
      return b.chars() - a.chars();
    } catch {
      return 0;
    }
  });
  for (const cache of ordered) {
    if (total <= budget) break;
    try {
      const before = cache.chars();
      // Ask only for the overshoot: a cache is never wiped for being second
      // in line when trimming its excess alone brings the total back.
      cache.trim(Math.max(0, before - (total - budget)));
      total -= before - cache.chars();
    } catch {
      /* skip an uncooperative cache; others still shrink */
    }
  }
  return total;
}
