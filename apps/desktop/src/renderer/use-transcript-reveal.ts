import { useLayoutEffect, useState, type RefObject } from "react";

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
  const [revealedIdentity, setRevealedIdentity] = useState(draft ? identity : "");
  useLayoutEffect(() => {
    if (revealedIdentity === identity) return undefined;
    if (draft) {
      setRevealedIdentity(identity);
      return undefined;
    }
    if (!enabled) return undefined;
    let frame = 0;
    let previous = "";
    const started = performance.now();
    const sample = () => {
      const root = viewport.current;
      const space = content.current;
      if (!root || !space) return;
      const box = root.getBoundingClientRect();
      const rows = [...space.querySelectorAll<HTMLElement>(".transcript-virtual-row")];
      const signature = [box.width, box.height];
      let visible = 0;
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom <= box.top || rect.top >= box.bottom) continue;
        visible++;
        signature.push(Number(row.dataset.index), rect.top, rect.height);
      }
      const current = JSON.stringify(signature);
      const pending = space.querySelector("[data-transcript-pending]")
        || document.fonts?.status === "loading";
      const atEnd = root.scrollHeight - root.clientHeight - root.scrollTop <= 1;
      const readerOwnsPosition = hasScrollGesture();
      const settled = visible > 0 && !pending && (atEnd || readerOwnsPosition)
        && current === previous;
      if (settled || readerOwnsPosition || performance.now() - started >= MAX_REVEAL_WAIT_MS) {
        setRevealedIdentity(identity);
        return;
      }
      previous = pending ? "" : current;
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    return () => cancelAnimationFrame(frame);
  }, [content, draft, enabled, hasScrollGesture, identity, revealedIdentity, viewport]);
  return draft || !enabled || revealedIdentity === identity;
}
