import { useLayoutEffect, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { transcriptScrollPosition } from './use-transcript-follow';

// Bound row/font settling once the dock has answered or its wait has expired.
export const ENTRY_REVEAL_MAX_MS = 2_000;
// Total wait for entry-pending chrome (the review bar's first read, a lazy
// dock fallback); past it the reveal proceeds and the chrome may land late.
export const ENTRY_CHROME_MAX_MS = 1_500;
// Undecided dock chrome, and a dock still easing to a new height: the
// viewport the rows are pinned to reaches its observer a frame after each
// step, so a reveal mid-motion painted the tail moving with the dock.
const ENTRY_CHROME_PENDING = '[data-entry-pending], .composer-island-slot[data-motion]';

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
}: {
  identity: string;
  enabled: boolean;
  draft: boolean;
  viewport: RefObject<HTMLDivElement | null>;
  content: RefObject<HTMLDivElement | null>;
  /** Conversation root: chrome outside the rows (the review bar) marks its
   *  undecided entry state with `data-entry-pending`; the island slot marks
   *  its height motion with `data-motion`. */
  scope?: RefObject<HTMLElement | null>;
  hasScrollGesture(): boolean;
}): boolean {
  const [revealedIdentity, setRevealedIdentity] = useState(draft ? identity : '');
  // Each visit earns its own reveal. Leaving an entry before it settled kept
  // the PREVIOUS session's identity recorded, so going straight back to that
  // session skipped the gate and painted it on the outgoing dock inset — the
  // tail then jumped by the island height a frame later.
  const [visitIdentity, setVisitIdentity] = useState(identity);
  if (visitIdentity !== identity) {
    setVisitIdentity(identity);
    setRevealedIdentity('');
  }
  useLayoutEffect(() => {
    if (revealedIdentity === identity) return undefined;
    if (draft) {
      setRevealedIdentity(identity);
      return undefined;
    }
    if (!enabled) return undefined;
    let frame = 0;
    let cancelled = false;
    let previous = '';
    let started = performance.now();
    const chromeStarted = started;
    let chromeGaveUp = false;
    // Geometry only, never layout: this samples right after commits, where
    // rect reads forced a layout of the whole list. The timeline supplies
    // offset and extent; each row's virtual position is its inline top, and it
    // ends where the next row (or the list) starts, so any measured size
    // change moves the signature.
    const measure = (root: HTMLDivElement, space: HTMLDivElement) => {
      const position = transcriptScrollPosition(root);
      const top = position.top;
      const bottom = top + position.viewportHeight;
      const total = Number.parseFloat(space.style.height) || 0;
      const rows = space.querySelectorAll<HTMLElement>('.transcript-virtual-row');
      const signature: number[] = [position.viewportHeight, position.maxScrollTop, total];
      let visible = 0;
      rows.forEach((row, index) => {
        const start = Number.parseFloat(row.style.top) || 0;
        const next = rows[index + 1];
        const end = next ? Number.parseFloat(next.style.top) || 0 : total;
        if (end <= top || start >= bottom) return;
        visible++;
        signature.push(Number(row.dataset.index), start, end);
      });
      return { position, visible, current: JSON.stringify(signature) };
    };
    const sample = () => {
      const root = viewport.current;
      const space = content.current;
      if (!root || !space) return;
      const { position, visible, current } = measure(root, space);
      const top = position.top;
      const chromeMarked = Boolean(scope?.current?.querySelector(ENTRY_CHROME_PENDING));
      const chromeExpired = performance.now() - chromeStarted >= ENTRY_CHROME_MAX_MS;
      const chromePending = chromeMarked && !chromeExpired;
      // Giving up on chrome starts the row-settle bound from here.
      if (chromeMarked && chromeExpired && !chromeGaveUp) {
        chromeGaveUp = true;
        started = performance.now();
      }
      const pending =
        space.querySelector('[data-transcript-pending]') || chromePending || document.fonts?.status === 'loading';
      const atEnd = position.maxScrollTop - top <= 1;
      const readerOwnsPosition = hasScrollGesture();
      const settled = visible > 0 && !pending && (atEnd || readerOwnsPosition) && current === previous;
      if (chromePending) started = performance.now();
      if (!chromePending && (settled || readerOwnsPosition || performance.now() - started >= ENTRY_REVEAL_MAX_MS)) {
        // Committed before this frame paints: a scheduled update landed after
        // it, so every visit painted at least one more blank (hidden) frame.
        flushSync(() => setRevealedIdentity(identity));
        return;
      }
      previous = pending ? '' : current;
      frame = requestAnimationFrame(sample);
    };
    // The first stable sample is the commit itself, once its microtasks (the
    // end pin's write) have run. A revisit whose restored geometry is already
    // final then reveals in the first frame instead of painting the pane
    // blank for two frames — or for as long as the tasks after the switch
    // take on a slow device.
    queueMicrotask(() => {
      const root = viewport.current;
      const space = content.current;
      if (cancelled || !root || !space) return;
      const pending =
        space.querySelector('[data-transcript-pending]') ||
        scope?.current?.querySelector(ENTRY_CHROME_PENDING) ||
        document.fonts?.status === 'loading';
      if (!pending) previous = measure(root, space).current;
    });
    frame = requestAnimationFrame(sample);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [content, draft, enabled, hasScrollGesture, identity, revealedIdentity, scope, viewport]);
  return draft || !enabled || revealedIdentity === identity;
}
