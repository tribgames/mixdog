import { type RefObject, useEffect } from 'react';
import { TRANSCRIPT_OVERFLOW_ANCHOR } from './transcript-follow-rules';

/** Keeps browser anchoring off and the jump control current as the viewport
 *  and content boxes change. Follow itself is never decided here: pinned
 *  growth is the timeline's end pin, and the pinned flag changes only on the
 *  reader's input or a judged scroll. */
export function useFollowContentObserver({
  viewport,
  content,
  contentMounted,
  sessionKey,
  scheduleScrollState,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  content: RefObject<HTMLDivElement | null>;
  contentMounted: boolean;
  sessionKey: string;
  scheduleScrollState(element: HTMLDivElement): void;
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: contentMounted and sessionKey are re-attach triggers
  useEffect(() => {
    const target = content.current;
    const element = viewport.current;
    if (!target || !element) return undefined;
    // Virtual-core owns every measured-size correction. Browser anchoring must
    // stay off after follow releases too; otherwise both authorities compensate
    // the same above-viewport resize and reverse each other during upward
    // wheel, touch, and scrollbar motion.
    element.style.overflowAnchor = TRANSCRIPT_OVERFLOW_ANCHOR;
    // Chromium always provides ResizeObserver. The renderer's jsdom harness
    // intentionally omits it in tests that do not exercise layout delivery.
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => {
      const root = viewport.current;
      if (root) scheduleScrollState(root);
    });
    observer.observe(element);
    observer.observe(target);
    return () => observer.disconnect();
  }, [content, contentMounted, scheduleScrollState, sessionKey, viewport]);
}
