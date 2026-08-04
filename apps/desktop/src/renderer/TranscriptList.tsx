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
  const box = entry?.borderBoxSize?.[0];
  const observed = Number(box?.blockSize);
  if (Number.isFinite(observed) && observed > 0) return Math.round(observed);
  const rect = element.getBoundingClientRect().height;
  if (rect > 0) return Math.round(rect);
  // A row is never zero-tall; a headless layout (jsdom) that reports no box
  // still has to leave the range resolvable.
  return Math.max(1, element instanceof HTMLElement ? element.offsetHeight : 0);
}

// OpenCode's core exposes getLogicalScrollOffset(); the resolved core predates
// it, so read the same scrollOffset + pending scrollAdjustments pair directly.
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
  shouldAnchorBottom,
  scrollToEndRef,
  renderRow,
}: {
  sessionKey: string;
  rows: readonly TranscriptRowModel[];
  viewport: RefObject<HTMLDivElement | null>;
  content: MutableRefObject<HTMLDivElement | null>;
  shouldAnchorBottom: boolean;
  scrollToEndRef: MutableRefObject<(behavior?: ScrollBehavior) => void>;
  renderRow: (row: TranscriptRowModel) => ReactNode;
}) {
  const spacer = useRef<HTMLDivElement>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
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
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 80,
    paddingEnd: TRANSCRIPT_BOTTOM_SPACER,
    // OpenCode's Solid timeline commits virtual state to the DOM in the same
    // task as every core notify. React's default async rerender let the core
    // move scrollTop pre-paint while rows still painted at their previous
    // translateY — the width-drag shake/ghosting. Direct DOM updates restore
    // Solid's commit timing: row transforms and the container height are
    // written inside the core transaction, and React reconciles on range
    // changes only.
    directDomUpdates: true,
    // Grow the spacer before a programmatic write so Chrome cannot clamp the
    // requested offset against the previous total height.
    scrollToFn: (offset, options, instance) => {
      if (spacer.current) spacer.current.style.height = `${instance.getTotalSize()}px`;
      elementScroll(offset, options, instance);
    },
  });
  // React re-renders reuse one virtualizer instance. Patch resizeItem exactly
  // once instead of wrapping the previous wrapper again on every render.
  const patchedVirtualizer = useRef<Virtualizer<HTMLDivElement, HTMLDivElement> | null>(null);
  if (patchedVirtualizer.current !== virtualizer) {
    patchedVirtualizer.current = virtualizer;
    const resizeItem = virtualizer.resizeItem;
    virtualizer.resizeItem = (index, size) => {
      const element = viewport.current;
      const measured = virtualizer.measurementsCache[index];
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
  // OpenCode: rows measured above the reading offset keep the reader's content
  // still. At the end, virtual-core's anchorTo:"end" wasAtEnd path applies the
  // total-size delta BEFORE this predicate is consulted, so the bottom pin has
  // exactly one writer during a rewrap storm (pane drag, window resize).
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    item.end <= logicalScrollOffset(instance);
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;
  const overscanFrame = useRef(0);
  const bottomAnchorFrame = useRef(0);
  const bottomAnchorSession = useRef("");
  const measureRow = useCallback((element: HTMLDivElement | null) => {
    virtualizerRef.current.measureElement(element);
  }, []);
  const bindSpacer = useCallback((element: HTMLDivElement | null) => {
    spacer.current = element;
    content.current = element;
    // Direct DOM updates keep the spacer height current between React commits.
    virtualizerRef.current.containerRef(element);
  }, [content]);

  useLayoutEffect(() => () => {
    rememberTranscriptVirtualMeasurements(
      sessionKey,
      virtualizerRef.current.takeSnapshot(),
    );
  }, [sessionKey, viewport]);

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
    overscanFrame.current = window.requestAnimationFrame(() => {
      if (shouldAnchorBottom) virtualizerRef.current.scrollToEnd();
      overscanFrame.current = window.requestAnimationFrame(() => {
        overscanFrame.current = 0;
        setRenderOverscan((current) =>
          current < TRANSCRIPT_VIRTUAL_OVERSCAN ? TRANSCRIPT_VIRTUAL_OVERSCAN : current);
        if (shouldAnchorBottom) virtualizerRef.current.scrollToEnd();
      });
    });
    return () => {
      if (!overscanFrame.current) return;
      window.cancelAnimationFrame(overscanFrame.current);
      overscanFrame.current = 0;
    };
  }, [sessionKey, shouldAnchorBottom]);

  useLayoutEffect(() => {
    // OpenCode maybeAnchorBottom: one entry anchor per session key, the first
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

  useEffect(() => () => {
    if (resizePinFrame.current) window.cancelAnimationFrame(resizePinFrame.current);
    if (overscanFrame.current) window.cancelAnimationFrame(overscanFrame.current);
    if (bottomAnchorFrame.current) window.cancelAnimationFrame(bottomAnchorFrame.current);
  }, []);

  const virtualRows = virtualizer.getVirtualItems();
  return (
    <div className="transcript-virtual-space" ref={bindSpacer}
      style={{ height: `${virtualizer.getTotalSize()}px` }}>
      {virtualRows.map((virtualRow) => {
        const row = rows[virtualRow.index];
        if (!row) return null;
        const next = rows[virtualRow.index + 1];
        const turnEnd = !next || next._tag === "TurnGap";
        return (
          // OpenCode's Solid rows bind position AND measurement to one
          // reactive element. Position and measurement therefore share the
          // OUTER box here, so applyDirectStyles (elementsCache) moves exactly
          // the element the ResizeObserver measures — in the same pre-paint
          // transaction. The row keeps its natural content height; geometry
          // corrections land before paint, so nothing is clipped a frame late.
          <div className="transcript-virtual-row" key={virtualRow.key}
            data-index={virtualRow.index} ref={measureRow}
            style={{ transform: `translateY(${virtualRow.start}px)` }}>
            <div className="transcript-virtual-row-content"
              data-slot="session-turn-message-container" data-index={virtualRow.index}
              data-tag={row._tag} data-turn-end={turnEnd ? "true" : undefined}>
              {renderRow(row)}
            </div>
          </div>
        );
      })}
      {rows.length > 0 && <div className="transcript-bottom-spacer" aria-hidden="true"
        style={{
          height: `${TRANSCRIPT_BOTTOM_SPACER}px`,
          transform: `translateY(${virtualizer.getTotalSize() - TRANSCRIPT_BOTTOM_SPACER}px)`,
        }} />}
    </div>
  );
}
