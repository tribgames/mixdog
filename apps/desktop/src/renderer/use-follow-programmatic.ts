import { useCallback, useRef } from 'react';
import { attributeWrite } from './transcript-follow-rules';

/** Offsets WRITTEN by the virtual timeline (append follow, measured-size
 *  adjustments, entry anchoring) all route through its scrollToFn, which
 *  reports them here. They are the timeline keeping its own promise, never
 *  reader intent — counted as a gesture they released follow mid-stream
 *  (user: 자동스크롤이 너무 자주 풀린다). */
export function useProgrammaticWrites() {
  // Only the LAST write counts: scroll events coalesce per frame, and the one
  // that follows a burst reports where the burst ended.
  const lastWrite = useRef<{ at: number; tops: number[] }>({ at: 0, tops: [] });

  const markProgrammaticScroll = useCallback((top: number, intended?: number) => {
    const tops = [Math.round(top)];
    if (typeof intended === 'number' && Number.isFinite(intended)) tops.push(Math.round(intended));
    lastWrite.current = { at: Date.now(), tops };
  }, []);

  /** Does the timeline's last write explain a scroll event at this offset?
   *  Within the write window any event is that write; later, only the first
   *  event that lands exactly on what it wrote (see settleWrites). */
  const attributeScroll = useCallback((top: number) => {
    const { at, tops } = lastWrite.current;
    return attributeWrite({ lastWriteAt: at, writtenTops: tops, top, now: Date.now() });
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
