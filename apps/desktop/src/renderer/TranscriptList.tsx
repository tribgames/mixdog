import {
  defaultRangeExtractor,
  elementScroll,
  useVirtualizer,
  type Virtualizer,
} from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";
import type { TranscriptRowModel } from "./transcript-rows";
import {
  readTranscriptVirtualSnapshot,
  rememberTranscriptVirtualMeasurements,
  TRANSCRIPT_BOTTOM_SPACER,
  TRANSCRIPT_ROW_ESTIMATE,
  TRANSCRIPT_VIRTUAL_OVERSCAN,
} from "./transcript-virtual-cache";
import {
  scheduleConnectedMeasure,
  TRANSCRIPT_ROW_MEASURE_EVENT,
} from "./transcript-measure";
import { isRemoteBrowserRenderer } from "./remote-ui-projection";
import { isMobileRemoteSurface } from "./mobile-surface";

/**
 * The virtualized transcript timeline.
 *
 * ONE instance per session (the caller keys it): entry geometry, measurement
 * cache, and scroll offset are all resolved at construction, so a session
 * paints at its final position on the first frame. Settled, live, pending, and
 * thinking rows share this list; bottom anchoring and reflow compensation are
 * owned by virtual-core.
 */
function measureTranscriptRow(element: Element, entry?: ResizeObserverEntry): number {
  if (!(element instanceof HTMLElement) || !element.isConnected) {
    return Math.max(1, element instanceof HTMLElement ? element.offsetHeight : 0) || 1;
  }
  const box = entry?.borderBoxSize?.[0];
  const observed = Number(box?.blockSize);
  if (Number.isFinite(observed) && observed > 0) return Math.round(observed);
  const rect = element.getBoundingClientRect().height;
  if (rect > 0) return Math.round(rect);
  // A row is never zero-tall; a headless layout (jsdom) that reports no box
  // still has to leave the range resolvable.
  return Math.max(1, element instanceof HTMLElement ? element.offsetHeight : 0);
}

// Newer virtual cores expose getLogicalScrollOffset(); the resolved core
// predates it, so read the scrollOffset + pending scrollAdjustments pair here.
function logicalScrollOffset(
  instance: Virtualizer<HTMLDivElement, HTMLDivElement>,
): number {
  const adjustments = Number(
    (instance as unknown as { scrollAdjustments?: number }).scrollAdjustments,
  ) || 0;
  return (instance.scrollOffset ?? 0) + adjustments;
}

type SelectionPoint = { node: Node; offset: number };

function firstTextPoint(element: Element): SelectionPoint {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.textContent) return { node, offset: 0 };
  }
  return { node: element, offset: 0 };
}

function lastTextPoint(element: Element): SelectionPoint {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let last: Node | null = null;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.textContent) last = node;
  }
  if (!last) return { node: element, offset: element.childNodes.length };
  return { node: last, offset: last.textContent?.length ?? 0 };
}

function caretPointFromPointer(x: number, y: number): SelectionPoint | null {
  const doc = document as Document & {
    caretPositionFromPoint?(cx: number, cy: number): { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?(cx: number, cy: number): Range | null;
  };
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

export function TranscriptList({
  sessionKey,
  rows,
  viewport,
  content,
  shouldAnchorBottom: anchorBottomProp,
  scrollToEndRef,
  setAnchorBottomRef,
  renderRow,
  markProgrammaticScroll,
  hasScrollGesture,
}: {
  sessionKey: string;
  rows: readonly TranscriptRowModel[];
  viewport: RefObject<HTMLDivElement | null>;
  content: MutableRefObject<HTMLDivElement | null>;
  shouldAnchorBottom: boolean;
  scrollToEndRef: MutableRefObject<(behavior?: ScrollBehavior) => void>;
  /** The follow hook flips the anchor here the instant it decides, without
   *  waiting for the render that carries `shouldAnchorBottom`. */
  setAnchorBottomRef?: MutableRefObject<(bottom: boolean) => void>;
  renderRow: (row: TranscriptRowModel) => ReactNode;
  /** Every offset this list writes is reported to the follow hook, which
   *  would otherwise read the core's own scrolls as a reader gesture. */
  markProgrammaticScroll?: (top: number, intended?: number) => void;
  /** True from the first wheel/touch/drag intent through its inertial tail. */
  hasScrollGesture: () => boolean;
}) {
  const spacer = useRef<HTMLDivElement>(null);
  // Web snapshots and native scrolling can update in the same frame. Keep
  // positioning in React there so a later snapshot render cannot briefly
  // overwrite direct DOM positions with an older virtual range. Phones are
  // excluded: reconciling every row on every scroll frame starves touch
  // handling on a projected phone (user: 버튼 반응성이 너무 안 좋다), so the
  // projected surface keeps the direct-DOM path.
  const reactOwnedLayout = isRemoteBrowserRenderer() && !isMobileRemoteSurface();
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // Reader intent reaches the core in the SAME task it was decided in: the
  // follow hook calls setAnchorBottomRef synchronously, and this override
  // keeps every render until React's own state catches up agreeing with it.
  // While the two disagreed, the core still owned the end anchor and rolled
  // each wheel notch back by the growth of the frame it landed in.
  const anchorOverride = useRef<boolean | null>(null);
  if (anchorOverride.current === anchorBottomProp) anchorOverride.current = null;
  const shouldAnchorBottom = anchorOverride.current ?? anchorBottomProp;
  const markProgrammaticScrollRef = useRef(markProgrammaticScroll);
  markProgrammaticScrollRef.current = markProgrammaticScroll;
  const hasScrollGestureRef = useRef(hasScrollGesture);
  hasScrollGestureRef.current = hasScrollGesture;
  // Sizes measured DURING a reader gesture for rows fully above the viewport
  // are deferred here. Applying them mid-gesture shifts the whole timeline
  // under the reader with no compensating write allowed (the pane "tears" and
  // snaps back at the bottom); applying them after the gesture lands the size
  // and its scroll compensation in one pre-paint transaction instead.
  const pendingResizes = useRef(new Map<unknown, { index: number; size: number }>());
  const resizeFlushFrame = useRef(0);
  const baseResizeItem = useRef<((index: number, size: number) => void) | null>(null);
  // Rows that changed size by more than a viewport stay in the range for two
  // frames: a rewrap must never unmount the rows the reader is looking at.
  const resizePinned = useRef<number[]>([]);
  const resizePinFrame = useRef(0);
  // Native text selection keeps DOM boundary points. If virtualization
  // unmounts either endpoint while Chromium auto-scrolls a drag, Chromium
  // reconnects the range to an unrelated surviving node and the highlight
  // appears to flip back up the transcript. Keep the selected row span
  // mounted until the browser selection collapses.
  type SelectionEndpoint = { key: unknown; index: number };
  type SelectionPin = { anchor: SelectionEndpoint; focus: SelectionEndpoint };
  const selectionPinned = useRef<SelectionPin | null>(null);
  const [, invalidateSelectionPin] = useState(0);
  const setSelectionPin = useCallback((next: SelectionPin | null) => {
    const current = selectionPinned.current;
    if (current === next
      || (current && next
        && Object.is(current.anchor.key, next.anchor.key)
        && Object.is(current.focus.key, next.focus.key))) return;
    selectionPinned.current = next;
    invalidateSelectionPin((version) => version + 1);
  }, []);
  const selectionPinnedIndexes = () => {
    const pin = selectionPinned.current;
    if (!pin) return [];
    const resolve = (endpoint: SelectionEndpoint) => {
      if (Object.is(rowsRef.current[endpoint.index]?.key, endpoint.key)) {
        return endpoint.index;
      }
      return rowsRef.current.findIndex((row) => Object.is(row.key, endpoint.key));
    };
    const anchor = resolve(pin.anchor);
    const focus = resolve(pin.focus);
    if (anchor < 0 || focus < 0) return [];
    const start = Math.min(anchor, focus);
    const end = Math.max(anchor, focus);
    return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
  };
  const activeIndexesRef = useRef<number[]>([]);
  let activeIndex = -1;
  rows.forEach((row, index) => {
    if ("active" in row && row.active) activeIndex = index;
  });
  activeIndexesRef.current = activeIndex < 0 ? [] : [activeIndex];
  // Mount-time only: this component is remounted per session. The real
  // measurements are replayed immediately and corrected by virtual-core if
  // the current width wraps them differently.
  const restored = useMemo(
    () => readTranscriptVirtualSnapshot(sessionKey),
    [sessionKey],
  );
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => TRANSCRIPT_ROW_ESTIMATE,
    getItemKey: (index) => rowsRef.current[index]?.key ?? `row:${index}`,
    measureElement: measureTranscriptRow,
    overscan: TRANSCRIPT_VIRTUAL_OVERSCAN,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor({ ...range, overscan: TRANSCRIPT_VIRTUAL_OVERSCAN });
      return [...new Set([
        ...resizePinned.current,
        ...selectionPinnedIndexes(),
        ...indexes,
        ...activeIndexesRef.current,
      ])].filter((index) => index >= 0 && index < rows.length)
        .sort((a, b) => a - b);
    },
    initialOffset: () => (shouldAnchorBottom ? Number.MAX_SAFE_INTEGER : 0),
    initialMeasurementsCache: restored?.measurements,
    // Reader intent wins immediately. Keeping end anchoring active inside the
    // 80px return band let a small upward wheel move get reversed by the next
    // append or row measurement even after the follow hook had detached.
    anchorTo: shouldAnchorBottom ? "end" : "start",
    followOnAppend: shouldAnchorBottom,
    // While the tail is owned, every append and measured-size delta is an
    // end pin. An 80px band lost tall rows in a short split and invited a
    // second scrollToEnd writer. Reader release flips followOnAppend off.
    scrollEndThreshold: 80,
    paddingEnd: TRANSCRIPT_BOTTOM_SPACER,
    // The virtual core commits its state to the DOM in the same task as every
    // notify. React's default async rerender let the core
    // move scrollTop pre-paint while rows still painted at their previous
    // translateY — the width-drag shake/ghosting. Direct DOM updates restore
    // that commit timing: row transforms and the container height are
    // written inside the core transaction, and React reconciles on range
    // changes only.
    directDomUpdates: !reactOwnedLayout,
    // Keep every row in the transcript's ONE paint layer. Transform mode
    // promotes each row independently; when a deferred measurement and the
    // final native wheel frame land together at the bottom, Chromium can
    // present those compositor layers from different scroll phases and draw
    // the visible horizontal tear. Top-position writes still land in the same
    // direct pre-paint transaction, without per-row compositor surfaces.
    directDomUpdatesMode: "position",
    // Grow the spacer before a programmatic write so Chrome cannot clamp the
    // requested offset against the previous total height.
    scrollToFn: (offset, options, instance) => {
      if (spacer.current) spacer.current.style.height = `${instance.getTotalSize()}px`;
      elementScroll(offset, options, instance);
      // Report the offset that actually landed (and the requested one, which a
      // smooth write only reaches later) so the follow hook can tell this
      // write apart from a reader scroll.
      const element = viewport.current;
      const intended = offset + (options?.adjustments ?? 0);
      markProgrammaticScrollRef.current?.(element ? element.scrollTop : intended, intended);
    },
  });
  const indexForPendingKey = useCallback((key: unknown, hint: number) => {
    if (rowsRef.current[hint]?.key === key) return hint;
    return rowsRef.current.findIndex((row) => row.key === key);
  }, []);
  const flushDeferredResizes = useCallback(() => {
    const apply = baseResizeItem.current;
    const pending = pendingResizes.current;
    if (!apply || pending.size === 0) return;
    pending.forEach((entry, key) => {
      const at = indexForPendingKey(key, entry.index);
      if (at >= 0) apply(at, entry.size);
    });
    pending.clear();
  }, [indexForPendingKey]);
  const pumpDeferredResizes = useCallback(() => {
    resizeFlushFrame.current = 0;
    const pending = pendingResizes.current;
    if (pending.size === 0) return;
    // Full flush waits for the gesture window AND the native ramp: the ramp
    // outlives the window, and sizes applied mid-ramp shift content before
    // the (deferred) compensation can land — flushing at true scroll idle
    // keeps size and compensation in one pre-paint transaction.
    if (!hasScrollGestureRef.current() && !virtualizerRef.current.isScrolling) {
      flushDeferredResizes();
      return;
    }
    // A pending row the reader scrolled back INTO must not keep painting at
    // stale geometry. It is no longer fully above the offset, so the resize
    // applies without a compensation write and cannot reverse the gesture.
    const instance = virtualizerRef.current;
    const offset = logicalScrollOffset(instance);
    pending.forEach((entry, key) => {
      const at = indexForPendingKey(key, entry.index);
      if (at < 0) {
        pending.delete(key);
        return;
      }
      const measured = instance.measurementsCache[at];
      if (measured && measured.end > offset) {
        pending.delete(key);
        baseResizeItem.current?.(at, entry.size);
      }
    });
    if (pending.size > 0) {
      resizeFlushFrame.current = window.requestAnimationFrame(pumpDeferredResizes);
    }
  }, [flushDeferredResizes, indexForPendingKey]);
  const scheduleResizeFlush = useCallback(() => {
    if (resizeFlushFrame.current) return;
    resizeFlushFrame.current = window.requestAnimationFrame(pumpDeferredResizes);
  }, [pumpDeferredResizes]);
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;
  const scrollToEndQueued = useRef(false);
  const pinFollowEnd = useRef(() => {});
  pinFollowEnd.current = () => {
    // ONE end: the native wheel stop. Wrap, streamed script, and new rows
    // all land here. Same-tick callers share the write so a measure after
    // append cannot pin again and walk the tail down.
    if (hasScrollGestureRef.current() || scrollToEndQueued.current) return;
    scrollToEndQueued.current = true;
    queueMicrotask(() => {
      scrollToEndQueued.current = false;
      if (hasScrollGestureRef.current()) return;
      const instance = virtualizerRef.current;
      if (spacer.current) spacer.current.style.height = `${instance.getTotalSize()}px`;
      const element = viewport.current;
      if (!element) return;
      const max = Math.max(0, element.scrollHeight - element.clientHeight);
      const core = instance as unknown as {
        scrollOffset: number | null;
        scrollAdjustments: number;
        _iosDeferredAdjustment: number;
        _deferredFlushTimerId: number | null;
        targetWindow: (Window & typeof globalThis) | null;
      };
      if (core._deferredFlushTimerId != null && core.targetWindow) {
        core.targetWindow.clearTimeout(core._deferredFlushTimerId);
        core._deferredFlushTimerId = null;
      }
      core._iosDeferredAdjustment = 0;
      core.scrollAdjustments = 0;
      core.scrollOffset = max;
      if (Math.abs(element.scrollTop - max) >= 1) element.scrollTop = max;
      markProgrammaticScrollRef.current?.(element.scrollTop, max);
    });
  };
  // React re-renders reuse one virtualizer instance. Patch resizeItem exactly
  // once instead of wrapping the previous wrapper again on every render.
  const patchedVirtualizer = useRef<Virtualizer<HTMLDivElement, HTMLDivElement> | null>(null);
  if (patchedVirtualizer.current !== virtualizer) {
    patchedVirtualizer.current = virtualizer;
    const resizeItem = virtualizer.resizeItem;
    baseResizeItem.current = resizeItem;
    virtualizer.scrollToEnd = () => {
      pinFollowEnd.current();
    };
    virtualizer.resizeItem = (index, size) => {
      const element = viewport.current;
      const measured = virtualizer.measurementsCache[index];
      // Reader gesture + row fully above the reading offset: DEFER. Never
      // drop — a dropped delta leaves the reader displaced by exactly that
      // delta once the geometry it saw is recomputed.
      if (measured && hasScrollGestureRef.current()
        && measured.end <= logicalScrollOffset(virtualizer)) {
        pendingResizes.current.set(measured.key, { index, size });
        scheduleResizeFlush();
        return;
      }
      pendingResizes.current.delete(measured?.key ?? index);
      const previous = measured
        ? virtualizer.itemSizeCache.get(measured.key) ?? measured.size
        : undefined;
      if (element && previous !== undefined && Math.abs(size - previous) > element.clientHeight) {
        const view = element.getBoundingClientRect();
        resizePinned.current = [...element.querySelectorAll<HTMLElement>(".transcript-virtual-row")]
          .filter((row) => {
            const rect = row.getBoundingClientRect();
            return rect.bottom > view.top && rect.top < view.bottom;
          })
          .map((row) => Number(row.dataset.index))
          .filter(Number.isFinite);
        if (resizePinFrame.current) window.cancelAnimationFrame(resizePinFrame.current);
        resizePinFrame.current = window.requestAnimationFrame(() => {
          resizePinFrame.current = window.requestAnimationFrame(() => {
            resizePinFrame.current = 0;
            resizePinned.current = [];
          });
        });
      }
      resizeItem(index, size);
      if (virtualizer.options.followOnAppend || virtualizer.options.anchorTo === "end") {
        pinFollowEnd.current();
      }
    };
  }
  // Rows measured above an IDLE reading offset keep the reader's content
  // still. Never write scrollTop during wheel/touch/scrollbar motion: a late
  // row measurement otherwise adds its positive correction to Chromium's
  // negative wheel ramp and briefly reverses the visible direction near the
  // history boundary. The follow hook tracks only non-programmatic reader
  // motion, so virtual-core's own corrective scroll does not block the next
  // idle measurement in a settling burst.
  // The end-anchor (wasAtEnd) total-size delta bypasses this predicate by
  // design; shouldDeferScrollAdjustment below plus the core's own
  // isScrolling deferral hold that write too until motion is idle, so the
  // bottom pin can no longer cancel a live wheel ramp (the "tears and snaps
  // back at the bottom" writer confirmed via CDP scrollTop-setter traces).
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    if (hasScrollGestureRef.current()) return false;
    return item.end <= logicalScrollOffset(instance);
  };
  virtualizer.shouldDeferScrollAdjustment = () => hasScrollGestureRef.current();
  const measureRow = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    // The FIRST measurement of a row rides the SAME commit that appended it.
    // Deferring it to the next frame left the new row in geometry at the flat
    // estimate, so followOnAppend scrolled to an estimated end and the real
    // height then arrived as a SECOND scroll write — the two-step lurch the
    // reader sees while the tail is followed.
    if (element.isConnected) virtualizerRef.current.measureElement(element);
    // Content that settles AFTER that commit (fonts, promoted Markdown, lazy
    // media) still re-measures once through the connected guard.
    scheduleConnectedMeasure(element, (node) => {
      virtualizerRef.current.measureElement(node);
    });
  }, []);
  const bindSpacer = useCallback((element: HTMLDivElement | null) => {
    spacer.current = element;
    content.current = element;
    // Direct DOM updates keep the spacer height current between React commits.
    virtualizerRef.current.containerRef(element);
  }, [content]);

  useLayoutEffect(() => {
    const root = spacer.current;
    if (!root) return undefined;
    const measureDisclosureRow = (event: Event) => {
      const row = event.target instanceof HTMLElement
        ? event.target.closest<HTMLDivElement>(".transcript-virtual-row")
        : null;
      if (!row || row.parentElement !== root) return;
      // Tool disclosure commits already changed the natural DOM height. Feed
      // that exact box to the virtualizer before paint, so its row cache,
      // spacer height, scrollTop correction, and follow ownership advance as
      // one transaction rather than an observer frame apart.
      virtualizerRef.current.measureElement(row);
    };
    root.addEventListener(TRANSCRIPT_ROW_MEASURE_EVENT, measureDisclosureRow);
    return () => root.removeEventListener(TRANSCRIPT_ROW_MEASURE_EVENT, measureDisclosureRow);
  }, [sessionKey]);

  useLayoutEffect(() => () => {
    // Pending gesture-deferred sizes are part of the truth this snapshot
    // promises to replay on re-entry.
    flushDeferredResizes();
    rememberTranscriptVirtualMeasurements(
      sessionKey,
      virtualizerRef.current.takeSnapshot(),
    );
  }, [flushDeferredResizes, sessionKey, viewport]);

  useLayoutEffect(() => {
    const scrollToEnd = () => {
      pinFollowEnd.current();
    };
    scrollToEndRef.current = scrollToEnd;
    return () => {
      if (scrollToEndRef.current === scrollToEnd) {
        scrollToEndRef.current = () => {};
      }
    };
  }, [scrollToEndRef]);

  useLayoutEffect(() => {
    if (!setAnchorBottomRef) return undefined;
    const setAnchorBottom = (bottom: boolean) => {
      anchorOverride.current = bottom;
      const instance = virtualizerRef.current;
      const anchorTo = bottom ? "end" : "start";
      if (instance.options.anchorTo === anchorTo
        && instance.options.followOnAppend === bottom
        && instance.options.scrollEndThreshold === 80) return;
      instance.setOptions({
        ...instance.options,
        anchorTo,
        followOnAppend: bottom,
        scrollEndThreshold: 80,
      });
    };
    setAnchorBottomRef.current = setAnchorBottom;
    return () => {
      if (setAnchorBottomRef.current === setAnchorBottom) {
        setAnchorBottomRef.current = () => {};
      }
    };
  }, [setAnchorBottomRef]);

  useEffect(() => {
    const root = viewport.current;
    if (!root) return undefined;
    let selecting = false;
    let seed: SelectionEndpoint | null = null;
    let restoring = false;
    let seedPoint: SelectionPoint | null = null;
    let seedY = 0;
    let lastGood: { anchor: SelectionPoint; focus: SelectionPoint } | null = null;
    let lastPointer = { x: 0, y: 0 };
    const endpointForNode = (node: Node | null): SelectionEndpoint | null => {
      const element = node instanceof Element ? node : node?.parentElement;
      const row = element?.closest<HTMLElement>(".transcript-virtual-row");
      if (!row || !root.contains(row)) return null;
      const index = Number(row.dataset.index);
      const key = rowsRef.current[index]?.key;
      return Number.isInteger(index) && key !== undefined ? { key, index } : null;
    };
    const markSelecting = (active: boolean) => {
      if (active) document.documentElement.dataset.transcriptSelecting = "true";
      else delete document.documentElement.dataset.transcriptSelecting;
    };
    const rowElement = (index: number) =>
      root.querySelector<HTMLElement>(`.transcript-virtual-row[data-index="${index}"]`);
    const pointerOverTranscriptRow = () => {
      const el = document.elementFromPoint(lastPointer.x, lastPointer.y);
      const row = el instanceof Element ? el.closest(".transcript-virtual-row") : null;
      return Boolean(row && root.contains(row));
    };
    const rememberGood = (selection: Selection) => {
      if (!selection.anchorNode || !selection.focusNode) return;
      if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return;
      if (selection.isCollapsed) return;
      lastGood = {
        anchor: { node: selection.anchorNode, offset: selection.anchorOffset },
        focus: { node: selection.focusNode, offset: selection.focusOffset },
      };
    };
    const applyRange = (anchor: SelectionPoint, focus: SelectionPoint) => {
      const selection = window.getSelection();
      if (!selection) return;
      if (selection.anchorNode === anchor.node && selection.anchorOffset === anchor.offset
        && selection.focusNode === focus.node && selection.focusOffset === focus.offset) {
        return;
      }
      restoring = true;
      try {
        selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
      } catch {
        restoring = false;
      }
    };
    const clampOutside = () => {
      if (!selecting || !seed) return;
      if (lastGood && root.contains(lastGood.anchor.node) && root.contains(lastGood.focus.node)) {
        applyRange(lastGood.anchor, lastGood.focus);
        return;
      }
      const goingDown = lastPointer.y >= seedY;
      const pin = selectionPinned.current;
      const otherIndex = pin
        ? (goingDown
          ? Math.max(seed.index, pin.focus.index, pin.anchor.index)
          : Math.min(seed.index, pin.focus.index, pin.anchor.index))
        : seed.index;
      const seedRow = rowElement(seed.index);
      const otherRow = rowElement(otherIndex) ?? seedRow;
      const start = seedPoint && root.contains(seedPoint.node)
        ? seedPoint
        : (seedRow ? (goingDown ? firstTextPoint(seedRow) : lastTextPoint(seedRow)) : null);
      const end = otherRow
        ? (goingDown ? lastTextPoint(otherRow) : firstTextPoint(otherRow))
        : null;
      if (start && end) applyRange(start, end);
    };
    const selectionCrossedSeed = (
      anchor: SelectionEndpoint | null,
      focus: SelectionEndpoint | null,
    ) => {
      if (!seed || !anchor || !focus) return false;
      const goingDown = lastPointer.y >= seedY;
      const lo = Math.min(anchor.index, focus.index);
      const hi = Math.max(anchor.index, focus.index);
      return goingDown ? lo < seed.index : hi > seed.index;
    };
    const syncSelectionPin = () => {
      if (restoring) {
        restoring = false;
        return;
      }
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        if (!selecting) setSelectionPin(null);
        else if (!pointerOverTranscriptRow()) clampOutside();
        return;
      }
      const anchor = endpointForNode(selection.anchorNode);
      const focus = endpointForNode(selection.focusNode);
      if (selecting && (selectionCrossedSeed(anchor, focus) || !pointerOverTranscriptRow())) {
        clampOutside();
        return;
      }
      if (anchor && focus) {
        rememberGood(selection);
        setSelectionPin({ anchor, focus });
        return;
      }
      // Pointer autoscroll can temporarily place the focus just outside the
      // viewport. Preserve the last in-transcript boundary until it re-enters.
      const inside = anchor ?? focus;
      if (selecting && seed && inside) setSelectionPin({ anchor: seed, focus: inside });
      else if (!selecting && !anchor && !focus) setSelectionPin(null);
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const endpoint = endpointForNode(event.target as Node | null);
      if (!endpoint) {
        selecting = false;
        seed = null;
        seedPoint = null;
        seedY = 0;
        lastGood = null;
        markSelecting(false);
        return;
      }
      selecting = true;
      seed = endpoint;
      seedY = event.clientY;
      lastPointer = { x: event.clientX, y: event.clientY };
      seedPoint = caretPointFromPointer(event.clientX, event.clientY);
      lastGood = null;
      markSelecting(true);
      // Seed synchronously, before native autoscroll can move the first row
      // outside the virtual range.
      setSelectionPin({ anchor: endpoint, focus: endpoint });
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (!selecting) return;
      lastPointer = { x: event.clientX, y: event.clientY };
      if (!pointerOverTranscriptRow()) {
        // Chromium remaps an extending native range to the nearest selectable
        // text when the pointer enters the non-selectable composer. Cancel that
        // default before paint; selectionchange is too late and exposes one
        // frame with the range inverted above its seed.
        event.preventDefault();
        clampOutside();
      }
    };
    const handleMouseMove = (event: MouseEvent) => {
      if (!selecting) return;
      lastPointer = { x: event.clientX, y: event.clientY };
      if (!pointerOverTranscriptRow()) {
        // Text-range extension is a mouse default action in Chromium even
        // when Pointer Events are enabled, so cancel the compatibility event
        // as well as pointermove.
        event.preventDefault();
        clampOutside();
      }
    };
    const handleSelectStart = (event: Event) => {
      if (!selecting) return;
      const target = event.target as Node | null;
      if (target && !root.contains(target)) event.preventDefault();
    };
    const finishSelection = () => {
      if (!selecting) return;
      syncSelectionPin();
      selecting = false;
      seed = null;
      seedPoint = null;
      seedY = 0;
      lastGood = null;
      markSelecting(false);
      if (window.getSelection()?.isCollapsed !== false) setSelectionPin(null);
    };
    root.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointermove", handlePointerMove, true);
    document.addEventListener("mousemove", handleMouseMove, true);
    document.addEventListener("selectstart", handleSelectStart, true);
    document.addEventListener("selectionchange", syncSelectionPin);
    document.addEventListener("pointerup", finishSelection, true);
    document.addEventListener("pointercancel", finishSelection, true);
    return () => {
      root.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointermove", handlePointerMove, true);
      document.removeEventListener("mousemove", handleMouseMove, true);
      document.removeEventListener("selectstart", handleSelectStart, true);
      document.removeEventListener("selectionchange", syncSelectionPin);
      document.removeEventListener("pointerup", finishSelection, true);
      document.removeEventListener("pointercancel", finishSelection, true);
      markSelecting(false);
      selectionPinned.current = null;
    };
  }, [sessionKey, setSelectionPin, viewport]);

  useEffect(() => () => {
    if (resizePinFrame.current) window.cancelAnimationFrame(resizePinFrame.current);
    if (resizeFlushFrame.current) window.cancelAnimationFrame(resizeFlushFrame.current);
  }, []);

  const virtualRows = virtualizer.getVirtualItems();
  return (
    // directDomUpdates owns this height synchronously through containerRef.
    // A React height prop can commit an older render after a native wheel
    // reaches the bottom and temporarily clip one pane at stale geometry.
    <div className="transcript-virtual-space" ref={bindSpacer}
      style={reactOwnedLayout ? { height: `${virtualizer.getTotalSize()}px` } : undefined}>
      {virtualRows.map((virtualRow) => {
        const row = rows[virtualRow.index];
        if (!row) return null;
        const next = rows[virtualRow.index + 1];
        const turnEnd = !next || next._tag === "TurnGap";
        return (
          // A row binds position AND measurement to one element.
          // Position and measurement therefore share the
          // OUTER box here, so applyDirectStyles (elementsCache) moves exactly
          // the element the ResizeObserver measures — in the same pre-paint
          // transaction. The row keeps its natural content height; geometry
          // corrections land before paint, so nothing is clipped a frame late.
          <div className="transcript-virtual-row" key={virtualRow.key}
            data-index={virtualRow.index}
            data-timeline-key={String(virtualRow.key)}
            style={reactOwnedLayout
              ? { top: `${virtualRow.start - virtualizer.options.scrollMargin}px` }
              : undefined}
            ref={measureRow}>
            <div className="transcript-virtual-row-content"
              data-slot="session-turn-message-container" data-index={virtualRow.index}
              data-tag={row._tag} data-turn-end={turnEnd ? "true" : undefined}>
              {renderRow(row)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
