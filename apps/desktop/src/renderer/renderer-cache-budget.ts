// Chars, not bytes: probes count JS string length and V8 stores these as
// UTF-16, so the real cost is roughly twice the number below.
const RENDERER_CACHE_BUDGET_CHARS = 24 * 1024 * 1024;
/** The share of the budget the caches that can be trimmed keep however much pinned content counts against it: content
 *  shown past the budget would otherwise empty them on every frame, and each would rebuild what it is trimmed of at once. */
const TRIMMABLE_RESERVE_SHARE = 0.25;

interface BudgetedCache {
  /** Stable identity; re-registering the same name replaces the entry. */
  name: string;
  /** Currently retained characters. */
  chars(): number;
  /** Of those, the characters `trim` never lets go (what is on screen). */
  pinned?(): number;
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

function pinnedChars(cache: BudgetedCache): number {
  try {
    return cache.pinned?.() ?? 0;
  } catch {
    return 0;
  }
}

/** Trim registered caches, largest trimmable part first, until the total fits the budget. Pinned characters count
 *  against it, but the trimmable ones are never trimmed below their reserve (`TRIMMABLE_RESERVE_SHARE`).
 *  Returns the resulting total so callers/tests can assert convergence. */
export function enforceRendererCacheBudget(budget = RENDERER_CACHE_BUDGET_CHARS): number {
  let total = totalBudgetedChars();
  if (total <= budget) return total;
  let pinned = 0;
  for (const cache of caches.values()) pinned += pinnedChars(cache);
  let over = total - pinned - Math.max(budget - pinned, budget * TRIMMABLE_RESERVE_SHARE);
  if (over <= 0) return total;
  const trimmable = (cache: BudgetedCache): number => {
    try {
      return cache.chars() - pinnedChars(cache);
    } catch {
      return 0;
    }
  };
  const ordered = [...caches.values()].sort((a, b) => trimmable(b) - trimmable(a));
  for (const cache of ordered) {
    if (over <= 0) break;
    try {
      const before = cache.chars();
      // Ask only for the overshoot: a cache is never wiped for being second
      // in line when trimming its excess alone brings the total back.
      cache.trim(Math.max(pinnedChars(cache), before - over));
      const freed = before - cache.chars();
      over -= freed;
      total -= freed;
    } catch {
      /* skip an uncooperative cache; others still shrink */
    }
  }
  return total;
}
