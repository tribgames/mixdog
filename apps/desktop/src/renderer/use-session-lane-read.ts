import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { reportSessionRead } from './session-read-diagnostics';
import { TRANSCRIPT_READ_TIMEOUT_MS } from '../shared/transcript-read-policy';
import { recoverCachedSessionFrame, usesVisibleSessionActivation } from './session-read-request';
import { defaultSessionLaneStore } from './session-lane-store';

/** Whether the host is restoring the session's subscription over the lane the pane shows (`restoreOwed`). */
function useRestoreOwed(sessionId: string, enabled: boolean): boolean {
  const subscribe = useCallback(
    (listener: () => void) =>
      enabled && sessionId ? defaultSessionLaneStore.subscribe(sessionId, listener) : () => {},
    [enabled, sessionId]
  );
  return useSyncExternalStore(
    subscribe,
    () => enabled && Boolean(sessionId) && defaultSessionLaneStore.get(sessionId)?.restoreOwed === true
  );
}

/** An accepted read is not readiness: only an actual lane releases the cover. */
export function useSessionLaneRead({
  sessionId,
  visit,
  hasLane,
  hidden,
  reconcileOnMount,
  read,
}: {
  sessionId: string;
  /** The presentation's visit (pane-presentation.ts): each waits for the lane, and fails to get it, on its own. */
  visit: number;
  hasLane: boolean;
  hidden: boolean;
  reconcileOnMount: boolean;
  /** `signal` aborts when this pane stops waiting (unmount, session change, its watch); `retry` is the user's Retry. */
  read(sessionId: string, options?: { signal: AbortSignal; retry?: boolean }): Promise<boolean>;
}) {
  const [unavailableWait, setUnavailableWait] = useState('');
  const [retry, setRetry] = useState<{ sessionId: string } | null>(null);
  const handledRetry = useRef<typeof retry>(null);
  const restoreOwed = useRestoreOwed(sessionId, !hidden);
  // The pane waits for a lane it does not have, or for the restore of the one it shows.
  const waiting = !hasLane || restoreOwed;
  const wait = `${sessionId}\n${visit}`;
  useEffect(() => {
    if (!sessionId || hidden || !waiting) return;
    let current = true;
    const asking = new AbortController();
    setUnavailableWait('');
    const fail = () => {
      if (current) setUnavailableWait(wait);
    };
    // A pending IPC or an accepted read with a missing push must not leave a
    // logo-only pane forever, nor a restore that never ends its stale rows.
    // The watch ends this wait: the read stops being asked for, and Retry asks
    // again, which the host answers with a new attach in place of the one that
    // never arrived. Late data still recovers the pane.
    const timer = window.setTimeout(() => {
      reportSessionRead(sessionId, 'wait-expired', { hasLane });
      asking.abort();
      fail();
    }, TRANSCRIPT_READ_TIMEOUT_MS);
    const retryRequested = retry?.sessionId === sessionId && retry !== handledRetry.current;
    if (retryRequested) handledRetry.current = retry;
    // Over a lane it shows, the pane only watches the host's own restore; it asks for nothing until Retry.
    if (retryRequested || (!hasLane && reconcileOnMount && !usesVisibleSessionActivation())) {
      void read(sessionId, { signal: asking.signal, ...(retryRequested ? { retry: true } : {}) }).then((accepted) => {
        if (!accepted) fail();
      }, fail);
    } else if (!hasLane && usesVisibleSessionActivation()) {
      recoverCachedSessionFrame(sessionId);
    }
    return () => {
      current = false;
      asking.abort();
      window.clearTimeout(timer);
    };
  }, [hasLane, hidden, read, reconcileOnMount, retry, sessionId, wait, waiting]);
  return {
    readUnavailable: Boolean(sessionId) && !hidden && waiting && unavailableWait === wait,
    retryRead: () => setRetry({ sessionId }),
  };
}
