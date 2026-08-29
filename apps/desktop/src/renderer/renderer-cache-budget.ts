// Shared ceiling across renderer caches; idle-reclaim.ts is the complement.
//
// Every renderer cache already bounds ITSELF, but nothing bounded their SUM:
// image previews (32 MB) + normalized patches (8 MB) + markdown ASTs + turn
// reviews (12 MB) + session snapshots (16 MB) may all sit at their individual
// ceiling at the same time, which is how an idle renderer settled at ~470 MB.
// Idle reclaim only fires while the window is unfocused with no turn running,
// so it cannot bound a renderer that stays busy and focused; this budget does.
//
// Caches register a size probe and a trim callback. When one grows, the
// LARGEST registered cache is trimmed first, so a single hot cache cannot
// starve the others and a cache that is not the problem keeps its entries.
//
// Chars, not bytes: probes count JS string length and V8 stores these as
// UTF-16, so the real cost is roughly twice the number below.
export const RENDERER_CACHE_BUDGET_CHARS = 24 * 1024 * 1024;

export interface BudgetedCache {
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
  return () => { caches.delete(cache.name); };
}

export function totalBudgetedChars(): number {
  let total = 0;
  for (const cache of caches.values()) {
    // A throwing probe must not strand the caches behind it.
    try { total += cache.chars(); } catch { /* treat as empty this pass */ }
  }
  return total;
}

/** Trim registered caches, largest first, until the total fits the budget.
 *  Returns the resulting total so callers/tests can assert convergence. */
export function enforceRendererCacheBudget(
  budget = RENDERER_CACHE_BUDGET_CHARS,
): number {
  let total = totalBudgetedChars();
  if (total <= budget) return total;
  const ordered = [...caches.values()].sort((a, b) => {
    try { return b.chars() - a.chars(); } catch { return 0; }
  });
  for (const cache of ordered) {
    if (total <= budget) break;
    try {
      const before = cache.chars();
      // Ask only for the overshoot: a cache is never wiped for being second
      // in line when trimming its excess alone brings the total back.
      cache.trim(Math.max(0, before - (total - budget)));
      total -= before - cache.chars();
    } catch { /* skip an uncooperative cache; others still shrink */ }
  }
  return total;
}

export function _resetRendererCacheBudgetForTest(): void {
  caches.clear();
}
