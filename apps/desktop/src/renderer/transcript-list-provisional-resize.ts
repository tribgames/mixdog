import { type MutableRefObject, useEffect, useLayoutEffect, useRef } from 'react';
import { ceilRowHeight, type TranscriptVirtualizer } from './transcript-list-geometry';

const PENDING_SELECTOR = '[data-transcript-pending]';
const ROW_CONTENT = 'transcript-virtual-row-content';

/** Whether a body of the row is still to be laid out (a reply being parsed): its box is not the row's yet. A marker
 *  that stands in the row beside its bodies (a card still to be read, which may turn out to be none) leaves the
 *  boxes laid out as they are: the row's size is what it measures, and the card resizes it if it comes. */
function bodyPending(element: HTMLElement): boolean {
  for (const marker of element.querySelectorAll(PENDING_SELECTOR)) {
    if (!marker.parentElement?.classList.contains(ROW_CONTENT)) return true;
  }
  return false;
}

function resolveMutationObserver(): typeof MutationObserver | null {
  if (typeof MutationObserver === 'function') return MutationObserver;
  if (typeof window !== 'undefined' && typeof window.MutationObserver === 'function') return window.MutationObserver;
  return null;
}

/** Keeps a row's learned estimate while its markdown is pending
 *  (data-transcript-pending) and adopts the settled box immediately on commit
 *  once the marker leaves. Must run before the resize patch captures resizeItem. */
export function useProvisionalRowResize({
  virtualizer,
  virtualizerRef,
  heldEstimates,
  fallbackEstimates,
}: {
  virtualizer: TranscriptVirtualizer;
  virtualizerRef: MutableRefObject<TranscriptVirtualizer>;
  heldEstimates: MutableRefObject<Map<unknown, number>>;
  fallbackEstimates: MutableRefObject<Set<unknown>>;
}) {
  const provisionalRows = useRef(new Set<HTMLElement>());
  const provisionalFrame = useRef(0);
  const observerRef = useRef<MutationObserver | null>(null);
  const observedRows = useRef(new Set<HTMLElement>());
  const wrappedResizeFor = useRef<TranscriptVirtualizer | null>(null);

  const settleProvisionalRef = useRef<() => void>(() => {});
  settleProvisionalRef.current = () => {
    const instance = virtualizerRef.current;
    for (const element of [...provisionalRows.current]) {
      if (!element.isConnected) {
        provisionalRows.current.delete(element);
        observedRows.current.delete(element);
        continue;
      }
      if (bodyPending(element)) continue;
      provisionalRows.current.delete(element);
      observedRows.current.delete(element);
      const index = instance.indexFromElement(element as HTMLDivElement);
      if (index >= 0 && index < instance.options.count) {
        instance.resizeItem(index, ceilRowHeight(element.getBoundingClientRect().height));
      }
    }
    if (provisionalRows.current.size === 0) {
      observerRef.current?.disconnect();
      observedRows.current.clear();
      if (provisionalFrame.current) {
        window.cancelAnimationFrame(provisionalFrame.current);
        provisionalFrame.current = 0;
      }
    }
  };

  useLayoutEffect(() => {
    if (provisionalRows.current.size > 0) settleProvisionalRef.current();
  });

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      observedRows.current.clear();
      provisionalRows.current.clear();
    },
    []
  );

  if (wrappedResizeFor.current !== virtualizer) {
    wrappedResizeFor.current = virtualizer;
    const coreResizeItem = virtualizer.resizeItem;
    const scheduleFallbackFrame = () => {
      if (provisionalFrame.current || provisionalRows.current.size === 0) return;
      provisionalFrame.current = window.requestAnimationFrame(() => {
        provisionalFrame.current = 0;
        settleProvisionalRef.current();
        if (provisionalRows.current.size > 0) scheduleFallbackFrame();
      });
    };
    const watchProvisional = (element: HTMLElement) => {
      provisionalRows.current.add(element);
      const ObserverCtor = resolveMutationObserver();
      if (ObserverCtor) {
        observerRef.current ??= new ObserverCtor(() => settleProvisionalRef.current());
        if (!observedRows.current.has(element)) {
          observedRows.current.add(element);
          observerRef.current.observe(element, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-transcript-pending'],
          });
        }
        return;
      }
      scheduleFallbackFrame();
    };
    virtualizer.resizeItem = (index, size) => {
      const key = virtualizer.options.getItemKey(index);
      const element = virtualizer.elementsCache.get(key);
      const held = heldEstimates.current.get(key);
      const following = virtualizer.options.anchorTo === 'end' || virtualizer.options.followOnAppend;
      const fallback = fallbackEstimates.current.has(key);
      const pending = Boolean(element && bodyPending(element));
      if (
        element &&
        held !== undefined &&
        (provisionalRows.current.has(element) || !virtualizer.itemSizeCache.has(key)) &&
        pending &&
        (!fallback || size < held)
      ) {
        watchProvisional(element);
        coreResizeItem(index, following || fallback ? Math.max(held, size) : held);
        return;
      }
      if (element && !pending && provisionalRows.current.delete(element)) {
        observedRows.current.delete(element);
        if (provisionalRows.current.size === 0) {
          observerRef.current?.disconnect();
          observedRows.current.clear();
        }
      }
      coreResizeItem(index, size);
    };
  }
  return provisionalFrame;
}
