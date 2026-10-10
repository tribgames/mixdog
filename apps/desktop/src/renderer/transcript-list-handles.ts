import { type MutableRefObject, useEffect, useLayoutEffect } from 'react';
import type { createTranscriptEndPin } from './transcript-end-pin';
import { SCROLL_END_THRESHOLD_PX, type TranscriptVirtualizer } from './transcript-list-geometry';
import { rememberTranscriptVirtualMeasurements } from './transcript-virtual-cache';
import type { TranscriptRowModel } from './transcript-rows';
import { attachTranscriptSelectionDrag, type TranscriptSelectionPin } from './transcript-selection-drag';

/** On leave, replays gesture-deferred sizes and remembers the measurements. */
export function useRememberVirtualMeasurements({
  sessionKey,
  viewport,
  virtualizerRef,
  flushDeferredResizes,
}: {
  sessionKey: string;
  viewport: { readonly current: HTMLDivElement | null };
  virtualizerRef: MutableRefObject<TranscriptVirtualizer>;
  flushDeferredResizes: () => void;
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewport is an intentional re-run trigger (the snapshot is taken when the pane element changes); the virtualizer is read through its ref
  useLayoutEffect(
    () => () => {
      // Pending gesture-deferred sizes are part of the truth this snapshot
      // promises to replay on re-entry.
      flushDeferredResizes();
      rememberTranscriptVirtualMeasurements(sessionKey, virtualizerRef.current.takeSnapshot());
    },
    [flushDeferredResizes, sessionKey, viewport]
  );
}

/** Publishes the end-pin scroll and the immediate anchor flip to the parent. */
export function useTranscriptHandles({
  endPin,
  scrollToEndRef,
  setAnchorBottomRef,
  virtualizerRef,
  anchorOverride,
}: {
  endPin: ReturnType<typeof createTranscriptEndPin>;
  scrollToEndRef: MutableRefObject<(behavior?: ScrollBehavior) => void>;
  setAnchorBottomRef?: MutableRefObject<(bottom: boolean) => void>;
  virtualizerRef: MutableRefObject<TranscriptVirtualizer>;
  anchorOverride: MutableRefObject<boolean | null>;
}) {
  useLayoutEffect(() => {
    const scrollToEnd = () => {
      endPin.request();
    };
    scrollToEndRef.current = scrollToEnd;
    return () => {
      if (scrollToEndRef.current === scrollToEnd) {
        scrollToEndRef.current = () => {};
      }
    };
  }, [endPin, scrollToEndRef]);

  useLayoutEffect(() => {
    if (!setAnchorBottomRef) return undefined;
    const setAnchorBottom = (bottom: boolean) => {
      anchorOverride.current = bottom;
      const instance = virtualizerRef.current;
      const anchorTo = bottom ? 'end' : 'start';
      if (
        instance.options.anchorTo === anchorTo &&
        instance.options.followOnAppend === bottom &&
        instance.options.scrollEndThreshold === SCROLL_END_THRESHOLD_PX
      )
        return;
      instance.setOptions({
        ...instance.options,
        anchorTo,
        followOnAppend: bottom,
        scrollEndThreshold: SCROLL_END_THRESHOLD_PX,
      });
    };
    setAnchorBottomRef.current = setAnchorBottom;
    return () => {
      if (setAnchorBottomRef.current === setAnchorBottom) {
        setAnchorBottomRef.current = () => {};
      }
    };
  }, [setAnchorBottomRef, anchorOverride, virtualizerRef]);
}

/** Chromium owns the drag range; transcript-selection-drag.ts only pins the
 *  rows it spans and reports native autoscroll to the follow hook. */
export function useSelectionDrag({
  viewport,
  sessionKey,
  bottomInsetRef,
  rowsRef,
  setSelectionPin,
  onSelectionAutoScroll,
}: {
  viewport: { readonly current: HTMLDivElement | null };
  sessionKey: string;
  bottomInsetRef: MutableRefObject<number>;
  rowsRef: MutableRefObject<readonly TranscriptRowModel[]>;
  setSelectionPin: (next: TranscriptSelectionPin | null) => void;
  onSelectionAutoScroll(delta: number): void;
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionKey is an intentional re-attach trigger per session; bottomInsetRef and rowsRef are read through refs
  useEffect(() => {
    const root = viewport.current;
    if (!root) return undefined;
    return attachTranscriptSelectionDrag({
      root,
      getBottomInset: () => bottomInsetRef.current,
      rowKeyAt: (index) => rowsRef.current[index]?.key,
      setPin: setSelectionPin,
      onAutoScroll: onSelectionAutoScroll,
    });
  }, [onSelectionAutoScroll, sessionKey, setSelectionPin, viewport]);
}
