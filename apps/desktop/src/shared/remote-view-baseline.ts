/** Only complete recovery frames can be referenced. Live deltas are never
 * cached: replaying a full baseline rebuilds the new connection's decoders. */
export const VIEW_BASELINE_EVENT = 'viewBaseline';
export const MAX_VIEW_BASELINES = 132;
export const MAX_VIEW_BASELINE_BYTES = 8 * 1024 * 1024;

export function readViewBaselineOffer(value: unknown): Set<string> | null {
  if (!value || typeof value !== 'object') return null;
  const offer = value as { version?: unknown; keys?: unknown };
  if (offer.version !== 1 || !Array.isArray(offer.keys)
    || offer.keys.length > MAX_VIEW_BASELINES
    || offer.keys.some((key) => typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key))) return null;
  return new Set(offer.keys as string[]);
}

/** Session-memory only, bounded and discarded on unpair. Advertised entries
 * stay pinned until that recovery finishes so incoming full baselines cannot
 * evict a reference which is already in flight. Strings isolate the cached
 * baseline from downstream decoder/renderer mutation. */
export function createRemoteViewBaselineCache(
  maxBytes = MAX_VIEW_BASELINE_BYTES,
  now: () => number = Date.now,
) {
  const entries = new Map<string, { text: string; expires: number }>();
  let bytes = 0;
  let pinned = new Map<string, { text: string; expires: number }>();
  const remove = (key: string): void => {
    const entry = entries.get(key);
    if (entry) bytes -= entry.text.length * 2;
    entries.delete(key);
  };
  return {
    begin() {
      for (const [key, entry] of entries) if (entry.expires <= now()) remove(key);
      pinned = new Map(entries);
      const advertised = pinned;
      return {
        offer: { version: 1, keys: [...advertised.keys()] },
        finish: () => { if (pinned === advertised) pinned = new Map(); },
      };
    },
    restore(payload: unknown): Record<string, unknown> {
      if (!payload || typeof payload !== 'object') throw new Error('Invalid view baseline.');
      const value = payload as { key?: unknown; frame?: unknown };
      if (typeof value.key !== 'string' || !/^[a-f0-9]{64}$/.test(value.key)) {
        throw new Error('Invalid view baseline key.');
      }
      let text: string;
      if (Object.hasOwn(value, 'frame')) {
        if (!value.frame || typeof value.frame !== 'object') throw new Error('Invalid view baseline frame.');
        text = JSON.stringify(value.frame);
        remove(value.key);
        const size = text.length * 2;
        if (size <= maxBytes) {
          while (entries.size && (bytes + size > maxBytes || entries.size >= MAX_VIEW_BASELINES)) {
            remove(entries.keys().next().value!);
          }
          entries.set(value.key, { text, expires: now() + 5 * 60_000 });
          bytes += size;
        }
      } else {
        const entry = pinned.get(value.key);
        if (!entry) throw new Error('View baseline is no longer available.');
        text = entry.text;
      }
      const frame = JSON.parse(text) as Record<string, unknown>;
      if (!['state', 'sessions', 'agentPool', 'sessionState'].includes(String(frame.event))
        && frame.e !== 'S') throw new Error('Unexpected view baseline event.');
      if (!Object.hasOwn(value, 'frame')) {
        const entry = entries.get(value.key);
        // Renew only a successfully reused, still-retained entry. A pinned
        // reference can outlive eviction; reusing it must not restore it.
        if (entry && entry === pinned.get(value.key)) entry.expires = now() + 5 * 60_000;
      }
      return frame;
    },
    clear(): void {
      entries.clear();
      pinned.clear();
      bytes = 0;
    },
  };
}
