import { useLayoutEffect, useState, type RefObject } from 'react';
import { transcriptScrollPosition } from './use-transcript-follow';

// Bound row/font settling once the dock has answered or its wait has expired.
export const ENTRY_REVEAL_MAX_MS = 2_000;
// Total wait for entry-pending chrome (the review bar's first read, a lazy
// dock fallback); past it the reveal proceeds and the chrome may land late.
export const ENTRY_CHROME_MAX_MS = 1_500;

/**
 * Data readiness is not layout readiness: a virtual range can still contain
 * estimates or a suspended Markdown body. Reveal each visit once its visible
 * rows and end offset agree across frames, without adding a scroll writer.
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
   *  undecided entry state with `data-entry-pending`. */
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
    let previous = '';
    let started = performance.now();
    const chromeStarted = started;
    let chromeGaveUp = false;
    const sample = () => {
      const root = viewport.current;
      const space = content.current;
      if (!root || !space) return;
      // Geometry only, never layout: this samples every frame right after
      // commits, where rect reads forced a layout of the whole list. The
      // timeline supplies offset and extent; each row's virtual position is
      // its inline top, and it ends where the next row (or the list) starts,
      // so any measured size change moves the signature.
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
      const current = JSON.stringify(signature);
      const chromeMarked = Boolean(scope?.current?.querySelector('[data-entry-pending]'));
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
        setRevealedIdentity(identity);
        return;
      }
      previous = pending ? '' : current;
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    return () => cancelAnimationFrame(frame);
  }, [content, draft, enabled, hasScrollGesture, identity, revealedIdentity, scope, viewport]);
  return draft || !enabled || revealedIdentity === identity;
}
