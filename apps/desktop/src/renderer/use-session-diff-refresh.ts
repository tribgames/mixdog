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
  const [state, setState] = useState(() => ({
    sessionId,
    result: peekSessionDiff(sessionId) as SessionDiffResult | null,
    loading: false,
    error: "",
  }));
  // The first render (including a new session on the same host) is unknown,
  // not an empty diff. Effects must never be required to correct that claim.
  const current = state.sessionId === sessionId ? state : {
    sessionId, result: peekSessionDiff(sessionId), loading: false, error: "",
  };
  const request = useRef(0);
  useEffect(() => {
    request.current += 1;
    setState({ sessionId, result: peekSessionDiff(sessionId), loading: false, error: "" });
  }, [sessionId]);
  const refresh = useCallback(async (force = true) => {
    if (!active || !sessionId || document.visibilityState === "hidden") return;
    const token = ++request.current;
    setState((previous) => ({
      sessionId,
      result: previous.sessionId === sessionId ? previous.result : peekSessionDiff(sessionId),
      loading: true,
      error: "",
    }));
    try {
      const next = await fetchSessionDiff(sessionId, { force });
      if (request.current !== token) return;
      setState({ sessionId, result: next, loading: false, error: "" });
    } catch (reason) {
      if (request.current !== token) return;
      setState((previous) => ({
        ...previous, loading: false,
        error: reason instanceof Error ? reason.message : String(reason),
      }));
    }
  }, [active, sessionId]);
  useEffect(() => {
    if (!active || !sessionId) {
      setState((previous) => previous.loading ? { ...previous, loading: false } : previous);
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
  return {
    result: current.result,
    loading: current.loading || Boolean(sessionId && !current.result && !current.error),
    error: current.error,
    refresh,
  };
}
