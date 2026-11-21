import { type RefObject, useEffect } from 'react';
import { TRANSCRIPT_OVERFLOW_ANCHOR } from './transcript-follow-rules';

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
