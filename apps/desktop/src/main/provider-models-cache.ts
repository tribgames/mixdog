// Host-side sharing of the daemon's slow control reads.
//
// The model catalog: a full read still costs a daemon round trip (and a
// partial catalog a background refill of its missing providers), and boot
// fires several within seconds, each holding the phone's queue. A full
// answer is reused here for the window the renderer already treats as fresh
// (model-catalog-cache.ts PROVIDER_MODELS_FRESH_MS), a partial one only until
// the runtime's catalogRetryAt (clamped to 1-30 s); a forced read always goes
// out and becomes the answer; any mutation through this host, a provider
// change or a settings change drops it (clear()).

/** Matches the renderer's PROVIDER_MODELS_FRESH_MS. */
export const PROVIDER_MODELS_REUSE_MS = 30_000;

/** Shortest reuse of a partial catalog, so a near or past retry time cannot
 *  turn every boot-time read into a daemon round trip. */
const PARTIAL_CATALOG_MIN_REUSE_MS = 1_000;

/** When a kept answer stops being reused: a partial catalog (any row marked
 *  `catalogPartial` by the runtime) only until its `catalogRetryAt`, clamped
 *  to [PARTIAL_CATALOG_MIN_REUSE_MS, reuseMs]; anything else for `reuseMs`. */
function reuseUntil(value: unknown, at: number, reuseMs: number): number {
  const partial = Array.isArray(value)
    ? (value as Array<{ catalogPartial?: unknown; catalogRetryAt?: unknown }>).find(
        (row) => row?.catalogPartial === true
      )
    : undefined;
  if (!partial) return at + reuseMs;
  const retryAt = Number(partial.catalogRetryAt);
  const wait = Number.isFinite(retryAt) ? retryAt - at : PARTIAL_CATALOG_MIN_REUSE_MS;
  return at + Math.min(reuseMs, Math.max(PARTIAL_CATALOG_MIN_REUSE_MS, wait));
}

/** Identical concurrent requests join the one in flight. */
export function createInFlightJoin() {
  const running = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, load: () => Promise<T>): Promise<T> {
      const joined = running.get(key);
      if (joined) return joined as Promise<T>;
      const started = load();
      running.set(key, started);
      const settle = (): void => {
        if (running.get(key) === started) running.delete(key);
      };
      started.then(settle, settle);
      return started;
    },
  };
}

export function createProviderModelsCache<T>({
  reuseMs = PROVIDER_MODELS_REUSE_MS,
  now = Date.now,
}: {
  reuseMs?: number;
  now?: () => number;
} = {}) {
  let full: { value: T; until: number; sequence: number } | null = null;
  let generation = 0;
  // Loads are numbered as they start: one that began before the kept answer's
  // load (an ordinary read finishing after a forced refresh) never replaces it.
  let started = 0;
  const flights = createInFlightJoin();
  return {
    read(options: { force?: boolean; refresh?: boolean; quick?: boolean }, load: () => Promise<T>): Promise<T> {
      const forced = options.force === true || options.refresh === true;
      const quick = options.quick === true;
      if (!forced && !quick && full && now() < full.until) return Promise.resolve(full.value);
      const startedGeneration = generation;
      // A flight belongs to its generation: a caller after clear() never joins
      // a read that began before the change.
      return flights.run(`${generation}:${forced ? 'force' : ''}:${quick ? 'quick' : 'full'}`, async () => {
        started += 1;
        const sequence = started;
        const value = await load();
        if (!quick && startedGeneration === generation && (!full || full.sequence < sequence)) {
          const at = now();
          full = { value, until: reuseUntil(value, at, reuseMs), sequence };
        }
        return value;
      });
    },
    clear(): void {
      generation += 1;
      full = null;
    },
  };
}
