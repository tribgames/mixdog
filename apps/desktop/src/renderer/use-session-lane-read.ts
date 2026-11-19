import { useEffect, useRef, useState } from 'react';
import { reportSessionRead } from './session-read-diagnostics';
import { TRANSCRIPT_READ_TIMEOUT_MS } from '../shared/transcript-read-policy';
import { recoverCachedSessionFrame, usesVisibleSessionActivation } from './session-read-request';

/** An accepted read is not readiness: only an actual lane releases the cover. */
export function useSessionLaneRead({
  sessionId,
  hasLane,
  hidden,
  reconcileOnMount,
  read,
}: {
  sessionId: string;
  hasLane: boolean;
  hidden: boolean;
  reconcileOnMount: boolean;
  /** `signal` aborts when this pane stops waiting (unmount, session change). */
  read(sessionId: string, options?: { signal: AbortSignal }): Promise<boolean>;
}) {
  const [unavailableSession, setUnavailableSession] = useState('');
  const [retry, setRetry] = useState<{ sessionId: string } | null>(null);
  const handledRetry = useRef<typeof retry>(null);
  useEffect(() => {
    if (!sessionId || hidden || hasLane) return;
    let current = true;
    const asking = new AbortController();
    setUnavailableSession('');
    const fail = () => {
      if (current) setUnavailableSession(sessionId);
    };
    // A pending IPC or an accepted read with a missing push must not leave a
    // logo-only pane forever. Keep listening so late data still recovers it.
    const timer = window.setTimeout(() => {
      reportSessionRead(sessionId, 'wait-expired', { hasLane: false });
      fail();
    }, TRANSCRIPT_READ_TIMEOUT_MS);
    const retryRequested = retry?.sessionId === sessionId && retry !== handledRetry.current;
    if (retryRequested || (reconcileOnMount && !usesVisibleSessionActivation())) {
      if (retryRequested) handledRetry.current = retry;
      void read(sessionId, { signal: asking.signal }).then((accepted) => {
        if (!accepted) fail();
      }, fail);
    } else if (usesVisibleSessionActivation()) {
      recoverCachedSessionFrame(sessionId);
    }
    return () => {
      current = false;
      asking.abort();
      window.clearTimeout(timer);
    };
  }, [hasLane, hidden, read, reconcileOnMount, retry, sessionId]);
  return {
    readUnavailable: Boolean(sessionId) && !hidden && !hasLane && unavailableSession === sessionId,
    retryRead: () => setRetry({ sessionId }),
  };
}
