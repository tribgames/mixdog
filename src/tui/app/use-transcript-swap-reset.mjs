/*
 * app/use-transcript-swap-reset.mjs — returns the viewport to the live tail
 * when the transcript items are bulk-swapped.
 *
 * Item-count changes never infer follow permission from scrollTarget=0. A
 * first read-back input can be waiting one frame for committed row geometry;
 * only prompt submit, session reset, or an explicit return to bottom arms
 * follow. Pure streaming height growth is handled in the row-delta effect.
 */
import { useLayoutEffect } from 'react';
import { transcriptSwapReturnsToTail } from './transcript-window.mjs';

export function useTranscriptSwapReset({ items, lastItemsCountRef, lastFirstItemIdRef, resetTranscriptScroll }) {
  useLayoutEffect(() => {
    const count = items.length;
    const previousCount = lastItemsCountRef.current;
    lastItemsCountRef.current = count;
    const firstId = count > 0 ? (items[0]?.id ?? null) : null;
    const previousFirstId = lastFirstItemIdRef.current;
    lastFirstItemIdRef.current = firstId;
    // A bulk swap (compaction included) is an explicit return to the tail: the
    // rows the reader was anchored to no longer exist.
    if (transcriptSwapReturnsToTail({ count, previousCount, firstId, previousFirstId })) {
      resetTranscriptScroll();
    }
  }, [items, lastItemsCountRef, lastFirstItemIdRef, resetTranscriptScroll]);
}
