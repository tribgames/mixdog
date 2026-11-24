import { useCallback, useRef } from 'react';
import { atWrittenOffset } from './transcript-follow-rules';

export function useProgrammaticWrites() {
  // The offsets written since the last scroll event: scroll events coalesce per frame, and the one that follows a
  // burst reports where one of its writes left the scroller.
  const lastWrite = useRef<{ at: number; tops: number[] }>({ at: 0, tops: [] });

  const markProgrammaticScroll = useCallback((top: number, intended?: number) => {
    const tops = [...lastWrite.current.tops, Math.round(top)];
    if (typeof intended === 'number' && Number.isFinite(intended)) tops.push(Math.round(intended));
    lastWrite.current = { at: Date.now(), tops };
  }, []);

  /** Does a write explain a scroll event at this offset: one the timeline made since the last event (see settleWrites),
   *  or `own`, a write the app made into the viewport from outside the timeline (own-scroll-writes.ts), which is that
   *  write's own event? */
  const attributeScroll = useCallback((top: number, own?: { at: number; top: number }) => {
    if (own) lastWrite.current = { at: Math.max(own.at, lastWrite.current.at), tops: [own.top] };
    return atWrittenOffset(lastWrite.current.tops, top);
  }, []);

  /** A scroll event has been judged: the written value is spent. */
  const settleWrites = useCallback(() => {
    lastWrite.current = { at: lastWrite.current.at, tops: [] };
  }, []);

  /** When the timeline last wrote the offset (0 before any write). */
  const lastWriteAt = useCallback(() => lastWrite.current.at, []);

  const forgetWrites = useCallback(() => {
    lastWrite.current = { at: 0, tops: [] };
  }, []);

  return { markProgrammaticScroll, attributeScroll, settleWrites, lastWriteAt, forgetWrites };
}
