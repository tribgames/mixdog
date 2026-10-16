// A server (ssh) window reads its providers from the desktop through the model
// proxy. While that proxy reconnects, the SSH transport can stay up, so no
// reconnect event arrives: every surface waiting on desktop providers shares
// this one retry cadence and this one "unavailable" check.
import { useEffect, useRef } from 'react';

import { record } from './record-utils';

export const DESKTOP_PROVIDERS_RETRY_MS = 7_000;
const DESKTOP_PROVIDERS_UNAVAILABLE = 'Desktop model providers are unavailable';

/** The provider setup a server window answers while its desktop is away. */
export function desktopProvidersUnavailable(setup: unknown): boolean {
  const value = record(setup);
  return value.managedByClient === true && value.unavailable === true;
}

/** Passes an available setup through. An offline desktop snapshot rejects, so
 *  a cache retries it instead of storing an empty provider set. */
export function requireDesktopProviders<T>(setup: T): T {
  if (desktopProvidersUnavailable(setup)) throw new Error(DESKTOP_PROVIDERS_UNAVAILABLE);
  return setup;
}

/** Whether a failure (an Error or its message) is requireDesktopProviders'. */
export function isDesktopProvidersUnavailableError(reason: unknown): boolean {
  const text = reason instanceof Error ? reason.message : reason;
  return text === DESKTOP_PROVIDERS_UNAVAILABLE;
}

const retries = new Set<() => void>();
let timer: number | null = null;

/** Joins the shared retry; the returned function leaves it. One timer runs
 *  while anyone waits and calls every waiter on each tick. */
export function waitForDesktopProviders(retry: () => void): () => void {
  retries.add(retry);
  timer ??= window.setInterval(() => {
    for (const waiting of [...retries]) waiting();
  }, DESKTOP_PROVIDERS_RETRY_MS);
  return () => {
    retries.delete(retry);
    if (retries.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

/** Retries on the shared cadence while `waiting`; `retry` may change freely. */
export function useDesktopProvidersRetry(waiting: boolean, retry: () => void): void {
  const latest = useRef(retry);
  latest.current = retry;
  useEffect(() => {
    if (!waiting) return;
    return waitForDesktopProviders(() => latest.current());
  }, [waiting]);
}
