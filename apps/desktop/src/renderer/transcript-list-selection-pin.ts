import { type MutableRefObject, useCallback, useRef, useState } from 'react';
import type { TranscriptRowModel } from './transcript-rows';
import type { TranscriptSelectionEndpoint, TranscriptSelectionPin } from './transcript-selection-drag';

/** Native text selection keeps DOM boundary points. If virtualization
 *  unmounts either endpoint while a drag auto-scrolls, Chromium reconnects
 *  the range to an unrelated surviving node and the highlight appears to
 *  flip back up the transcript. Keep the selected row span mounted until the
 *  browser selection collapses. */
export function useSelectionPin(rowsRef: MutableRefObject<readonly TranscriptRowModel[]>) {
  const selectionPinned = useRef<TranscriptSelectionPin | null>(null);
  const [, invalidateSelectionPin] = useState(0);
  const setSelectionPin = useCallback((next: TranscriptSelectionPin | null) => {
    const current = selectionPinned.current;
    if (
      current === next ||
      (current &&
        next &&
        Object.is(current.anchor.key, next.anchor.key) &&
        Object.is(current.focus.key, next.focus.key))
    )
      return;
    selectionPinned.current = next;
    invalidateSelectionPin((version) => version + 1);
  }, []);
  const selectionPinnedIndexes = () => {
    const pin = selectionPinned.current;
    if (!pin) return [];
    const resolve = (endpoint: TranscriptSelectionEndpoint) => {
      if (Object.is(rowsRef.current[endpoint.index]?.key, endpoint.key)) {
        return endpoint.index;
      }
      return rowsRef.current.findIndex((row) => Object.is(row.key, endpoint.key));
    };
    const anchor = resolve(pin.anchor);
    const focus = resolve(pin.focus);
    if (anchor < 0 || focus < 0) return [];
    const start = Math.min(anchor, focus);
    const end = Math.max(anchor, focus);
    return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
  };
  return { setSelectionPin, selectionPinnedIndexes };
}
