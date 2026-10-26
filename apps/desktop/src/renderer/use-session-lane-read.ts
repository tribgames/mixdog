import { useEffect, useState } from 'react';
import { reportSessionRead } from './session-read-diagnostics';
import { TRANSCRIPT_READ_TIMEOUT_MS } from '../shared/transcript-read-policy';

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
  const [retry, setRetry] = useState(0);
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
    if (reconcileOnMount || retry > 0) {
      void read(sessionId, { signal: asking.signal }).then((accepted) => {
        if (!accepted) fail();
      }, fail);
    }
    return () => {
      current = false;
      asking.abort();
      window.clearTimeout(timer);
    };
  }, [hasLane, hidden, read, reconcileOnMount, retry, sessionId]);
  return {
    readUnavailable: Boolean(sessionId) && !hidden && !hasLane && unavailableSession === sessionId,
    retryRead: () => setRetry((value) => value + 1),
  };
}
