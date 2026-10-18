import { useEffect, useState } from 'react';

const tickers = new Set<(now: number) => void>();
let timer = 0;

/** One shared one-second interval for every ticking readout. Each readout
 *  owning its own interval rendered (and restyled) the window once per
 *  readout per second — a running turn with a few agents, tool cards and the
 *  activity band meant a dozen separate commits every second. Every listener
 *  called in one task lands in one batched commit. */
function subscribeSecond(listener: (now: number) => void): () => void {
  tickers.add(listener);
  if (!timer) {
    timer = window.setInterval(() => {
      const now = Date.now();
      for (const tick of [...tickers]) tick(now);
    }, 1_000);
  }
  return () => {
    tickers.delete(listener);
    if (tickers.size > 0 || !timer) return;
    window.clearInterval(timer);
    timer = 0;
  };
}

/** Wall-clock milliseconds that tick once a second only while `active`, so an
 *  idle surface costs no timers. Only the component calling it re-renders. */
export function useClock(active: boolean): number {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setClock(Date.now());
    return subscribeSecond(setClock);
  }, [active]);
  return clock;
}
