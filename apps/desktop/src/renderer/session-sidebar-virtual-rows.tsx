import {
  defaultRangeExtractor,
  observeElementOffset,
  observeElementRect,
  type Range,
  useVirtualizer,
} from '@tanstack/react-virtual';
import type React from 'react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

/** Lists up to this many rows render whole; a longer one mounts only the rows
 *  near the scroller viewport. */
export const VIRTUAL_ROWS_MIN = 40;
/** Rows kept mounted past each viewport edge: a fling and a Tab press past the
 *  edge land on rows that already exist. */
const VIRTUAL_ROWS_OVERSCAN = 12;
/** The window moves in steps of this many rows. Every step mounts and
 *  releases rows (each row measures its title), so a step per row scrolled
 *  cost a commit and a layout every few frames; the overscan covers the
 *  rows a step lags behind. */
const VIRTUAL_ROWS_STEP = 8;

/** Last measured row box, shared by every list: all session rows have one
 *  fixed CSS height (31px desktop, the touch row on a phone). */
const learnedRow = { height: 31, gap: 1 };

/** The row slot (row plus the list's gap) every session list lays out. */
export function sessionRowPitch(): number {
  return learnedRow.height + learnedRow.gap;
}

/** The rows after a paged list's revealed ones. Its paging sentinel stands in
 *  for them at their height, so the scroll extent always reaches the end of
 *  the whole list: a fling runs on over rows whose page has not committed
 *  yet instead of dying at the end of the revealed ones. */
export interface UnrevealedRows {
  count: number;
  sentinelRef: React.Ref<HTMLDivElement>;
}

export interface VirtualRowItem {
  /** React key of the row this item renders. */
  key: string;
  sessionId: string;
}

interface RowGeometry {
  /** Top of the list's first row within the scroller's content. */
  origin: number;
  height: number;
  gap: number;
}

/** The viewport height a list windows against when its scroller has no box
 *  (a closed phone drawer, a hidden panel): the window's, never zero rows. */
function fallbackViewportHeight() {
  return window.innerHeight;
}

/** A row's own Tab stops in document order: its controls that take focus now
 *  (the rename input only while editing; the hover action cluster only while
 *  the row shows it). */
function rowTabStops(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>('button, input, [tabindex]')].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(':disabled') &&
      !element.closest('[inert]') &&
      window.getComputedStyle(element).visibility !== 'hidden'
  );
}

/** A Tab press that leaves a row toward a neighbour the window has not
 *  mounted: that row mounts, then takes focus on its first stop (Tab) or its
 *  last (Shift+Tab). */
interface FocusRequest {
  index: number;
  last: boolean;
}

/** One session list inside the shared Sessions scroller. Rows stay in normal
 *  flow inside their section; the rows outside the window are replaced by
 *  spacers of the same height, so the scroll extent, the scroll anchor and the
 *  paging sentinel see the full revealed list. Rows that must survive a scroll
 *  (the selected one, a delete awaiting confirmation, the focused row, the
 *  native drag source whose unmount would end the drag) stay mounted. */
export function VirtualSessionRows<T extends VirtualRowItem>({
  items,
  renderItem,
  scrollerRef,
  pinnedIds,
  unrevealed,
}: {
  items: readonly T[];
  renderItem(item: T): React.ReactNode;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  pinnedIds: ReadonlySet<string>;
  unrevealed?: UnrevealedRows;
}) {
  const windowed = items.length > VIRTUAL_ROWS_MIN;
  const markerRef = useRef<HTMLSpanElement | null>(null);
  const [geometry, setGeometry] = useState<RowGeometry>(() => ({ origin: 0, ...learnedRow }));
  const pitch = geometry.height + geometry.gap;
  const indexById = useMemo(() => new Map(items.map((item, index) => [item.sessionId, index])), [items]);
  // The row that last held focus in this list stays mounted until another
  // row takes focus: focus leaving for a menu or dialog comes back to it.
  const [focusedId, setFocusedId] = useState('');
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = new Set(defaultRangeExtractor(range));
      const pin = (sessionId: string | undefined) => {
        const index = sessionId === undefined ? undefined : indexById.get(sessionId);
        if (index !== undefined) indexes.add(index);
      };
      for (const sessionId of pinnedIds) pin(sessionId);
      pin(focusedId);
      if (focusRequest && focusRequest.index < items.length) indexes.add(focusRequest.index);
      // The native drag source: its unmount would end the pane drag.
      const container = markerRef.current?.parentElement;
      if (container) {
        for (const row of container.querySelectorAll<HTMLElement>(':scope > .session-row[data-dragging="true"]'))
          pin(row.dataset.sessionId);
      }
      return [...indexes].sort((left, right) => left - right);
    },
    [focusRequest, focusedId, indexById, items.length, pinnedIds]
  );
  const getItemKey = useCallback((index: number) => items[index]?.key ?? `row:${index}`, [items]);
  // Read once: the virtualizer takes it only when it is created, and reading
  // window.innerHeight in every render laid the page out mid-render.
  const [initialRect] = useState(() => ({ width: 0, height: fallbackViewportHeight() }));
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
    count: items.length,
    enabled: windowed,
    getScrollElement: () => scrollerRef.current,
    // Every row is the same fixed box; the list's gap rides in each row's slot.
    estimateSize: () => pitch,
    getItemKey,
    scrollMargin: geometry.origin,
    overscan: VIRTUAL_ROWS_OVERSCAN,
    rangeExtractor,
    // A range change re-renders this list after the scroll event, never
    // synchronously inside it; the overscan keeps rows ready meanwhile.
    useFlushSync: false,
    initialRect,
    observeElementOffset: (instance, notify) =>
      observeElementOffset(instance, (offset, scrolling) => {
        const step = VIRTUAL_ROWS_STEP * pitch;
        notify(Math.floor(offset / step) * step, scrolling);
      }),
    observeElementRect: (instance, notify) =>
      observeElementRect(instance, (rect) =>
        notify(
          rect.height > 0
            ? rect
            : { width: rect.width, height: instance.scrollRect?.height || fallbackViewportHeight() }
        )
      ),
  });
  // Sizes are estimates only; a learned pitch replaces every cached one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pitch is the estimate the measure() call re-reads
  useLayoutEffect(() => {
    if (windowed) virtualizer.measure();
  }, [pitch, virtualizer, windowed]);
  const rendered = windowed ? virtualizer.getVirtualItems().map((item) => item.index) : [];
  const renderedRef = useRef(rendered);
  renderedRef.current = rendered;
  // Learn the row box and the list's origin from the rows on screen. Sections
  // above this list change its origin only through a sidebar render, which
  // hands this list a new `items`; a scroll step alone re-renders with the
  // same items and skips the measurement (and its forced layout). A list
  // short of windowing measures too while rows stay unrevealed: their
  // reserved height is laid out from this box.
  const measured = windowed || Boolean(unrevealed?.count);
  // biome-ignore lint/correctness/useExhaustiveDependencies: items marks a sidebar render; geometry is read, not a trigger
  useLayoutEffect(() => {
    if (!measured) return;
    const scroller = scrollerRef.current;
    const container = markerRef.current?.parentElement;
    if (!scroller || !container) return;
    // A list inside a hidden view (a closed drawer, a rail page not shown) has
    // no box to learn from; reading one would only lay the page out inside
    // this commit (a closing drawer paid the whole Settings layout here). It
    // measures in the render that shows it.
    if (scroller.closest('[hidden]')) return;
    const rows = container.querySelectorAll<HTMLElement>(':scope > .session-row[data-session-id]');
    // Unwindowed, every item is mounted in order.
    const indexes = windowed ? renderedRef.current : rows.length > 1 ? [0, 1] : [0];
    const first = rows[0];
    if (!first || indexes.length === 0) return;
    const firstRect = first.getBoundingClientRect();
    // No box (hidden panel, test DOM): keep the last geometry.
    if (firstRect.height <= 0) return;
    const height = firstRect.height;
    const gap =
      rows[1] && indexes[1] === indexes[0] + 1
        ? Math.max(0, rows[1].getBoundingClientRect().top - firstRect.bottom)
        : geometry.gap;
    const origin =
      firstRect.top - scroller.getBoundingClientRect().top + scroller.scrollTop - indexes[0] * (height + gap);
    learnedRow.height = height;
    learnedRow.gap = gap;
    if (
      Math.abs(origin - geometry.origin) > 0.5 ||
      Math.abs(height - geometry.height) > 0.1 ||
      Math.abs(gap - geometry.gap) > 0.1
    )
      setGeometry({ origin, height, gap });
  }, [items, windowed, measured, scrollerRef]);
  const live = useRef({ items, indexById, windowed, origin: geometry.origin, pitch });
  live.current = { items, indexById, windowed, origin: geometry.origin, pitch };
  // Focus tracking and Tab across the window edge. The listeners sit on the
  // list's own container, ahead of the row handlers (the rename input stops
  // its key events from reaching the sidebar).
  useLayoutEffect(() => {
    const container = markerRef.current?.parentElement;
    if (!container) return undefined;
    const ownRow = (target: EventTarget | null) => {
      const row = (target as Element | null)?.closest?.<HTMLElement>('.session-row[data-session-id]');
      return row?.parentElement === container ? row : null;
    };
    const onFocusIn = (event: FocusEvent) => {
      const sessionId = ownRow(event.target)?.dataset.sessionId;
      if (sessionId) setFocusedId(sessionId);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const current = live.current;
      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey || !current.windowed) return;
      const row = ownRow(event.target);
      const index = row ? current.indexById.get(row.dataset.sessionId ?? '') : undefined;
      if (!row || index === undefined) return;
      const backward = event.shiftKey;
      // Focus still moving inside the row, or out of the list's ends, is native.
      if (rowTabStops(row).at(backward ? 0 : -1) !== event.target) return;
      const next = index + (backward ? -1 : 1);
      if (next < 0 || next >= current.items.length) return;
      // A mounted neighbour is already next in the document's Tab order.
      const neighbour = backward ? row.previousElementSibling : row.nextElementSibling;
      if (neighbour?.matches('.session-row[data-session-id]')) return;
      event.preventDefault();
      const scroller = scrollerRef.current;
      if (scroller) {
        const top = current.origin + next * current.pitch;
        if (backward && top < scroller.scrollTop) scroller.scrollTop = top;
        else if (!backward && top + current.pitch > scroller.scrollTop + scroller.clientHeight)
          scroller.scrollTop = top + current.pitch - scroller.clientHeight;
      }
      setFocusRequest({ index: next, last: backward });
    };
    container.addEventListener('focusin', onFocusIn);
    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('focusin', onFocusIn);
      container.removeEventListener('keydown', onKeyDown);
    };
  }, [scrollerRef]);
  // The requested row is in this commit (the request pins it): focus it.
  useLayoutEffect(() => {
    if (!focusRequest) return;
    const sessionId = items[focusRequest.index]?.sessionId;
    const row = [
      ...(markerRef.current?.parentElement?.querySelectorAll<HTMLElement>(':scope > .session-row[data-session-id]') ??
        []),
    ].find((candidate) => candidate.dataset.sessionId === sessionId);
    setFocusRequest(null);
    if (!row) return;
    const stops = rowTabStops(row);
    (focusRequest.last ? stops.at(-1) : stops[0])?.focus({ preventScroll: true });
  }, [focusRequest, items]);
  const marker = <span key="virtual-origin" ref={markerRef} hidden />;
  // A stand-in for `count` rows: their slots minus the one gap the stand-in
  // itself adds as a list item.
  const extent = (count: number) => Math.max(0, count * pitch - geometry.gap);
  const sentinel = unrevealed && (
    <div
      key="unrevealed-rows"
      ref={unrevealed.sentinelRef}
      className="session-list-sentinel"
      aria-hidden="true"
      style={{ height: Math.max(1, extent(unrevealed.count)), pointerEvents: 'none' }}
    />
  );
  if (!windowed) return [marker, ...items.map(renderItem), sentinel];
  const spacer = (key: string, count: number) => (
    <div key={key} className="session-list-spacer" aria-hidden="true" style={{ height: extent(count) }} />
  );
  const nodes: React.ReactNode[] = [marker];
  let next = 0;
  for (const index of rendered) {
    const item = items[index];
    if (!item) continue;
    if (index > next) nodes.push(spacer(`spacer:${next}`, index - next));
    nodes.push(renderItem(item));
    next = index + 1;
  }
  if (next < items.length) nodes.push(spacer('spacer:end', items.length - next));
  nodes.push(sentinel);
  return nodes;
}
