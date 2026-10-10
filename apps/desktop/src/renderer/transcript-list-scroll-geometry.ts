import { type MutableRefObject, useEffect, useLayoutEffect, useRef } from 'react';
import { logicalScrollOffset, type TranscriptVirtualizer, viewportSize } from './transcript-list-geometry';
import { registerTranscriptScrollGeometry } from './use-transcript-follow';

/** The follow hook, reveal and history fill read this viewport's extent and
 *  offset from here, never from layout on a scroll event or frame. The
 *  viewport's ref attaches AFTER this list's layout effects when both mount
 *  in one commit, so registration is retried on every commit (layout, then
 *  passive — before the parent's passive effects read it) until it holds. */
export function useTranscriptScrollGeometry({
  viewport,
  spacer,
  virtualizerRef,
  domTop,
  scrollInset,
  contentHeight,
}: {
  viewport: { readonly current: HTMLDivElement | null };
  spacer: MutableRefObject<HTMLDivElement | null>;
  virtualizerRef: MutableRefObject<TranscriptVirtualizer>;
  domTop: MutableRefObject<number | null>;
  scrollInset: MutableRefObject<number>;
  contentHeight: () => number;
}) {
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
}
