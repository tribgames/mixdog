import type { TranscriptVirtualizer } from './transcript-list-geometry';

type HeldShrinkHost = Pick<
  TranscriptVirtualizer,
  'elementsCache' | 'itemSizeCache' | 'measurementsCache' | 'options' | 'indexFromElement'
>;

/** Maximum duration a streaming row's shrink is held without an active pending
 *  markdown parse so stale whitespace never accumulates across a whole stream. */
export const HELD_SHRINK_WINDOW_MS = 350;

const PENDING_SELECTOR = '[data-transcript-pending]';
const ROW_CONTENT = 'transcript-virtual-row-content';

/** Whether a mounted row element holds a reply that is still streaming. */
export function rowIsStreaming(element: Element | undefined): boolean {
  return Boolean(element?.isConnected && element.querySelector('.message.streaming'));
}

/** Whether a mounted row element currently has a markdown body awaiting async parse. */
function rowIsReparsing(element: Element | undefined): boolean {
  if (!element?.isConnected) return false;
  if (typeof element.querySelectorAll === 'function') {
    for (const marker of element.querySelectorAll(PENDING_SELECTOR)) {
      if (!marker.parentElement?.classList.contains(ROW_CONTENT)) return true;
    }
    return false;
  }
  return Boolean(element.querySelector?.(PENDING_SELECTOR));
}

/** Holds a followed streaming row's dip below its measured slot only during an
 *  active markdown-reparse window; its latest real size lands through `settle`. */
export function createHeldRowShrinks(now: () => number = () => Date.now()) {
  /** Held row key → its latest actual size and when the hold window started. */
  const latest = new Map<unknown, { size: number; heldAt: number }>();
  /** Row key → the observed size its cached slot was last set from. */
  const real = new Map<unknown, number>();
  // A size being landed by settle() goes straight through the resize path.
  let landing = false;
  const elementOf = (host: HeldShrinkHost, key: unknown) => host.elementsCache.get(key as never);
  const holdWindowOpen = (host: HeldShrinkHost, key: unknown, heldAt: number, currentNow: number): boolean => {
    const element = elementOf(host, key);
    if (!rowIsStreaming(element)) return false;
    return rowIsReparsing(element) || currentNow - heldAt < HELD_SHRINK_WINDOW_MS;
  };
  return {
    get size() {
      return latest.size;
    },
    /** Whether `size` is a followed streaming row's dip within an active
     *  markdown-reparse window. A held size is recorded instead of applied;
     *  any other size or an expired window ends the row's hold. */
    hold(host: HeldShrinkHost, key: unknown, size: number): boolean {
      const slot = host.itemSizeCache.get(key as never);
      const currentNow = now();
      const prior = latest.get(key);
      const heldAt = prior?.heldAt ?? currentNow;
      if (
        landing ||
        slot === undefined ||
        real.get(key) !== slot ||
        size >= slot ||
        host.options.anchorTo !== 'end' ||
        !holdWindowOpen(host, key, heldAt, currentNow)
      ) {
        latest.delete(key);
        return false;
      }
      latest.set(key, { size, heldAt });
      return true;
    },
    /** Milliseconds until the earliest timer-bounded hold window expires (0 if
     *  already expired, null if no holds are waiting on the timer — e.g. only
     *  held by an active pending markdown parse marker). */
    nextExpiryMs(host?: HeldShrinkHost): number | null {
      if (latest.size === 0) return null;
      const currentNow = now();
      let soonest = Number.POSITIVE_INFINITY;
      for (const [key, entry] of latest) {
        const remaining = HELD_SHRINK_WINDOW_MS - (currentNow - entry.heldAt);
        if (remaining <= 0 && host) {
          const element = elementOf(host, key);
          if (rowIsStreaming(element) && rowIsReparsing(element)) continue;
        }
        if (remaining < soonest) soonest = remaining;
      }
      return soonest === Number.POSITIVE_INFINITY ? null : Math.max(0, soonest);
    },
    /** Connected streaming row elements currently held with a pending parse marker. */
    reparsingElements(host: HeldShrinkHost): Element[] {
      const elements: Element[] = [];
      for (const key of latest.keys()) {
        const element = elementOf(host, key);
        if (element && rowIsStreaming(element) && rowIsReparsing(element)) elements.push(element);
      }
      return elements;
    },
    /** Records, after the resize path applied observed `size`, whether the
     *  row's cached slot now is that measurement or a substituted estimate. */
    measured(host: HeldShrinkHost, key: unknown, size: number) {
      if (host.itemSizeCache.get(key as never) === size) real.set(key, size);
      else real.delete(key);
    },
    /** Lands every hold whose reparse window closed (`force`: every hold) at its latest real size through `resize`. A
     *  row that left the DOM is corrected at its last size; one that left the list drops its stale cached slot. */
    settle(host: HeldShrinkHost, resize: (index: number, size: number) => void, force = false) {
      if (latest.size === 0) return;
      const currentNow = now();
      for (const [key, entry] of [...latest]) {
        if (!force && host.options.anchorTo === 'end' && holdWindowOpen(host, key, entry.heldAt, currentNow)) continue;
        latest.delete(key);
        const element = elementOf(host, key);
        const index = element?.isConnected
          ? host.indexFromElement(element)
          : host.measurementsCache.findIndex((item) => item.key === key);
        if (index < 0 || index >= host.options.count || host.measurementsCache[index]?.key !== key) {
          host.itemSizeCache.delete(key as never);
          real.delete(key);
          continue;
        }
        landing = true;
        try {
          resize(index, entry.size);
        } finally {
          landing = false;
        }
      }
    },
  };
}

export type HeldRowShrinks = ReturnType<typeof createHeldRowShrinks>;
