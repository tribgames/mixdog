import { type MutableRefObject, type RefObject, useCallback, useLayoutEffect, useRef } from 'react';
import { coreScrollState, type TranscriptVirtualizer } from './transcript-list-geometry';
import { TRANSCRIPT_BOTTOM_SPACER } from './transcript-virtual-cache';

/** The viewport's own custom property for its inset: its scrollbar track and scroll padding end at the dock with it
 *  (12-transcript.css). */
export const TRANSCRIPT_DOCK_INSET = '--transcript-dock-inset';
/** The viewports 12-transcript.css runs on under a dock; any other has nothing covering it. */
const DOCKED_VIEWPORT = '.conversation > .transcript-shell > .transcript';

/** The height of a viewport's bottom the dock covers now, as the list last laid it out. */
export function transcriptDockInset(viewport: HTMLElement): number {
  return Number.parseFloat(viewport.style.getPropertyValue(TRANSCRIPT_DOCK_INSET)) || 0;
}

/** What of the viewport the dock covers: the viewport keeps the conversation's height and runs on under the dock,
 *  while its shell ends at the dock's top edge and clips the rest. */
export function dockInset(viewport: { bottom: number }, shell: { bottom: number }): number {
  return Math.max(0, Math.round(viewport.bottom - shell.bottom));
}

/** Keeps the tail above the dock floating over the viewport's bottom: the covered height is the scroll content's
 *  bottom inset, learned in the observer pass that lays the dock (or a soft keyboard) out, and the view is put back in
 *  that same pass, before the frame paints. The composer, the island and the keyboard changing height so never resize
 *  the viewport. Returns `sync`, which lays the inset out from the layout as it stands now: a write that places the
 *  reader calls it first, so the end it clamps against is final whichever observer runs first. */
export function useDockInset({
  viewport,
  spacer,
  virtualizerRef,
  bottomInset,
  onChange,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  spacer: RefObject<HTMLDivElement | null>;
  virtualizerRef: MutableRefObject<TranscriptVirtualizer>;
  /** The inset the virtualizer's paddingEnd carries (transcript-list-virtualizer.ts). */
  bottomInset: MutableRefObject<number>;
  /** The inset changed in an observer's pass: the view is put back (the end pinned, or the reader's place landed). */
  onChange: () => void;
}): () => boolean {
  const watched = useRef<{ element: HTMLDivElement; stop(): void } | null>(null);
  const latest = useRef(onChange);
  latest.current = onChange;
  const docked = useCallback((): HTMLDivElement | null => {
    const element = viewport.current ?? spacer.current?.closest<HTMLDivElement>(DOCKED_VIEWPORT) ?? null;
    return element?.parentElement && element.matches(DOCKED_VIEWPORT) ? element : null;
  }, [viewport, spacer]);
  const sync = useCallback((): boolean => {
    const element = docked();
    const shell = element?.parentElement;
    if (!element || !shell) return false;
    const box = shell.getBoundingClientRect();
    // A pane laid out at no size (hidden) keeps the inset it had.
    if (box.width === 0 && box.height === 0) return false;
    const inset = dockInset(element.getBoundingClientRect(), box);
    // The viewport outlives the list: one a list before this one laid out still carries that list's inset.
    if (transcriptDockInset(element) !== inset) element.style.setProperty(TRANSCRIPT_DOCK_INSET, `${inset}px`);
    if (inset === bottomInset.current) return false;
    bottomInset.current = inset;
    const instance = virtualizerRef.current;
    instance.options.paddingEnd = TRANSCRIPT_BOTTOM_SPACER + inset;
    // The new extent reaches the spacer through the core's own direct write, which keeps its record of it.
    coreScrollState(instance).notify(false);
    return true;
  }, [bottomInset, docked, virtualizerRef]);
  // The viewport is an ancestor: its ref is set after the commit that mounts the list ran its layout effects. The
  // list's own spacer is in the document by then, so the first frame is laid out with the inset already.
  const watch = () => {
    const element = docked();
    const shell = element?.parentElement;
    if (!element || !shell || watched.current?.element === element) return;
    watched.current?.stop();
    const apply = () => {
      if (watched.current?.element === element && sync()) latest.current();
    };
    // Read once the whole commit is laid out: the dock is a later sibling, whose own layout effects (the composer
    // sizing its field) run after the list's. Still before the frame paints.
    queueMicrotask(apply);
    // As virtual-core's own viewport observer: a document without layout delivery (a test DOM) has no resize to see.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(apply) : null;
    observer?.observe(shell);
    observer?.observe(element);
    watched.current = { element, stop: () => observer?.disconnect() };
  };
  useLayoutEffect(watch);
  useLayoutEffect(
    () => () => {
      watched.current?.stop();
      watched.current = null;
    },
    []
  );
  return sync;
}
