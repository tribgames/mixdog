import { SCHEDULING_GAP_MS } from '../../../../../packages/protocol-client/src/health.ts';

/** How often the clock is looked at. */
export const WAKE_POLL_MS = 5_000;
/** How much more than the poll interval must have passed for the machine to be taken for one that slept: the one gap policy, the
 *  health machine's too. */
export const WAKE_GAP_MS = SCHEDULING_GAP_MS;

export interface WakeVisibilityTarget {
  readonly visibilityState?: string;
  addEventListener(type: 'visibilitychange', run: () => void): void;
  removeEventListener(type: 'visibilitychange', run: () => void): void;
}

export interface WakeWatch {
  check(): unknown;
  now?(): number;
  setInterval?(run: () => void, ms: number): unknown;
  clearInterval?(timer: unknown): void;
  /** The target the `online` and `pageshow` events come from (the window). */
  events?: {
    addEventListener(type: 'online', run: () => void): void;
    addEventListener(type: 'pageshow', run: (event?: { persisted?: boolean }) => void): void;
    removeEventListener(type: 'online', run: () => void): void;
    removeEventListener(type: 'pageshow', run: (event?: { persisted?: boolean }) => void): void;
  };
  /** The target the `visibilitychange` event comes from (the document); defaults to `globalThis.document` when present. */
  visibility?: WakeVisibilityTarget | null;
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
  visibility = typeof document === 'undefined' ? undefined : document,
  pollMs = WAKE_POLL_MS,
  gapMs = WAKE_GAP_MS,
}: WakeWatch): () => void {
  let last = now();
  const visibilityTarget =
    visibility &&
    typeof visibility.addEventListener === 'function' &&
    typeof visibility.removeEventListener === 'function'
      ? visibility
      : null;
  let wasHidden = visibilityTarget?.visibilityState === 'hidden';
  const ask = (): void => void Promise.resolve(check()).catch(() => undefined);
  const onVisibilityChange = (): void => {
    const state = visibilityTarget?.visibilityState;
    if (state === 'hidden') {
      wasHidden = true;
      return;
    }
    if (state === 'visible' && wasHidden) {
      wasHidden = false;
      last = now();
      ask();
    }
  };
  const onPageShow = (event?: { persisted?: boolean }): void => {
    if (event?.persisted) {
      last = now();
      ask();
    }
  };
  const timer = every(() => {
    const at = now();
    const gone = at - last;
    last = at;
    if (gone > pollMs + gapMs) ask();
  }, pollMs);
  events?.addEventListener('online', ask);
  events?.addEventListener('pageshow', onPageShow);
  visibilityTarget?.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    stopEvery(timer);
    events?.removeEventListener('online', ask);
    events?.removeEventListener('pageshow', onPageShow);
    visibilityTarget?.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
