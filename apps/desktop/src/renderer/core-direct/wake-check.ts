// A machine that slept (or lost its network) can leave the window's link looking open while nothing travels on it. Nothing
// reports that, so the window looks for it: a timer that finds much more time gone than it asked for, or the browser saying it
// is online again, asks the client to check the link: the client's health machine (packages/protocol-client/src/health.ts) voids
// whatever it was measuring, sends a fresh probe, and drops the link only if a whole observation window then passes with no
// progress from the core. This file only notices the wake; it holds no deadline of its own.

import { SCHEDULING_GAP_MS } from '../../../../../packages/protocol-client/src/health.ts';

/** How often the clock is looked at. */
export const WAKE_POLL_MS = 5_000;
/** How much more than the poll interval must have passed for the machine to be taken for one that slept: the one gap policy, the
 *  health machine's too. */
export const WAKE_GAP_MS = SCHEDULING_GAP_MS;

export interface WakeWatch {
  check(): unknown;
  now?(): number;
  setInterval?(run: () => void, ms: number): unknown;
  clearInterval?(timer: unknown): void;
  /** The target the `online` event comes from (the window). */
  events?: {
    addEventListener(type: 'online', run: () => void): void;
    removeEventListener(type: 'online', run: () => void): void;
  };
  pollMs?: number;
  gapMs?: number;
}

/** Starts looking; returns the stop. */
export function watchWake({
  check,
  now = Date.now,
  setInterval: every = (run, ms) => {
    const timer = globalThis.setInterval(run, ms);
    // Looking never keeps a process alive (a page has no such handle).
    (timer as unknown as { unref?: () => void }).unref?.();
    return timer;
  },
  clearInterval: stopEvery = (timer) => globalThis.clearInterval(timer as number),
  events,
  pollMs = WAKE_POLL_MS,
  gapMs = WAKE_GAP_MS,
}: WakeWatch): () => void {
  let last = now();
  const ask = (): void => void Promise.resolve(check()).catch(() => undefined);
  const timer = every(() => {
    const at = now();
    const gone = at - last;
    last = at;
    if (gone > pollMs + gapMs) ask();
  }, pollMs);
  events?.addEventListener('online', ask);
  return () => {
    stopEvery(timer);
    events?.removeEventListener('online', ask);
  };
}
