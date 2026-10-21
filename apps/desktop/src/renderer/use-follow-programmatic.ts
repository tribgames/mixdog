import { useCallback, useRef } from 'react';
import { PROGRAMMATIC_MEMORY, PROGRAMMATIC_WINDOW_MS, programmaticWriteMatches } from './transcript-follow-rules';

/** Offsets WRITTEN by the virtual timeline (append follow, measured-size
 *  adjustments, entry anchoring) all route through its scrollToFn, which
 *  reports them here. They are the timeline keeping its own promise, never
 *  reader intent — counted as a gesture they released follow mid-stream
 *  (user: 자동스크롤이 너무 자주 풀린다). */
export function useProgrammaticWrites() {
  const programmatic = useRef<{ top: number; time: number }[]>([]);

  const markProgrammaticScroll = useCallback((top: number, intended?: number) => {
    const time = Date.now();
    const queue = programmatic.current.filter((entry) => time - entry.time < PROGRAMMATIC_WINDOW_MS);
    queue.push({ top: Math.round(top), time });
    if (typeof intended === 'number' && Number.isFinite(intended)) {
      queue.push({ top: Math.round(intended), time });
    }
    programmatic.current = queue.slice(-PROGRAMMATIC_MEMORY);
  }, []);

  const isProgrammatic = useCallback((top: number) => {
    const time = Date.now();
    const queue = programmatic.current.filter((entry) => time - entry.time < PROGRAMMATIC_WINDOW_MS);
    programmatic.current = queue;
    if (!queue.length) return false;
    return programmaticWriteMatches({ writes: queue, top, now: time });
  }, []);

  const forgetWrites = useCallback(() => {
    programmatic.current = [];
  }, []);

  return { markProgrammaticScroll, isProgrammatic, forgetWrites };
}
