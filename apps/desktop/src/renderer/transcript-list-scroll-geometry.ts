import { type MutableRefObject, useEffect, useLayoutEffect, useRef } from 'react';
import {
  logicalScrollOffset,
  transcriptThreadInset,
  type TranscriptVirtualizer,
  viewportSize,
} from './transcript-list-geometry';
import type { TouchScrollDeviation } from './transcript-list-touch-deviation';
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
  deviation,
}: {
  viewport: { readonly current: HTMLDivElement | null };
  spacer: MutableRefObject<HTMLDivElement | null>;
  virtualizerRef: MutableRefObject<TranscriptVirtualizer>;
  domTop: MutableRefObject<number | null>;
  scrollInset: MutableRefObject<number>;
  contentHeight: () => number;
  deviation: TouchScrollDeviation;
}) {
  const geometry = useRef<{ root: HTMLDivElement; release(): void } | null>(null);
  // The thread whose inset is held. A style read outside the document is ""
  // (a pane host PersistentPanePortal has not put back yet): kept as 0, every
  // end pin landed 44px short of the bottom for the list's whole life, and a
  // room rested with its last reply clipped under the composer.
  const insetThread = useRef<Element | null>(null);
  const ensureScrollGeometry = () => {
    const root = viewport.current;
    const space = spacer.current;
    // The timeline starts below the thread's top padding (its only in-flow
    // content above the spacer). A style read, not a layout read: once per
    // thread, taken while it is in the document.
    const thread = space?.parentElement ?? null;
    if (thread && thread !== insetThread.current && thread.isConnected) {
      insetThread.current = thread;
      scrollInset.current = transcriptThreadInset(thread);
    }
    if (!root || !space || geometry.current?.root === root) return;
    geometry.current?.release();
    const instance = virtualizerRef.current;
    // Wire the core to the viewport now instead of on the next render, so
    // its observed viewport height backs the geometry from the start.
    if (instance.scrollElement !== root) instance._willUpdate();
    // Unknown until the first scroll event or write; the core's offset stands in.
    domTop.current = null;
    const unregister = registerTranscriptScrollGeometry(root, {
      viewportHeight: () => viewportSize(virtualizerRef.current),
      contentHeight,
      scrollTop: () => domTop.current ?? logicalScrollOffset(virtualizerRef.current),
      deviation: () => deviation.amount(),
      dropDeviation: () => deviation.drop(),
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
