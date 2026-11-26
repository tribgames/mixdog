import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { transcriptDockInset } from './transcript-list-dock-inset';
import { ceilRowHeight, transcriptThreadInset } from './transcript-list-geometry';
import { TRANSCRIPT_BOTTOM_SPACER, TRANSCRIPT_RELEARN_ATTRIBUTE } from './transcript-virtual-cache';
import { transcriptScrollPosition } from './use-transcript-follow';

// The island slot easing its height: a transition, which ends by itself. A slot that keeps room for a segment still
// reading (`data-reserved`) is not waited for: the read is the core's to answer, and may never be.
const DOCK_MOTION = '.composer-island-slot[data-motion]';
const ROW_PENDING = '[data-transcript-pending]';
// A turn's changes read (TurnChangesCard.tsx), which the phone does not wait on: the row draws its card from the turn's
// own records in its first frame.
const BODY_PENDING = '[data-transcript-pending]:not([data-transcript-pending="read"])';
const ROW = '.transcript-virtual-row';
// A reply still streaming: its box and what it parses change for as long as it streams, and are never waited for.
const STREAMING = '.message.streaming';
// Well under a device pixel at any ratio (1/3 px at 3x).
const OFFSET_SLACK_PX = 0.01;

/** Whether dock chrome under `scope` is still to settle: a module loading (`entry`), or the island slot easing its
 *  height. A slot marked as moving whose height transition is not running (it started none: a slot not rendered, a
 *  height that does not change) has no end to come and is not waited for; where the engine cannot say, the mark is
 *  taken as it is. */
function chromeUnsettled(scope: Element | null | undefined, entry: boolean): boolean {
  if (!scope) return false;
  if (entry && scope.querySelector('[data-entry-pending]')) return true;
  for (const slot of scope.querySelectorAll<HTMLElement>(DOCK_MOTION)) {
    // An engine that runs transitions knows them (CSSTransition); a document with none cannot say.
    const engine = slot.ownerDocument.defaultView as (Window & { CSSTransition?: unknown }) | null;
    if (typeof slot.getAnimations !== 'function' || typeof engine?.CSSTransition !== 'function') return true;
    const moving = slot
      .getAnimations()
      .some((animation) => (animation as CSSTransition).transitionProperty === '--island-slot-height');
    if (moving) return true;
  }
  return false;
}

/** Whether a visible row (or a marker outside any row) under `root` that is not streaming still holds a pending body or card. */
function settlingPending(root: Element, visibleRows: ReadonlySet<HTMLElement>, selector = ROW_PENDING): boolean {
  for (const marker of root.querySelectorAll(selector)) {
    const row = marker.closest<HTMLElement>(ROW);
    if (row) {
      if (!visibleRows.has(row)) continue;
      if (row.querySelector(STREAMING)) continue;
    }
    return true;
  }
  return false;
}

const readerPlaced = () => true;
const notAsking = () => false;

/**
 * Data readiness is not layout readiness: a virtual range can still contain
 * estimates or a suspended Markdown body. Each visit (the timeline put up to
 * be presented: a first entry, or a return to a list kept mounted) is
 * revealed once its reader is where the visit puts it and the rows in view
 * hold their final boxes: in the visit's own commit when they read back at
 * exactly the extents the list gave them, else in the first frame they
 * agree across two samples. What is waited for is work that ends by itself
 * inside the renderer, from data it holds: a body parsed (or failed, which
 * shows its text), a module loaded, a motion ended, the fonts; and the one
 * read of the core whose answer sizes a mounted row, a turn's changes read
 * (TurnChangesCard.tsx), which an eager reveal does not wait on. No elapsed
 * time presents a view. No scroll is
 * written here.
 */
export function useTranscriptReveal({
  identity,
  visit = 0,
  enabled,
  draft,
  viewport,
  content,
  scope,
  hasScrollGesture,
  eager = false,
  pinned = false,
  placed = readerPlaced,
  growing = false,
  asking = notAsking,
}: {
  identity: string;
  /** Counts the times the timeline was put up to be presented: each is revealed anew. */
  visit?: number;
  /** The timeline follows its end: its end pin must have landed. */
  pinned?: boolean;
  /** A timeline off its end: its reader is on the row the visit puts it on. */
  placed?: () => boolean;
  /** A read of older rows is out: while the rows do not fill the viewport, its page would move every row in view. No
   *  frame is sampled while that holds; the read's answer, whatever it is, samples again. */
  growing?: boolean;
  /** A read of older rows may still be asked for the rows shown (read at each sample): held like `growing`, sampling
   *  on until it is decided. */
  asking?: () => boolean;
  enabled: boolean;
  draft: boolean;
  /** The phone: reveal in the first frame the rows in view hold their content (no pending body) at the extents
   *  the list gave them, without waiting on a changes read, dock chrome or a stable frame. */
  eager?: boolean;
  viewport: RefObject<HTMLDivElement | null>;
  content: RefObject<HTMLDivElement | null>;
  /** Conversation root: undecided chrome marks `data-entry-pending`; the
   *  island slot marks `data-motion` or `data-reserved`. */
  scope?: RefObject<HTMLElement | null>;
  hasScrollGesture(): boolean;
}): boolean {
  const visitKey = `${identity}\n${visit}`;
  const [revealedVisit, setRevealedVisit] = useState(draft ? visitKey : '');
  const [currentVisit, setCurrentVisit] = useState(visitKey);
  if (currentVisit !== visitKey) {
    setCurrentVisit(visitKey);
    setRevealedVisit('');
  }
  // The timelines this hook revealed: a later visit of one is a return to rows that held their boxes.
  const [revealedTimelines] = useState(() => new Set<string>());
  // Read at the commit's microtask and at each sample: where the reader must be.
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const placedRef = useRef(placed);
  placedRef.current = placed;
  const askingRef = useRef(asking);
  askingRef.current = asking;
  useLayoutEffect(() => {
    if (revealedVisit === visitKey) return undefined;
    if (draft) {
      setRevealedVisit(visitKey);
      return undefined;
    }
    if (!enabled) return undefined;
    const warm = revealedTimelines.has(identity);
    // A revisit's undecided segments paint into the room the island reserves
    // for them; holding the rows for their reads replayed the pane's cover.
    const chromePendingNow = (): boolean => chromeUnsettled(scope?.current, !warm);
    let frame = 0;
    let cancelled = false;
    let previous = '';
    const reveal = () => {
      revealedTimelines.add(identity);
      // Committed before this frame paints: a scheduled update landed after
      // it, so every visit painted at least one more blank (hidden) frame.
      flushSync(() => setRevealedVisit(visitKey));
    };
    /** The reader is where the visit puts it: on the end (by the list's own extent, or by the document's while the
     *  list still holds the viewport height it first observed), or on its row. */
    const readerSet = (root: HTMLDivElement, position: { top: number; maxScrollTop: number }) =>
      pinnedRef.current
        ? position.maxScrollTop - position.top <= 1 || root.scrollHeight - root.clientHeight - root.scrollTop <= 1
        : placedRef.current();
    const measure = (root: HTMLDivElement, space: HTMLDivElement) => {
      const position = transcriptScrollPosition(root);
      // Row offsets are spacer-relative; the scroll offset includes the
      // thread's top padding (the list's `scrollInset`), so the viewport's
      // interval is moved into spacer coordinates before rows are selected.
      const inset = space.parentElement ? transcriptThreadInset(space.parentElement) : 0;
      const top = position.top - inset;
      const bottom = top + position.viewportHeight;
      const total = Number.parseFloat(space.style.height) || 0;
      const rows = space.querySelectorAll<HTMLElement>('.transcript-virtual-row');
      // The boxes that settle: the rows in view that are not streaming. A streaming reply, and with it the list's
      // extent, changes for as long as it streams.
      const signature: number[] = [position.viewportHeight];
      // The list's own end padding: the spacer below the last row, and the dock's height floating over it.
      const endPadding = TRANSCRIPT_BOTTOM_SPACER + transcriptDockInset(root);
      let visible = 0;
      const visibleRows: HTMLElement[] = [];
      const visibleRowSet = new Set<HTMLElement>();
      const closedEnds: number[] = [];
      rows.forEach((row, index) => {
        const start = Number.parseFloat(row.style.top) || 0;
        const next = rows[index + 1];
        const end = next ? Number.parseFloat(next.style.top) || 0 : total;
        if (end <= top || start >= bottom) return;
        visible++;
        visibleRows.push(row);
        visibleRowSet.add(row);
        closedEnds.push(next ? end : end - endPadding);
        if (row.querySelector(STREAMING)) return;
        signature.push(Number(row.dataset.index), start, end);
      });
      const rowsPending = settlingPending(space, visibleRowSet, eager ? BODY_PENDING : ROW_PENDING);
      return {
        position,
        visible,
        visibleRows,
        closedEnds,
        rowsPending,
        current: JSON.stringify(signature),
      };
    };
    /** An eager reveal needs its reader placed and the rows in view (not offscreen overscan rows) final: no body
     *  pending, and each at the extent the list gave it. A body that just rendered grows its row in layout a frame
     *  before the list moves the rows for it. */
    const unfilledGrowing = (position: { maxScrollTop: number }) => growing && position.maxScrollTop < 1;
    const unfilledAsking = (position: { maxScrollTop: number }) => position.maxScrollTop < 1 && askingRef.current();
    const eagerReady = (root: HTMLDivElement, measured: ReturnType<typeof measure>, set: boolean): boolean =>
      !unfilledGrowing(measured.position) &&
      !unfilledAsking(measured.position) &&
      eager &&
      measured.visible > 0 &&
      set &&
      !measured.rowsPending &&
      isExact(root, measured.visibleRows, measured.closedEnds);
    const sample = () => {
      const root = viewport.current;
      const space = content.current;
      if (!root || !space) return;
      const measured = measure(root, space);
      const { position, visible, rowsPending, current } = measured;
      if (unfilledGrowing(position)) {
        previous = '';
        return;
      }
      const chromePending = chromePendingNow();
      const pending = rowsPending || chromePending || document.fonts?.status === 'loading' || unfilledAsking(position);
      const readerOwnsPosition = hasScrollGesture();
      const set = readerSet(root, position) || readerOwnsPosition;
      const settled = visible > 0 && !pending && set && current === previous;
      if (eagerReady(root, measured, set)) {
        reveal();
        return;
      }
      if (!chromePending && (settled || readerOwnsPosition)) {
        reveal();
        return;
      }
      previous = pending ? '' : current;
      frame = requestAnimationFrame(sample);
    };
    queueMicrotask(() => {
      const root = viewport.current;
      const space = content.current;
      if (cancelled || !root || !space) return;
      const measured = measure(root, space);
      const { position, visible, visibleRows, closedEnds, rowsPending, current } = measured;
      if (eagerReady(root, measured, readerSet(root, position))) {
        cancelled = true;
        cancelAnimationFrame(frame);
        reveal();
        return;
      }
      const pending =
        rowsPending ||
        chromePendingNow() ||
        document.fonts?.status === 'loading' ||
        unfilledGrowing(position) ||
        unfilledAsking(position);
      if (
        !pending &&
        visible > 0 &&
        readerSet(root, position) &&
        isExact(root, visibleRows, closedEnds) &&
        !hasScrollGesture()
      ) {
        cancelled = true;
        cancelAnimationFrame(frame);
        reveal();
        return;
      }
      if (!pending) previous = current;
    });
    frame = requestAnimationFrame(sample);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [
    content,
    draft,
    eager,
    enabled,
    growing,
    hasScrollGesture,
    identity,
    revealedTimelines,
    revealedVisit,
    scope,
    viewport,
    visitKey,
  ]);
  return draft || !enabled || revealedVisit === visitKey;
}

/** Every given visible row, read back from layout, is exactly the extent the
 *  virtualizer gave it (up to the next row's offset), and no estimate relearn
 *  waits for its frame. The height read back is taken as the list takes it
 *  (`ceilRowHeight`); the slack only absorbs the float sums of the offsets. */
function isExact(root: HTMLElement, rows: readonly HTMLElement[], ends: readonly number[]): boolean {
  if (root.hasAttribute(TRANSCRIPT_RELEARN_ATTRIBUTE)) return false;
  return rows.every(
    (row, index) =>
      Math.abs(
        ceilRowHeight(row.getBoundingClientRect().height) - (ends[index] - (Number.parseFloat(row.style.top) || 0))
      ) < OFFSET_SLACK_PX
  );
}
