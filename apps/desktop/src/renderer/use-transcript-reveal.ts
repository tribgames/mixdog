import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { transcriptThreadInset } from './transcript-list-geometry';
import { TRANSCRIPT_BOTTOM_SPACER, TRANSCRIPT_RELEARN_ATTRIBUTE } from './transcript-virtual-cache';
import { transcriptScrollPosition } from './use-transcript-follow';

/** A row's remembered size and offset (a virtual item of the snapshot). */
type RetainedRow = { readonly key: unknown; readonly start: number; readonly size: number };

// Bound row/font settling once the dock has answered or its wait has expired.
export const ENTRY_REVEAL_MAX_MS = 2_000;
// Total wait for entry-pending chrome (the review bar's first read, a lazy
// dock fallback); past it the reveal proceeds and the chrome may land late.
export const ENTRY_CHROME_MAX_MS = 1_500;
const DOCK_MOTION = '.composer-island-slot[data-motion], .composer-island-slot[data-reserved]';
// Undecided dock chrome too, on an entry whose island height is not known yet.
const ENTRY_CHROME_PENDING = `[data-entry-pending], ${DOCK_MOTION}`;
const ROW_PENDING = '[data-transcript-pending]';
// Revealed timelines one pane remembers, matching the geometry cache
// (transcript-virtual-cache) a warm revisit depends on.
const REVEALED_HISTORY_LIMIT = 16;

/**
 * Data readiness is not layout readiness: a virtual range can still contain
 * estimates or a suspended Markdown body. Reveal each visit once its visible
 * rows and end offset agree across samples (the commit, then each frame),
 * without adding a scroll writer.
 */
export function useTranscriptReveal({
  identity,
  enabled,
  draft,
  viewport,
  content,
  scope,
  hasScrollGesture,
  eager = false,
  retainedGeometry,
  pinned = false,
}: {
  identity: string;
  /** The timeline's virtual snapshot at departure. A warm revisit reveals in
   *  its commit only when its visible rows read back at exactly these sizes
   *  and offsets; without it the revisit enters cold. */
  retainedGeometry?: readonly RetainedRow[];
  /** The timeline follows its end: its end pin must have landed. */
  pinned?: boolean;
  enabled: boolean;
  draft: boolean;
  /** The phone: reveal as soon as a visible row holds its real content (no
   *  pending Markdown), in the frame the rows commit. */
  eager?: boolean;
  viewport: RefObject<HTMLDivElement | null>;
  content: RefObject<HTMLDivElement | null>;
  /** Conversation root: undecided chrome marks `data-entry-pending`; the
   *  island slot marks `data-motion` or `data-reserved`. */
  scope?: RefObject<HTMLElement | null>;
  hasScrollGesture(): boolean;
}): boolean {
  const [revealedIdentity, setRevealedIdentity] = useState(draft ? identity : '');
  const [visitIdentity, setVisitIdentity] = useState(identity);
  if (visitIdentity !== identity) {
    setVisitIdentity(identity);
    setRevealedIdentity('');
  }
  const [revealedBefore] = useState(() => new Set<string>());
  // Read at the commit's microtask: whether the end pin must already hold.
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  useLayoutEffect(() => {
    if (revealedIdentity === identity) return undefined;
    if (draft) {
      setRevealedIdentity(identity);
      return undefined;
    }
    if (!enabled) return undefined;
    const retained = retainedGeometry;
    const warm = Boolean(retained?.length) && revealedBefore.has(identity);
    // A revisit's undecided segments paint into the room the island reserves
    // for them; holding the rows for their reads replayed the pane's cover.
    const chrome = warm ? DOCK_MOTION : ENTRY_CHROME_PENDING;
    let frame = 0;
    let cancelled = false;
    let previous = '';
    let started = performance.now();
    const chromeStarted = started;
    let chromeGaveUp = false;
    const reveal = () => {
      revealedBefore.delete(identity);
      revealedBefore.add(identity);
      for (const oldest of revealedBefore) {
        if (revealedBefore.size <= REVEALED_HISTORY_LIMIT) break;
        revealedBefore.delete(oldest);
      }
      // Committed before this frame paints: a scheduled update landed after
      // it, so every visit painted at least one more blank (hidden) frame.
      flushSync(() => setRevealedIdentity(identity));
    };
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
      const signature: number[] = [position.viewportHeight, position.maxScrollTop, total];
      let visible = 0;
      let visiblePending = false;
      const visibleRows: HTMLElement[] = [];
      const closedEnds: number[] = [];
      rows.forEach((row, index) => {
        const start = Number.parseFloat(row.style.top) || 0;
        const next = rows[index + 1];
        const end = next ? Number.parseFloat(next.style.top) || 0 : total;
        if (end <= top || start >= bottom) return;
        visible++;
        visibleRows.push(row);
        closedEnds.push(next ? end : end - TRANSCRIPT_BOTTOM_SPACER);
        if (warm && !visiblePending) visiblePending = Boolean(row.querySelector(ROW_PENDING));
        signature.push(Number(row.dataset.index), start, end);
      });
      // An entry waits on every mounted row. A revisit's offscreen rows hold
      // their remembered boxes, so only a row on screen can still paint empty.
      const rowsPending = warm ? visiblePending : Boolean(space.querySelector(ROW_PENDING));
      return {
        position,
        visible,
        visibleRows,
        closedEnds,
        rowsPending,
        current: JSON.stringify(signature),
      };
    };
    const sample = () => {
      const root = viewport.current;
      const space = content.current;
      if (!root || !space) return;
      const { position, visible, rowsPending, current } = measure(root, space);
      const top = position.top;
      const chromeMarked = Boolean(scope?.current?.querySelector(chrome));
      const chromeExpired = performance.now() - chromeStarted >= ENTRY_CHROME_MAX_MS;
      const chromePending = chromeMarked && !chromeExpired;
      // Giving up on chrome starts the row-settle bound from here.
      if (chromeMarked && chromeExpired && !chromeGaveUp) {
        chromeGaveUp = true;
        started = performance.now();
      }
      const pending = rowsPending || chromePending || document.fonts?.status === 'loading';
      const atEnd = position.maxScrollTop - top <= 1;
      const readerOwnsPosition = hasScrollGesture();
      const placed = warm || atEnd || readerOwnsPosition;
      const settled = visible > 0 && !pending && placed && current === previous;
      if (eager && eagerReady(space, visible)) {
        reveal();
        return;
      }
      if (chromePending) started = performance.now();
      if (!chromePending && (settled || readerOwnsPosition || performance.now() - started >= ENTRY_REVEAL_MAX_MS)) {
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
      const { position, visible, visibleRows, closedEnds, rowsPending, current } = measure(root, space);
      if (eager && eagerReady(space, visible)) {
        cancelled = true;
        cancelAnimationFrame(frame);
        reveal();
        return;
      }
      const pending = rowsPending || scope?.current?.querySelector(chrome) || document.fonts?.status === 'loading';
      if (
        !warm &&
        !pending &&
        visible > 0 &&
        position.maxScrollTop - position.top <= 1 &&
        isExact(root, visibleRows, closedEnds) &&
        !hasScrollGesture()
      ) {
        cancelled = true;
        cancelAnimationFrame(frame);
        reveal();
        return;
      }
      const unchanged =
        warm &&
        !pending &&
        visible > 0 &&
        !root.hasAttribute(TRANSCRIPT_RELEARN_ATTRIBUTE) &&
        !hasScrollGesture() &&
        (!pinnedRef.current || position.maxScrollTop - position.top <= 1) &&
        matchesRetained(visibleRows, retained);
      if (unchanged) {
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
    hasScrollGesture,
    identity,
    retainedGeometry,
    revealedBefore,
    revealedIdentity,
    scope,
    viewport,
  ]);
  return draft || !enabled || revealedIdentity === identity;
}

/** Every given row, read back from layout, is exactly what was remembered for
 *  its key: the rounded border-box height the virtualizer stores for a
 *  measured row, and the offset it positions the row at. No tolerance. */
function matchesRetained(rows: readonly HTMLElement[], retained: readonly RetainedRow[] | undefined): boolean {
  const byKey = new Map<string, RetainedRow>();
  for (const row of retained ?? []) byKey.set(String(row.key), row);
  return rows.every((row) => {
    const kept = byKey.get(row.dataset.timelineKey ?? '');
    return (
      kept !== undefined &&
      kept.size === Math.round(row.getBoundingClientRect().height) &&
      kept.start === (Number.parseFloat(row.style.top) || 0)
    );
  });
}

/** Every given visible row, read back from layout, is exactly the extent the
 *  virtualizer gave it (up to the next row's offset), and no estimate relearn
 *  waits for its frame. No tolerance. */
function isExact(root: HTMLElement, rows: readonly HTMLElement[], ends: readonly number[]): boolean {
  if (root.hasAttribute(TRANSCRIPT_RELEARN_ATTRIBUTE)) return false;
  return rows.every(
    (row, index) =>
      Math.round(row.getBoundingClientRect().height) ===
      Math.round(ends[index] - (Number.parseFloat(row.style.top) || 0))
  );
}

/** An eager reveal needs real rows only: a visible row and no suspended
 *  Markdown body, which would paint an empty row that grows a frame later. */
function eagerReady(space: HTMLDivElement, visible: number): boolean {
  return visible > 0 && !space.querySelector(ROW_PENDING);
}
