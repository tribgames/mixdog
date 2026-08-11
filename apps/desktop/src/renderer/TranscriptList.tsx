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
import { scheduleConnectedMeasure } from "./transcript-measure";

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
  const coldBottomMount = !restored?.measurements?.length && shouldAnchorBottom;
  const [renderOverscan, setRenderOverscan] = useState(
    () => (restored?.measurements?.length || coldBottomMount ? 6 : TRANSCRIPT_VIRTUAL_OVERSCAN),
  );
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => TRANSCRIPT_ROW_ESTIMATE,
    getItemKey: (index) => rowsRef.current[index]?.key ?? `row:${index}`,
    measureElement: measureTranscriptRow,
    overscan: 50,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor({ ...range, overscan: renderOverscan });
      return [...new Set([
        ...resizePinned.current,
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
    scrollEndThreshold: 80,
    paddingEnd: TRANSCRIPT_BOTTOM_SPACER,
    // The virtual core commits its state to the DOM in the same task as every
    // notify. React's default async rerender let the core
    // move scrollTop pre-paint while rows still painted at their previous
    // translateY — the width-drag shake/ghosting. Direct DOM updates restore
    // that commit timing: row transforms and the container height are
    // written inside the core transaction, and React reconciles on range
    // changes only.
    directDomUpdates: true,
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
  // React re-renders reuse one virtualizer instance. Patch resizeItem exactly
  // once instead of wrapping the previous wrapper again on every render.
  const patchedVirtualizer = useRef<Virtualizer<HTMLDivElement, HTMLDivElement> | null>(null);
  if (patchedVirtualizer.current !== virtualizer) {
    patchedVirtualizer.current = virtualizer;
    const resizeItem = virtualizer.resizeItem;
    baseResizeItem.current = resizeItem;
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
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;
  const overscanFrame = useRef(0);
  const bottomAnchorFrame = useRef(0);
  const bottomAnchorSession = useRef("");
  // Prepend anchor: when rows are inserted ABOVE the reader (older
  // history, cold restore growth), keep the previously visible top row still
  // by correcting scrollTop against its key + viewport offset.
  const readingAnchor = useRef<{ key: string; offset: number } | null>(null);
  const prependAnchorFrame = useRef(0);
  const prevFirstKey = useRef<string | number | null>(rows[0]?.key ?? null);
  const prevRowCount = useRef(rows.length);
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
    const scrollToEnd = (behavior: ScrollBehavior = "auto") => {
      virtualizerRef.current.scrollToEnd({ behavior });
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
      if (instance.options.anchorTo === anchorTo) return;
      instance.setOptions({ ...instance.options, anchorTo, followOnAppend: bottom });
    };
    setAnchorBottomRef.current = setAnchorBottom;
    return () => {
      if (setAnchorBottomRef.current === setAnchorBottom) {
        setAnchorBottomRef.current = () => {};
      }
    };
  }, [setAnchorBottomRef]);

  useLayoutEffect(() => {
    // Warm the full overscan once per session entry. A follow release/reattach
    // must not schedule another pair of end writes: a small wheel movement can
    // re-enter the bottom band after its native scroll event, and those stale
    // frames would roll that movement back. Read the live core anchor at
    // delivery time so reader intent also cancels an entry frame already
    // waiting in the queue.
    overscanFrame.current = window.requestAnimationFrame(() => {
      if (virtualizerRef.current.options.anchorTo === "end") {
        virtualizerRef.current.scrollToEnd();
      }
      overscanFrame.current = window.requestAnimationFrame(() => {
        overscanFrame.current = 0;
        setRenderOverscan((current) =>
          current < TRANSCRIPT_VIRTUAL_OVERSCAN ? TRANSCRIPT_VIRTUAL_OVERSCAN : current);
        if (virtualizerRef.current.options.anchorTo === "end") {
          virtualizerRef.current.scrollToEnd();
        }
      });
    });
    return () => {
      if (!overscanFrame.current) return;
      window.cancelAnimationFrame(overscanFrame.current);
      overscanFrame.current = 0;
    };
  }, [sessionKey]);

  useLayoutEffect(() => {
    // Session entry resets the prepend-reading bookkeeping so a prior visit's
    // top-row anchor never corrects a different timeline.
    readingAnchor.current = null;
    prevFirstKey.current = rows[0]?.key ?? null;
    prevRowCount.current = rows.length;
    if (prependAnchorFrame.current) {
      window.cancelAnimationFrame(prependAnchorFrame.current);
      prependAnchorFrame.current = 0;
    }
  }, [sessionKey]);

  useLayoutEffect(() => {
    // Bottom anchor: one entry anchor per session key, the first
    // time the timeline has rows. Live appends are followed by the core's
    // followOnAppend — re-running this on every rows change added a second,
    // one-frame-late scroll writer.
    if (bottomAnchorSession.current === sessionKey || rows.length === 0) return undefined;
    bottomAnchorSession.current = sessionKey;
    if (!shouldAnchorBottom) return undefined;
    bottomAnchorFrame.current = window.requestAnimationFrame(() => {
      bottomAnchorFrame.current = 0;
      virtualizerRef.current.scrollToEnd();
    });
    return () => {
      if (!bottomAnchorFrame.current) return;
      window.cancelAnimationFrame(bottomAnchorFrame.current);
      bottomAnchorFrame.current = 0;
    };
  }, [rows.length, sessionKey, shouldAnchorBottom]);

  useLayoutEffect(() => {
    const root = viewport.current;
    const firstKey = rows[0]?.key ?? null;
    const count = rows.length;
    const prepended = prevRowCount.current > 0
      && count > prevRowCount.current
      && firstKey != null
      && firstKey !== prevFirstKey.current
      && !shouldAnchorBottom;
    prevFirstKey.current = firstKey;
    prevRowCount.current = count;
    if (!prepended || !root || !readingAnchor.current) return undefined;
    const anchor = readingAnchor.current;
    if (prependAnchorFrame.current) window.cancelAnimationFrame(prependAnchorFrame.current);
    let frames = 0;
    let stable = 0;
    const apply = () => {
      prependAnchorFrame.current = 0;
      const element = root.querySelector<HTMLElement>(
        `[data-timeline-key="${CSS.escape(String(anchor.key))}"]`,
      );
      if (element) {
        const delta = element.getBoundingClientRect().top
          - root.getBoundingClientRect().top
          - anchor.offset;
        if (Math.abs(delta) > 0.5) {
          root.scrollTop += delta;
          markProgrammaticScroll?.(root.scrollTop);
          stable = 0;
        } else {
          stable += 1;
        }
      }
      frames += 1;
      if (stable >= 8 || frames >= 60) return;
      prependAnchorFrame.current = window.requestAnimationFrame(apply);
    };
    prependAnchorFrame.current = window.requestAnimationFrame(apply);
    return () => {
      if (!prependAnchorFrame.current) return;
      window.cancelAnimationFrame(prependAnchorFrame.current);
      prependAnchorFrame.current = 0;
    };
  }, [markProgrammaticScroll, rows, shouldAnchorBottom, viewport]);

  useEffect(() => {
    const root = viewport.current;
    if (!root || shouldAnchorBottom) {
      readingAnchor.current = null;
      return undefined;
    }
    const capture = () => {
      const view = root.getBoundingClientRect();
      const candidates = [...root.querySelectorAll<HTMLElement>("[data-timeline-key]")]
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter((item) => item.rect.bottom > view.top && item.rect.top < view.bottom)
        .sort((a, b) => a.rect.top - b.rect.top);
      const top = candidates[0];
      const key = top?.element.dataset.timelineKey;
      if (!top || !key) return;
      readingAnchor.current = {
        key,
        offset: top.rect.top - view.top,
      };
    };
    capture();
    root.addEventListener("scroll", capture, { passive: true });
    return () => root.removeEventListener("scroll", capture);
  }, [shouldAnchorBottom, sessionKey, viewport]);

  useEffect(() => () => {
    if (resizePinFrame.current) window.cancelAnimationFrame(resizePinFrame.current);
    if (overscanFrame.current) window.cancelAnimationFrame(overscanFrame.current);
    if (bottomAnchorFrame.current) window.cancelAnimationFrame(bottomAnchorFrame.current);
    if (prependAnchorFrame.current) window.cancelAnimationFrame(prependAnchorFrame.current);
    if (resizeFlushFrame.current) window.cancelAnimationFrame(resizeFlushFrame.current);
  }, []);

  const virtualRows = virtualizer.getVirtualItems();
  return (
    // directDomUpdates owns this height synchronously through containerRef.
    // A React height prop can commit an older render after a native wheel
    // reaches the bottom and temporarily clip one pane at stale geometry.
    <div className="transcript-virtual-space" ref={bindSpacer}>
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
