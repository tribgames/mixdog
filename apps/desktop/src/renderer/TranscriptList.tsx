import { defaultRangeExtractor, elementScroll, useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
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
} from 'react';
import type { TranscriptRowModel } from './transcript-rows';
import {
  readTranscriptVirtualSnapshot,
  rememberTranscriptVirtualMeasurements,
  TRANSCRIPT_BOTTOM_SPACER,
  TRANSCRIPT_ROW_ESTIMATE,
  TRANSCRIPT_VIRTUAL_OVERSCAN,
} from './transcript-virtual-cache';
import { createTranscriptEndPin } from './transcript-end-pin';
import { logTranscriptScroll, transcriptScrollDiagnosticsEnabled } from './transcript-scroll-diagnostics';
import { registerTranscriptScrollGeometry } from './use-transcript-follow';
import {
  attachTranscriptSelectionDrag,
  type TranscriptSelectionEndpoint,
  type TranscriptSelectionPin,
} from './transcript-selection-drag';

/** End band while the tail is owned: every append and measured-size delta is
 *  an end pin (see the virtualizer options below). */
const SCROLL_END_THRESHOLD_PX = 80;

type TranscriptVirtualizer = Virtualizer<HTMLDivElement, HTMLDivElement>;

/** Core state the timeline writes around virtual-core's own scroll path. */
type CoreScrollState = {
  scrollOffset: number | null;
  scrollAdjustments: number;
  _intendedScrollOffset: number | null;
  getSize(): number;
  notify(sync: boolean): void;
};

const coreScrollState = (instance: TranscriptVirtualizer) => instance as unknown as CoreScrollState;

/** Row sizes come from the ResizeObserver's border box only. Every other call
 *  (ref registration, a detached node, a headless layout reporting no box)
 *  keeps the size the timeline already holds: a synchronous rect read per
 *  mounted row forced a layout of the whole list inside every commit. */
function measureTranscriptRow(element: Element, entry: ResizeObserverEntry | undefined, instance: TranscriptVirtualizer): number {
  const observed = Number(entry?.borderBoxSize?.[0]?.blockSize);
  if (Number.isFinite(observed) && observed > 0) return Math.round(observed);
  const index = instance.indexFromElement(element as HTMLDivElement);
  const key = instance.options.getItemKey(index);
  return instance.itemSizeCache.get(key) ?? instance.measurementsCache[index]?.size ?? TRANSCRIPT_ROW_ESTIMATE;
}

// Newer virtual cores expose getLogicalScrollOffset(); the resolved core
// predates it, so read the scrollOffset + pending scrollAdjustments pair here.
function logicalScrollOffset(instance: TranscriptVirtualizer): number {
  const adjustments = Number(coreScrollState(instance).scrollAdjustments) || 0;
  return (instance.scrollOffset ?? 0) + adjustments;
}

/** Viewport height as virtual-core last observed it (ResizeObserver). */
function viewportSize(instance: TranscriptVirtualizer): number {
  return coreScrollState(instance).getSize();
}

/** How long landed rows may keep re-measuring above a held reading anchor:
 *  from the landing, extended by each late size, never past the maximum. */
const READING_ANCHOR_HOLD_MS = 2_000;
const READING_ANCHOR_HOLD_MAX_MS = 6_000;

/** A row the reader is looking at and its offset from the viewport's top. */
type ReadingAnchor = { key: unknown; offset: number; index: number };

function positionalRowKey(row: TranscriptRowModel): boolean {
  const missing = (id: unknown) => id === undefined || id === null;
  if (row._tag === 'UserMessage' || row._tag === 'AssistantPart') return missing(row.item.id);
  if (row._tag === 'ToolActivity') return row.items.every((item) => missing(item.id));
  return false;
}

/** The first row under the reading offset that `nextRows` still carries, or
 *  the next one after it that does. Must run before the virtualizer resolves
 *  `nextRows`: its measurement cache still describes `previousRows`, whose
 *  keys are read from the rows themselves (the cache resolves keys lazily
 *  through the CURRENT rows). */
function captureReadingAnchor(
  instance: TranscriptVirtualizer,
  previousRows: readonly TranscriptRowModel[],
  nextRows: readonly TranscriptRowModel[],
  inset: number
): ReadingAnchor | null {
  const measurements = instance.measurementsCache;
  const count = Math.min(previousRows.length, measurements.length);
  if (count === 0) return null;
  const reading = logicalScrollOffset(instance);
  // The first row VISIBLE at the viewport's top edge: rows start `inset`
  // below the scroll origin, so one ending within that strip is still in view.
  const visibleTop = reading - inset;
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((measurements[middle]?.end ?? 0) <= visibleTop) low = middle + 1;
    else high = middle;
  }
  let survivors: Set<unknown> | null = null;
  for (let index = low; index < count; index += 1) {
    const row = previousRows[index];
    // A key derived from the row's position in the window (an item without
    // an id) names a DIFFERENT row once a page is prepended.
    if (!row || positionalRowKey(row)) continue;
    const key = row.key;
    if (!Object.is(nextRows[index]?.key, key)) {
      survivors ??= new Set<unknown>(nextRows.map((row) => row.key));
      if (!survivors.has(key)) continue;
    }
    return { key, offset: (measurements[index]?.start ?? 0) - reading, index };
  }
  return null;
}

/** Native reader motion is the only scroll authority until it becomes idle.
 *
 *  Ownership means READER ownership, never "the core happens to be moving".
 *  The core sets isScrolling for its OWN corrective writes too, and those can
 *  carry a backward direction with nobody touching the transcript, so deferring
 *  on that flag withheld compensation from an idle reader: rows above the
 *  viewport grew uncompensated, their deltas queued, and the flush then landed
 *  the whole batch in one step — the desktop transcript bounced while no one
 *  was scrolling (user: 가만히 있는데 위아래로 투둑 튄다).
 *
 *  An Android fling that outlives the gesture window is held by the touch latch
 *  in use-transcript-follow (touchScrollLatchOpen). That IS reader ownership and
 *  already arrives through this argument, so no core-direction probe is needed
 *  for the "items jump while scrolling up" shake it was added for. */
export function shouldDeferTranscriptScrollAdjustment(hasReaderGesture: boolean): boolean {
  return hasReaderGesture;
}

/**
 * The virtualized transcript timeline.
 *
 * ONE instance per session (the caller keys it): entry geometry, measurement
 * cache, and scroll offset are all resolved at construction, so a session
 * paints at its final position on the first frame. Settled, live, pending, and
 * thinking rows share this list; bottom anchoring and reflow compensation are
 * owned by virtual-core.
 */
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
  onSelectionAutoScroll,
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
  /** Claims reader ownership before this list writes selection auto-scroll. */
  onSelectionAutoScroll(delta: number): void;
}) {
  const spacer = useRef<HTMLDivElement>(null);
  // The viewport's scrollTop as last observed in a scroll event or written by
  // this list: every other consumer reads this instead of the DOM.
  const domTop = useRef<number | null>(null);
  // Reader-offset bookkeeping for each observed scroll event (set below, once
  // the reading-anchor state it consults exists).
  const noteScrollOffset = useRef<(top: number) => void>(() => {});
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
  // under the reader or competes with native touch motion. Applying them after
  // the gesture lands the size and its scroll compensation in one pre-paint
  // transaction instead.
  const pendingResizes = useRef(new Map<unknown, { index: number; size: number }>());
  const resizeFlushFrame = useRef(0);
  const baseResizeItem = useRef<((index: number, size: number) => void) | null>(null);
  // Rows that changed size by more than a viewport stay in the range for two
  // frames: a rewrap must never unmount the rows the reader is looking at.
  const resizePinned = useRef<number[]>([]);
  const resizePinFrame = useRef(0);
  // Native text selection keeps DOM boundary points. If virtualization
  // unmounts either endpoint while a drag auto-scrolls, Chromium reconnects
  // the range to an unrelated surviving node and the highlight appears to
  // flip back up the transcript. Keep the selected row span mounted until the
  // browser selection collapses.
  const selectionPinned = useRef<TranscriptSelectionPin | null>(null);
  const [, invalidateSelectionPin] = useState(0);
  const setSelectionPin = useCallback((next: TranscriptSelectionPin | null) => {
    const current = selectionPinned.current;
    if (
      current === next ||
      (current &&
        next &&
        Object.is(current.anchor.key, next.anchor.key) &&
        Object.is(current.focus.key, next.focus.key))
    )
      return;
    selectionPinned.current = next;
    invalidateSelectionPin((version) => version + 1);
  }, []);
  const selectionPinnedIndexes = () => {
    const pin = selectionPinned.current;
    if (!pin) return [];
    const resolve = (endpoint: TranscriptSelectionEndpoint) => {
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
    if ('active' in row && row.active) activeIndex = index;
  });
  activeIndexesRef.current = activeIndex < 0 ? [] : [activeIndex];
  // Mount-time only: this component is remounted per session. The real
  // measurements are replayed immediately and corrected by virtual-core if
  // the current width wraps them differently.
  const restored = useMemo(() => readTranscriptVirtualSnapshot(sessionKey), [sessionKey]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => TRANSCRIPT_ROW_ESTIMATE,
    getItemKey: (index) => rowsRef.current[index]?.key ?? `row:${index}`,
    measureElement: measureTranscriptRow,
    overscan: TRANSCRIPT_VIRTUAL_OVERSCAN,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor({ ...range, overscan: TRANSCRIPT_VIRTUAL_OVERSCAN });
      return [
        ...new Set([...resizePinned.current, ...selectionPinnedIndexes(), ...indexes, ...activeIndexesRef.current]),
      ]
        .filter((index) => index >= 0 && index < rows.length)
        .sort((a, b) => a - b);
    },
    initialOffset: () => (shouldAnchorBottom ? Number.MAX_SAFE_INTEGER : 0),
    initialMeasurementsCache: restored?.measurements,
    // Reader intent wins immediately. Keeping end anchoring active inside the
    // 80px return band let a small upward wheel move get reversed by the next
    // append or row measurement even after the follow hook had detached.
    anchorTo: shouldAnchorBottom ? 'end' : 'start',
    followOnAppend: shouldAnchorBottom,
    // While the tail is owned, every append and measured-size delta is an
    // end pin. An 80px band lost tall rows in a short split and invited a
    // second scrollToEnd writer. Reader release flips followOnAppend off.
    scrollEndThreshold: SCROLL_END_THRESHOLD_PX,
    paddingEnd: TRANSCRIPT_BOTTOM_SPACER,
    // The virtual core commits its state to the DOM in the same task as every
    // notify. React's default async rerender let the core
    // move scrollTop pre-paint while rows still painted at their previous
    // translateY — the width-drag shake/ghosting. Direct DOM updates restore
    // that commit timing: row transforms and the container height are
    // written inside the core transaction, and React reconciles on range
    // changes only. Every React commit (including a web snapshot that mounts
    // new rows) re-applies positions in a layout effect, so no row paints
    // unpositioned. The web browser renderer uses this path too: React-owned
    // positions there moved scrollTop synchronously while rows kept their
    // stale top until the async rerender, so every row measurement painted
    // one shifted frame (user: 웹앱에서 트랜스크립트가 튄다).
    directDomUpdates: true,
    // Keep every row in the transcript's ONE paint layer. Transform mode
    // promotes each row independently; when a deferred measurement and the
    // final native wheel frame land together at the bottom, Chromium can
    // present those compositor layers from different scroll phases and draw
    // the visible horizontal tear. Top-position writes still land in the same
    // direct pre-paint transaction, without per-row compositor surfaces.
    directDomUpdatesMode: 'position',
    // virtual-core's own offset observer reports, once scrolling idles, the
    // offset its LAST scroll event read (a debounced callback over a captured
    // value). A write this list made in between — a landing's anchor restore,
    // an end pin — was overwritten by that stale offset, and every later
    // correction started from it: a page landing within ~150 ms of the last
    // wheel event jumped the reader by the page a frame later, and a phone
    // reader at scrollTop 0 was put back at 0 plus the page. The idle report
    // carries the offset as last observed OR written.
    observeElementOffset: (instance, cb) => {
      const element = instance.scrollElement;
      if (!element) return undefined;
      let idle = 0;
      const onScroll = () => {
        // The one offset read per scroll event.
        const top = element.scrollTop;
        noteScrollOffset.current(top);
        cb(top, true);
        window.clearTimeout(idle);
        idle = window.setTimeout(() => cb(domTop.current ?? top, false), instance.options.isScrollingResetDelay);
      };
      element.addEventListener('scroll', onScroll, { passive: true });
      return () => {
        element.removeEventListener('scroll', onScroll);
        window.clearTimeout(idle);
      };
    },
    // Grow the spacer before a programmatic write so Chrome cannot clamp the
    // requested offset against the previous total height.
    scrollToFn: (offset, options, instance) => {
      if (instance.options.anchorTo === 'end' || instance.options.followOnAppend) {
        // Core measurements can request several opposing offsets while the
        // prompt/Goal/diff commit is still changing geometry. They share the
        // final native pin, never an intermediate elementScroll followed by
        // another corrective write.
        endPin.request();
        return;
      }
      if (spacer.current) spacer.current.style.height = `${instance.getTotalSize()}px`;
      // Reading scrollTop right after the spacer write — and again after the
      // core write — forces a synchronous layout of the whole virtual list on
      // every programmatic scroll. Resolve those reads only when diagnostics
      // are on, so the probe keeps its "free while off" contract.
      const diagnose = transcriptScrollDiagnosticsEnabled();
      const beforeCoreWrite = diagnose ? (viewport.current?.scrollTop ?? 0) : 0;
      elementScroll(offset, options, instance);
      if (diagnose) {
        logTranscriptScroll('core-scroll', {
          offset,
          adjust: options?.adjustments ?? 0,
          from: beforeCoreWrite,
          to: viewport.current?.scrollTop ?? 0,
        });
      }
      // Report the offset that actually landed (and the requested one, which a
      // smooth write only reaches later) so the follow hook can tell this
      // write apart from a reader scroll.
      const element = viewport.current;
      const intended = offset + (options?.adjustments ?? 0);
      // The write above already laid out; this read is free.
      const landed = element ? element.scrollTop : intended;
      domTop.current = landed;
      markProgrammaticScrollRef.current?.(landed, intended);
    },
  });
  const indexForPendingKey = useCallback((key: unknown, hint: number) => {
    if (rowsRef.current[hint]?.key === key) return hint;
    return rowsRef.current.findIndex((row) => row.key === key);
  }, []);
  // A deferred size changed while its row was out of view: applied, it grows
  // upward from the viewport top (see shouldAdjustScrollPositionOnItemSizeChange).
  const applyingDeferred = useRef(false);
  const applyDeferred = useCallback((index: number, size: number) => {
    applyingDeferred.current = true;
    try {
      baseResizeItem.current?.(index, size);
    } finally {
      applyingDeferred.current = false;
    }
  }, []);
  const flushDeferredResizes = useCallback(
    (only?: (index: number) => boolean) => {
      const pending = pendingResizes.current;
      if (!baseResizeItem.current || pending.size === 0) return;
      pending.forEach((entry, key) => {
        const at = indexForPendingKey(key, entry.index);
        if (at >= 0 && only && !only(at)) return;
        pending.delete(key);
        if (at >= 0) applyDeferred(at, entry.size);
      });
    },
    [applyDeferred, indexForPendingKey]
  );
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
    const offset = visibleTop(instance);
    pending.forEach((entry, key) => {
      const at = indexForPendingKey(key, entry.index);
      if (at < 0) {
        pending.delete(key);
        return;
      }
      const measured = instance.measurementsCache[at];
      // Scrolled back into, or its new box reaches into view.
      if (measured && (measured.end > offset || measured.start + entry.size > offset)) {
        pending.delete(key);
        applyDeferred(at, entry.size);
      }
    });
    if (pending.size > 0) {
      resizeFlushFrame.current = window.requestAnimationFrame(pumpDeferredResizes);
    }
  }, [applyDeferred, flushDeferredResizes, indexForPendingKey]);
  const scheduleResizeFlush = useCallback(() => {
    if (resizeFlushFrame.current) return;
    resizeFlushFrame.current = window.requestAnimationFrame(pumpDeferredResizes);
  }, [pumpDeferredResizes]);
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;
  // Where the timeline starts inside the scroll content (the thread's top
  // padding). Static CSS, read once on the first frame the pane has a box.
  const scrollInset = useRef(0);
  // The virtual offset at the viewport's VISIBLE top: rows start `inset`
  // below the scroll origin, so a row whose end lies within that strip is
  // still on screen — never "above the reader" (deferred, left uncompensated
  // as if unseen, or skipped as the reading anchor).
  const visibleTop = (instance: TranscriptVirtualizer) => logicalScrollOffset(instance) - scrollInset.current;
  // The committed extent: the spacer height virtual-core last wrote (a style
  // read). It is what the DOM scrolls over, also mid-render, when the core's
  // measurement cache may already describe the next row set.
  const contentHeight = useCallback(
    () =>
      scrollInset.current +
      (Number.parseFloat(spacer.current?.style.height ?? '') || virtualizerRef.current.getTotalSize()),
    []
  );
  const maxScrollTop = useCallback(
    () => Math.max(0, contentHeight() - viewportSize(virtualizerRef.current)),
    [contentHeight]
  );
  const endPin = useMemo(
    () =>
      createTranscriptEndPin({
        getVirtualizer: () => virtualizerRef.current,
        getViewport: () => viewport.current,
        getSpacer: () => spacer.current,
        getMaxScrollTop: maxScrollTop,
        getScrollTop: () => domTop.current,
        hasReaderGesture: () => hasScrollGestureRef.current(),
        markProgrammaticScroll: (top, intended) => {
          domTop.current = top;
          markProgrammaticScrollRef.current?.(top, intended);
        },
      }),
    [maxScrollTop, viewport]
  );
  useLayoutEffect(() => () => endPin.cancel(), [endPin]);
  // One pre-paint write of a corrected reading offset. The spacer grows FIRST:
  // virtualizer.scrollToOffset clamped the target against the previous
  // scrollHeight, and older pages then dropped the reader a whole page.
  const writeReadingOffset = useCallback(
    (instance: TranscriptVirtualizer, target: number) => {
      const element = viewport.current;
      if (!element) return;
      if (spacer.current) spacer.current.style.height = `${instance.getTotalSize()}px`;
      const top = Math.max(0, Math.min(target, maxScrollTop()));
      const core = coreScrollState(instance);
      core.scrollAdjustments = 0;
      core.scrollOffset = top;
      core._intendedScrollOffset = top;
      element.scrollTop = top;
      domTop.current = top;
      markProgrammaticScrollRef.current?.(top, target);
      // The range on screen was resolved at the previous offset. Never a sync
      // notify: flushSync cannot run inside a layout effect.
      core.notify(false);
    },
    [maxScrollTop, viewport]
  );
  // Older history paged in above a reader who scrolled up must not move what
  // they read. Compensating size deltas failed whenever a row above changed
  // identity: a page that supplies a reply folds its "Worked for…" row into
  // it, a cut tool group or mid-turn window re-keys its head. The reading
  // ANCHOR is instead the first row under the viewport's top edge that the
  // new row set still carries (else the next one that does) and its offset in
  // the viewport. It is taken before the new geometry resolves, restored in
  // the commit, and held while the landed rows above it are measured, until
  // the reader scrolls.
  const laidOutRows = useRef(rows);
  const pendingAnchor = useRef<{ base: readonly TranscriptRowModel[]; anchor: ReadingAnchor | null } | null>(null);
  // `start`: where the anchor sat when last applied. `landedAt` bounds how
  // long late sizes may extend the hold.
  const anchorHold = useRef<(ReadingAnchor & { until: number; start: number | null; landedAt: number }) | null>(
    null
  );
  const anchorRestoreQueued = useRef(false);
  // The hold is NOT a reader-gesture decision. A page lands when the reader
  // reaches the top — inside the wheel/touch window by construction — and the
  // landed rows (lazy Markdown above all) keep growing for frames after it.
  // Releasing on the gesture left the row just above the anchor, which still
  // intersects the viewport top and so is never deferred, free to push the
  // reader down by its full growth (+2.7k px on desktop, the phone reader
  // at scrollTop 0 lost to a screen of older rows).
  const readingAnchorHeld = useCallback(() => {
    const hold = anchorHold.current;
    if (!hold) return false;
    if (performance.now() > hold.until || virtualizerRef.current.options.anchorTo === 'end') {
      anchorHold.current = null;
      return false;
    }
    return true;
  }, []);
  // `landing` (the commit that changed the rows): restore the anchor's
  // recorded viewport offset, whatever the reader is doing — skipping it drops
  // the reader by the whole page. Afterwards only the anchor's own movement is
  // applied, RELATIVE to the live offset, so reader motion between two writes
  // (a wheel ramp, a fling) is never rolled back.
  const restoreReadingAnchor = useCallback(
    (landing = false) => {
      const hold = anchorHold.current;
      const instance = virtualizerRef.current;
      if (!hold || (landing ? instance.options.anchorTo === 'end' : !readingAnchorHeld())) return;
      const at = indexForPendingKey(hold.key, hold.index);
      if (at < 0) {
        anchorHold.current = null;
        return;
      }
      hold.index = at;
      // Sizes deferred for rows above the anchor belong to this write.
      flushDeferredResizes((index) => index < at);
      instance.getTotalSize();
      const start = instance.measurementsCache[at]?.start ?? 0;
      const reading = logicalScrollOffset(instance);
      let target = reading;
      if (landing || hold.start === null) target = start - hold.offset;
      else if (Math.abs(start - hold.start) >= 0.5) {
        target = reading + (start - hold.start);
        // Sizes still arriving: stay held a little longer, within a bound.
        hold.until = Math.min(hold.landedAt + READING_ANCHOR_HOLD_MAX_MS, performance.now() + READING_ANCHOR_HOLD_MS);
      }
      hold.start = start;
      if (Math.abs(target - reading) < 0.5) return;
      if (transcriptScrollDiagnosticsEnabled()) {
        logTranscriptScroll('reading-anchor', { from: reading, to: target, index: at, start, landing });
      }
      writeReadingOffset(instance, target);
    },
    [flushDeferredResizes, indexForPendingKey, readingAnchorHeld, writeReadingOffset]
  );
  noteScrollOffset.current = (top: number) => {
    // The held anchor is applied relative to the reader's offset, so reader
    // motion never fights it; it only ends once the reader has left it a
    // viewport behind, where it no longer describes what they read.
    const hold = anchorHold.current;
    if (hold && hold.start !== null && domTop.current !== null && Math.abs(top - domTop.current) >= 1) {
      const offset = hold.start - top;
      const height = viewportSize(virtualizerRef.current);
      if (offset < -height || offset > 2 * height) anchorHold.current = null;
    }
    domTop.current = top;
  };
  const queueAnchorRestore = useCallback(() => {
    if (anchorRestoreQueued.current) return;
    anchorRestoreQueued.current = true;
    queueMicrotask(() => {
      anchorRestoreQueued.current = false;
      restoreReadingAnchor();
    });
  }, [restoreReadingAnchor]);
  if (rows === laidOutRows.current || virtualizer.options.anchorTo === 'end') {
    pendingAnchor.current = null;
  } else if (pendingAnchor.current?.base !== laidOutRows.current) {
    // Before this render resolves the new geometry: the cache still
    // describes the rows on screen.
    pendingAnchor.current = {
      base: laidOutRows.current,
      anchor: captureReadingAnchor(virtualizer, laidOutRows.current, rows, scrollInset.current),
    };
  }
  // A landing's rows are measured in its own commits, before paint: left to
  // their ResizeObserver, the older rows painted at the flat estimate over
  // the viewport for a frame or more, and a first measurement that arrived
  // during reader motion was deferred with the rows still overlapping.
  const landingMeasure = useRef(false);
  const measureLandedRows = useCallback(() => {
    const root = spacer.current;
    const apply = baseResizeItem.current;
    if (!root || !apply) return false;
    const instance = virtualizerRef.current;
    const mounted = [...root.children].filter(
      (row): row is HTMLElement => row instanceof HTMLElement && row.dataset.timelineKey !== undefined
    );
    // One batched read: the first lays out what this commit needs anyway,
    // every later one is free. New rows and rows whose content the page
    // changed (a group that gained its head, a reply that took its
    // completion) both land here; the observer's later delivery of the same
    // box is then a no-op, so each size still lands exactly once.
    const sizes = mounted.map((row) => Math.round(row.getBoundingClientRect().height));
    let measured = false;
    mounted.forEach((row, position) => {
      const size = sizes[position] ?? 0;
      const key = row.dataset.timelineKey as string;
      const at = indexForPendingKey(key, Number(row.dataset.index));
      if (size <= 0 || at < 0 || instance.itemSizeCache.get(key) === size) return;
      pendingResizes.current.delete(key);
      apply(at, size);
      measured = true;
    });
    return measured;
  }, [indexForPendingKey]);
  useLayoutEffect(() => {
    laidOutRows.current = rows;
    const pending = pendingAnchor.current;
    pendingAnchor.current = null;
    if (!pending?.anchor || virtualizerRef.current.options.anchorTo === 'end') return;
    const landedAt = performance.now();
    anchorHold.current = { ...pending.anchor, until: landedAt + READING_ANCHOR_HOLD_MS, start: null, landedAt };
    // Only a row set that moved the anchor (rows landed or left above it) is
    // a landing; a streamed append below the reader reads no layout. The
    // restore re-renders the range at the reading offset in this same task;
    // the effect below measures the rows that commit mounts.
    if (indexForPendingKey(pending.anchor.key, pending.anchor.index) !== pending.anchor.index) {
      landingMeasure.current = true;
      window.requestAnimationFrame(() => {
        landingMeasure.current = false;
      });
      measureLandedRows();
    }
    restoreReadingAnchor(true);
  }, [rows]);
  useLayoutEffect(() => {
    if (landingMeasure.current && measureLandedRows()) restoreReadingAnchor();
  });
  // React re-renders reuse one virtualizer instance. Patch resizeItem exactly
  // once instead of wrapping the previous wrapper again on every render.
  const patchedVirtualizer = useRef<Virtualizer<HTMLDivElement, HTMLDivElement> | null>(null);
  if (patchedVirtualizer.current !== virtualizer) {
    patchedVirtualizer.current = virtualizer;
    const resizeItem = virtualizer.resizeItem;
    baseResizeItem.current = resizeItem;
    virtualizer.scrollToEnd = () => {
      endPin.request();
    };
    // The core reads scrollHeight/clientHeight here, and setOptions asks it
    // (isAtEnd) during every render that changes the row count: a forced
    // layout inside render while the transcript grows. The committed spacer
    // height and the observed viewport height give the same answer.
    (virtualizer as unknown as { getMaxScrollOffset(): number }).getMaxScrollOffset = maxScrollTop;
    virtualizer.resizeItem = (index, size) => {
      const element = viewport.current;
      const measured = virtualizer.measurementsCache[index];
      // Reader gesture + row fully above the reading offset: DEFER. Never
      // drop — a dropped delta leaves the reader displaced by exactly that
      // delta once the geometry it saw is recomputed.
      // Rows above a held reading anchor are never deferred: the anchor's
      // relative re-apply compensates them in the same pre-paint write, and a
      // deferred one would draw over the reader until motion stops.
      const anchoredAbove = readingAnchorHeld() && index < (anchorHold.current?.index ?? -1);
      if (
        measured &&
        !anchoredAbove &&
        shouldDeferTranscriptScrollAdjustment(hasScrollGestureRef.current()) &&
        // Its NEW box must stay above the visible top too: a deferred row
        // that already reaches into view is drawn over the reader's rows at
        // its stale slot, and a landing then anchors on stale geometry.
        measured.start + size <= visibleTop(virtualizer)
      ) {
        pendingResizes.current.set(measured.key, { index, size });
        scheduleResizeFlush();
        return;
      }
      pendingResizes.current.delete(measured?.key ?? index);
      const previous = measured ? (virtualizer.itemSizeCache.get(measured.key) ?? measured.size) : undefined;
      if (transcriptScrollDiagnosticsEnabled() && previous !== undefined && Math.abs(size - previous) >= 4) {
        logTranscriptScroll('row-resize', {
          index,
          prev: previous,
          next: size,
          delta: size - previous,
          above: measured ? measured.end <= visibleTop(virtualizer) : false,
          top: element ? element.scrollTop : -1,
        });
      }
      if (element && previous !== undefined && Math.abs(size - previous) > viewportSize(virtualizer)) {
        const view = element.getBoundingClientRect();
        resizePinned.current = [...element.querySelectorAll<HTMLElement>('.transcript-virtual-row')]
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
      if (virtualizer.options.followOnAppend || virtualizer.options.anchorTo === 'end') {
        endPin.request();
      } else if (anchoredAbove) {
        // Late sizes of landed rows: one coalesced re-apply per delivery.
        queueAnchorRestore();
      }
    };
  }
  // Rows measured above the reading offset keep the reader's content still.
  // During wheel/touch/scrollbar motion a row that stays wholly above the
  // viewport is deferred instead (resizeItem above): its correction would add
  // to Chromium's wheel ramp and briefly reverse the visible direction near
  // the history boundary. Only a row whose new box reaches into view is
  // corrected mid-motion. The follow hook tracks only non-programmatic reader
  // motion, so virtual-core's own corrective scroll does not block the next
  // idle measurement in a settling burst.
  // The end-anchor (wasAtEnd) total-size delta bypasses this predicate by
  // design. The vendored core also consulted a shouldDeferScrollAdjustment
  // hook to hold THAT write until motion was idle; upstream virtual-core has
  // no such hook and never reads it, so only the core's own isScrolling
  // deferral guards the bottom pin now. Watch for the "tears and snaps back at
  // the bottom" symptom if the end anchor starts fighting a live wheel ramp.
  // A row set in flight or a held reading anchor resolves every size above
  // the reader in one absolute write instead (see restoreReadingAnchor).
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    if (instance.options.anchorTo !== 'end') {
      if (pendingAnchor.current) return false;
      if (readingAnchorHeld() && item.index < (anchorHold.current?.index ?? -1)) return false;
    }
    // A row wholly above the visible top keeps the reader's content still.
    // During reader motion such a row only gets here once its new box
    // reaches into view (smaller changes are deferred above); left
    // uncompensated it was drawn over the rows the reader is looking at.
    const top = visibleTop(instance);
    if (item.end <= top) return true;
    // A row crossing the visible top grows upward instead when the size is
    // its FIRST measurement (mounted at the estimate while scrolling toward
    // older rows) or was deferred while it was out of view: uncompensated,
    // the rows in view jumped by the difference (18/40 px and more) against
    // the finger.
    return item.start < top && (applyingDeferred.current || !instance.itemSizeCache.has(item.key));
  };
  const measureRow = useCallback((element: HTMLDivElement | null) => {
    // Registration only: the row's ResizeObserver delivers its box after this
    // frame's layout and before its paint, so no layout is read here.
    if (element?.isConnected) virtualizerRef.current.measureElement(element);
  }, []);
  const bindSpacer = useCallback(
    (element: HTMLDivElement | null) => {
      spacer.current = element;
      content.current = element;
      // Direct DOM updates keep the spacer height current between React commits.
      virtualizerRef.current.containerRef(element);
    },
    [content]
  );

  // The follow hook, reveal and history fill read this viewport's extent and
  // offset from here, never from layout on a scroll event or frame. The
  // viewport's ref attaches AFTER this list's layout effects when both mount
  // in one commit, so registration is retried on every commit (layout, then
  // passive — before the parent's passive effects read it) until it holds.
  const geometry = useRef<{ root: HTMLDivElement; release(): void } | null>(null);
  const ensureScrollGeometry = () => {
    const root = viewport.current;
    const space = spacer.current;
    if (!root || !space || geometry.current?.root === root) return;
    geometry.current?.release();
    const instance = virtualizerRef.current;
    // Wire the core to the viewport now instead of on the next render, so
    // its observed viewport height backs the geometry from the start.
    if (instance.scrollElement !== root) instance._willUpdate();
    // The timeline starts below the thread's top padding (its only in-flow
    // content above the spacer). A style read, not a layout read.
    const thread = space.parentElement;
    scrollInset.current = thread ? Number.parseFloat(window.getComputedStyle(thread).paddingTop) || 0 : 0;
    // Unknown until the first scroll event or write; the core's offset stands in.
    domTop.current = null;
    const unregister = registerTranscriptScrollGeometry(root, {
      viewportHeight: () => viewportSize(virtualizerRef.current),
      contentHeight,
      scrollTop: () => domTop.current ?? logicalScrollOffset(virtualizerRef.current),
    });
    geometry.current = { root, release: unregister };
  };
  useLayoutEffect(ensureScrollGeometry);
  useEffect(ensureScrollGeometry);
  useLayoutEffect(
    () => () => {
      geometry.current?.release();
      geometry.current = null;
    },
    []
  );

  useLayoutEffect(
    () => () => {
      // Pending gesture-deferred sizes are part of the truth this snapshot
      // promises to replay on re-entry.
      flushDeferredResizes();
      rememberTranscriptVirtualMeasurements(sessionKey, virtualizerRef.current.takeSnapshot());
    },
    [flushDeferredResizes, sessionKey, viewport]
  );

  useLayoutEffect(() => {
    const scrollToEnd = () => {
      endPin.request();
    };
    scrollToEndRef.current = scrollToEnd;
    return () => {
      if (scrollToEndRef.current === scrollToEnd) {
        scrollToEndRef.current = () => {};
      }
    };
  }, [endPin, scrollToEndRef]);

  useLayoutEffect(() => {
    if (!setAnchorBottomRef) return undefined;
    const setAnchorBottom = (bottom: boolean) => {
      anchorOverride.current = bottom;
      const instance = virtualizerRef.current;
      const anchorTo = bottom ? 'end' : 'start';
      if (
        instance.options.anchorTo === anchorTo &&
        instance.options.followOnAppend === bottom &&
        instance.options.scrollEndThreshold === SCROLL_END_THRESHOLD_PX
      )
        return;
      instance.setOptions({
        ...instance.options,
        anchorTo,
        followOnAppend: bottom,
        scrollEndThreshold: SCROLL_END_THRESHOLD_PX,
      });
    };
    setAnchorBottomRef.current = setAnchorBottom;
    return () => {
      if (setAnchorBottomRef.current === setAnchorBottom) {
        setAnchorBottomRef.current = () => {};
      }
    };
  }, [setAnchorBottomRef]);

  // Chromium owns the drag range; transcript-selection-drag.ts only pins the
  // rows it spans and reports native autoscroll to the follow hook.
  useEffect(() => {
    const root = viewport.current;
    if (!root) return undefined;
    return attachTranscriptSelectionDrag({
      root,
      rowKeyAt: (index) => rowsRef.current[index]?.key,
      setPin: setSelectionPin,
      onAutoScroll: onSelectionAutoScroll,
    });
  }, [onSelectionAutoScroll, sessionKey, setSelectionPin, viewport]);

  useEffect(
    () => () => {
      if (resizePinFrame.current) window.cancelAnimationFrame(resizePinFrame.current);
      if (resizeFlushFrame.current) window.cancelAnimationFrame(resizeFlushFrame.current);
    },
    []
  );

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
        const turnEnd = !next || next._tag === 'TurnGap';
        return (
          // A row binds position AND measurement to one element.
          // Position and measurement therefore share the
          // OUTER box here, so applyDirectStyles (elementsCache) moves exactly
          // the element the ResizeObserver measures — in the same pre-paint
          // transaction. The row keeps its natural content height; geometry
          // corrections land before paint, so nothing is clipped a frame late.
          <div
            className="transcript-virtual-row"
            key={virtualRow.key}
            data-index={virtualRow.index}
            data-timeline-key={String(virtualRow.key)}
            ref={measureRow}
          >
            <div
              className="transcript-virtual-row-content"
              data-slot="session-turn-message-container"
              data-index={virtualRow.index}
              data-tag={row._tag}
              data-turn-end={turnEnd ? 'true' : undefined}
            >
              {renderRow(row)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
