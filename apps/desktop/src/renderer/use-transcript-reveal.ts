import { useLayoutEffect, useState, type RefObject } from 'react';
import { transcriptScrollPosition } from './use-transcript-follow';

// A streaming session or an unavailable font must not leave the conversation
// hidden indefinitely. This is only an entry gate, never a live-update gate.
const MAX_REVEAL_WAIT_MS = 1000;

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
  hasScrollGesture,
}: {
  identity: string;
  enabled: boolean;
  draft: boolean;
  viewport: RefObject<HTMLDivElement | null>;
  content: RefObject<HTMLDivElement | null>;
  hasScrollGesture(): boolean;
}): boolean {
  const [revealedIdentity, setRevealedIdentity] = useState(draft ? identity : '');
  useLayoutEffect(() => {
    if (revealedIdentity === identity) return undefined;
    if (draft) {
      setRevealedIdentity(identity);
      return undefined;
    }
    if (!enabled) return undefined;
    let frame = 0;
    let previous = '';
    const started = performance.now();
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
      const pending = space.querySelector('[data-transcript-pending]') || document.fonts?.status === 'loading';
      const atEnd = position.maxScrollTop - top <= 1;
      const readerOwnsPosition = hasScrollGesture();
      const settled = visible > 0 && !pending && (atEnd || readerOwnsPosition) && current === previous;
      if (settled || readerOwnsPosition || performance.now() - started >= MAX_REVEAL_WAIT_MS) {
        setRevealedIdentity(identity);
        return;
      }
      previous = pending ? '' : current;
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    return () => cancelAnimationFrame(frame);
  }, [content, draft, enabled, hasScrollGesture, identity, revealedIdentity, viewport]);
  return draft || !enabled || revealedIdentity === identity;
}
