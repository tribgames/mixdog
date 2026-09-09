import { useEffect, useState } from "react";

const SESSION_LANE_WAIT_MS = 15_000;

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
  read(sessionId: string): Promise<boolean>;
}) {
  const [unavailableSession, setUnavailableSession] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!sessionId || hidden || hasLane) return;
    let current = true;
    setUnavailableSession("");
    const fail = () => { if (current) setUnavailableSession(sessionId); };
    // A pending IPC or an accepted read with a missing push must not leave a
    // logo-only pane forever. Keep listening so late data still recovers it.
    const timer = window.setTimeout(fail, SESSION_LANE_WAIT_MS);
    if (reconcileOnMount || retry > 0) {
      void read(sessionId).then((accepted) => {
        if (!accepted) fail();
      }, fail);
    }
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [hasLane, hidden, read, reconcileOnMount, retry, sessionId]);
  return {
    readUnavailable: Boolean(sessionId) && !hidden && !hasLane && unavailableSession === sessionId,
    retryRead: () => setRetry((value) => value + 1),
  };
}
