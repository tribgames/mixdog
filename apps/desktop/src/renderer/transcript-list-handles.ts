import { type MutableRefObject, useEffect, useLayoutEffect } from 'react';
import type { createTranscriptEndPin } from './transcript-end-pin';
import { SCROLL_END_THRESHOLD_PX, type TranscriptVirtualizer } from './transcript-list-geometry';
import { rememberTranscriptVirtualMeasurements } from './transcript-virtual-cache';
import type { TranscriptRowModel } from './transcript-rows';
import { attachTranscriptSelectionDrag, type TranscriptSelectionPin } from './transcript-selection-drag';

/** On leave, lands held and gesture-deferred sizes and remembers the
 *  measurements. */
export function useRememberVirtualMeasurements({
  sessionKey,
  viewport,
  virtualizerRef,
  flushDeferredResizes,
  settleHeldShrinks,
}: {
  sessionKey: string;
  viewport: { readonly current: HTMLDivElement | null };
  virtualizerRef: MutableRefObject<TranscriptVirtualizer>;
  flushDeferredResizes: () => void;
  settleHeldShrinks: (force?: boolean) => void;
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewport is an intentional re-run trigger (the snapshot is taken when the pane element changes); the virtualizer is read through its ref
  useLayoutEffect(
    () => () => {
      // A streaming row's held slot is not its size: re-entry would replay
      // the stale slot. Its real size lands first (a deferral it meets is
      // replayed just below), then pending gesture-deferred sizes — both
      // part of the truth this snapshot promises to replay on re-entry.
      settleHeldShrinks(true);
      flushDeferredResizes();
      rememberTranscriptVirtualMeasurements(sessionKey, virtualizerRef.current.takeSnapshot());
    },
    [flushDeferredResizes, settleHeldShrinks, sessionKey, viewport]
  );
}

/** Publishes the end-pin scroll and the immediate anchor flip to the parent. */
export function useTranscriptHandles({
  endPin,
  scrollToEndRef,
  setAnchorBottomRef,
  virtualizerRef,
  anchorOverride,
  settleHeldShrinks,
}: {
  endPin: ReturnType<typeof createTranscriptEndPin>;
  scrollToEndRef: MutableRefObject<(behavior?: ScrollBehavior) => void>;
  setAnchorBottomRef?: MutableRefObject<(bottom: boolean) => void>;
  virtualizerRef: MutableRefObject<TranscriptVirtualizer>;
  anchorOverride: MutableRefObject<boolean | null>;
  settleHeldShrinks: () => void;
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
        instance.options.anchorTo !== anchorTo ||
        instance.options.followOnAppend !== bottom ||
        instance.options.scrollEndThreshold !== SCROLL_END_THRESHOLD_PX
      ) {
        instance.setOptions({
          ...instance.options,
          anchorTo,
          followOnAppend: bottom,
          scrollEndThreshold: SCROLL_END_THRESHOLD_PX,
        });
      }
      // A slot held for the followed tail is the reader's geometry now: its
      // real size lands in this same task, not at the next render.
      if (!bottom) settleHeldShrinks();
    };
    setAnchorBottomRef.current = setAnchorBottom;
    return () => {
      if (setAnchorBottomRef.current === setAnchorBottom) {
        setAnchorBottomRef.current = () => {};
      }
    };
  }, [setAnchorBottomRef, anchorOverride, virtualizerRef, settleHeldShrinks]);
}

/** Chromium owns the drag range; transcript-selection-drag.ts only pins the
 *  rows it spans and reports native autoscroll to the follow hook. */
export function useSelectionDrag({
  viewport,
  sessionKey,
  rowsRef,
  setSelectionPin,
  onSelectionAutoScroll,
}: {
  viewport: { readonly current: HTMLDivElement | null };
  sessionKey: string;
  rowsRef: MutableRefObject<readonly TranscriptRowModel[]>;
  setSelectionPin: (next: TranscriptSelectionPin | null) => void;
  onSelectionAutoScroll(delta: number): void;
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionKey is an intentional re-attach trigger per session; rowsRef is read through its ref
  useEffect(() => {
    const root = viewport.current;
    if (!root) return undefined;
    return attachTranscriptSelectionDrag({
      root,
      rowKeyAt: (index) => rowsRef.current[index]?.key,
      setPin: setSelectionPin,
      onAutoScroll: onSelectionAutoScroll,
    });
  }, [onSelectionAutoScroll, sessionKey, setSelectionPin, viewport]);
}
