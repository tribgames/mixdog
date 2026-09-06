import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionDiffResult } from "./session-diff-model";
import { fetchSessionDiff, peekSessionDiff } from "./session-diff-cache";
import { startVisibleRefreshCadence } from "./visible-refresh-cadence";

export function useSessionDiffRefresh({
  sessionId, active, revision, busy,
}: {
  sessionId: string;
  active: boolean;
  revision: string;
  busy: boolean;
}) {
  const [result, setResult] = useState<SessionDiffResult | null>(() => peekSessionDiff(sessionId));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  useEffect(() => {
    request.current += 1;
    setResult(peekSessionDiff(sessionId));
    setError("");
  }, [sessionId]);
  const refresh = useCallback(async (force = true) => {
    if (!active || !sessionId || document.visibilityState === "hidden") return;
    const current = ++request.current;
    if (!peekSessionDiff(sessionId)) setLoading(true);
    setError("");
    try {
      const next = await fetchSessionDiff(sessionId, { force });
      if (request.current !== current) return;
      setResult(next);
    } catch (reason) {
      if (request.current !== current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (request.current === current) setLoading(false);
    }
  }, [active, sessionId]);
  useEffect(() => {
    if (!active || !sessionId) {
      setLoading(false);
      return;
    }
    void refresh(true);
    // A pane that closed or changed session cannot adopt a late response.
    return () => { request.current += 1; };
  }, [active, revision, sessionId, refresh]);
  useEffect(() => {
    if (!active || !sessionId) return;
    return startVisibleRefreshCadence({
      win: window,
      intervalMs: busy ? 4_000 : undefined,
      refresh: () => void refresh(true),
    });
  }, [active, busy, refresh, sessionId]);
  return { result, loading, error, refresh };
}
