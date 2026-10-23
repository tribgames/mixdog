import type { TranscriptVirtualizer } from './transcript-list-geometry';

type HeldShrinkHost = Pick<
  TranscriptVirtualizer,
  'elementsCache' | 'itemSizeCache' | 'measurementsCache' | 'options' | 'indexFromElement'
>;

/** Whether a mounted row element holds a reply that is still streaming. */
export function rowIsStreaming(element: Element | undefined): boolean {
  return Boolean(element?.isConnected && element.querySelector('.message.streaming'));
}

/** A streaming reply reflows shorter for a moment (a table or list re-laying
 *  out mid-stream) and grows back a few chunks later. While the tail is
 *  followed, applying that dip pulled the whole transcript DOWN and then up
 *  again (user: 생성 중 위아래로 튄다). Such a row keeps its tallest MEASURED
 *  slot; its latest real size is recorded and lands once the row stops
 *  streaming, the reader takes over, or the measurements are remembered.
 *
 *  Only a measured slot is held: a row's first size is compared against the
 *  estimate it was laid out at, and holding THAT left a new reply's first
 *  line in a 60px estimate gap with the live band below it jumping down by
 *  the gap (first message of a new session). A learned estimate the
 *  provisional resize writes into the size cache while markdown is pending
 *  is no measurement either: only a slot the core took from an observed size
 *  (`measured`) is held. */
export function createHeldRowShrinks() {
  /** Held row key → its latest actual size. */
  const latest = new Map<unknown, number>();
  /** Row key → the observed size its cached slot was last set from. */
  const real = new Map<unknown, number>();
  // A size being landed by settle() goes straight through the resize path.
  let landing = false;
  const streaming = (host: HeldShrinkHost, key: unknown) => rowIsStreaming(host.elementsCache.get(key as never));
  return {
    get size() {
      return latest.size;
    },
    /** Whether `size` is a followed streaming row's dip below its measured
     *  slot. A held size is recorded instead of applied; any other size ends
     *  the row's hold. */
    hold(host: HeldShrinkHost, key: unknown, size: number): boolean {
      const slot = host.itemSizeCache.get(key as never);
      if (
        landing ||
        slot === undefined ||
        real.get(key) !== slot ||
        size >= slot ||
        host.options.anchorTo !== 'end' ||
        !streaming(host, key)
      ) {
        latest.delete(key);
        return false;
      }
      latest.set(key, size);
      return true;
    },
    /** Records, after the resize path applied observed `size`, whether the
     *  row's cached slot now is that measurement or a substituted estimate. */
    measured(host: HeldShrinkHost, key: unknown, size: number) {
      if (host.itemSizeCache.get(key as never) === size) real.set(key, size);
      else real.delete(key);
    },
    /** Lands every hold that no longer applies (`force`: every hold) at its
     *  latest real size through `resize` — the list's own resize path, so the
     *  gesture deferral and reading-anchor rules still apply. A row that left
     *  the DOM is corrected at the size it last had; one that left the list
     *  drops its stale cached slot. */
    settle(host: HeldShrinkHost, resize: (index: number, size: number) => void, force = false) {
      if (latest.size === 0) return;
      for (const [key, size] of [...latest]) {
        if (!force && host.options.anchorTo === 'end' && streaming(host, key)) continue;
        latest.delete(key);
        const element = host.elementsCache.get(key as never);
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
          resize(index, size);
        } finally {
          landing = false;
        }
      }
    },
  };
}

export type HeldRowShrinks = ReturnType<typeof createHeldRowShrinks>;
