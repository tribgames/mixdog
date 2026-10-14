import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionDiffResult } from './session-diff-model';
import { createGitRefreshScheduler, watchGitRefreshEvidence } from './git-refresh-scheduler';
import { fetchSessionDiff, peekSessionDiff } from './session-diff-cache';
import { useTurnChangesEpoch } from './turn-changes-model';
import { startVisibleRefreshCadence } from './visible-refresh-cadence';

// The Source Control dock's cadence: watch bursts debounce, runs keep a gap
// at least as long as the last read, and the safety lane is slow.
const IDLE_GIT_REFRESH_OPTIONS = {
  safetyIntervalMs: 30_000,
  activityDebounceMs: 125,
  activityMinGapMs: 3_000,
  slowTaskMultiplier: 5,
};

export function useSessionDiffRefresh({
  sessionId,
  active,
  revision,
  busy,
  gitWatchPath = '',
}: {
  sessionId: string;
  active: boolean;
  revision: string;
  busy: boolean;
  /** The session's folder: while idle, its Git changes re-read the diff. */
  gitWatchPath?: string;
}) {
  const [state, setState] = useState(() => ({
    sessionId,
    result: peekSessionDiff(sessionId) as SessionDiffResult | null,
    loading: false,
    error: '',
  }));
  // The first render (including a new session on the same host) is unknown,
  // not an empty diff. Effects must never be required to correct that claim.
  const current =
    state.sessionId === sessionId
      ? state
      : {
          sessionId,
          result: peekSessionDiff(sessionId),
          loading: false,
          error: '',
        };
  const request = useRef(0);
  // Counts adopted fresh results so a waiter can tell a refresh it did not
  // issue (cadence, revision) has landed.
  const [adoptions, setAdoptions] = useState(0);
  useEffect(() => {
    request.current += 1;
    setState({ sessionId, result: peekSessionDiff(sessionId), loading: false, error: '' });
  }, [sessionId]);
  const refresh = useCallback(
    // Resolves true only when this call's own result was adopted; a skipped
    // read, a failed read, or a superseded response resolves false.
    async (force = true): Promise<boolean> => {
      if (!active || !sessionId || document.visibilityState === 'hidden') return false;
      const token = ++request.current;
      setState((previous) => ({
        sessionId,
        result: previous.sessionId === sessionId ? previous.result : peekSessionDiff(sessionId),
        loading: true,
        error: '',
      }));
      try {
        const next = await fetchSessionDiff(sessionId, { force });
        if (request.current !== token) return false;
        setState({ sessionId, result: next, loading: false, error: '' });
        setAdoptions((count) => count + 1);
        return true;
      } catch (reason) {
        if (request.current !== token) return false;
        setState((previous) => ({
          ...previous,
          loading: false,
          error: reason instanceof Error ? reason.message : String(reason),
        }));
        return false;
      }
    },
    [active, sessionId]
  );
  // A change-history mutation (Undo/Reapply, Delete history) moves this diff too.
  const mutations = useTurnChangesEpoch(sessionId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and mutations are the triggers that force a fresh diff read
  useEffect(() => {
    if (!active || !sessionId) {
      setState((previous) => (previous.loading ? { ...previous, loading: false } : previous));
      return;
    }
    void refresh(true);
    // A pane that closed or changed session cannot adopt a late response.
    return () => {
      request.current += 1;
    };
  }, [active, revision, mutations, sessionId, refresh]);
  // Idle, a commit, stage or revert made outside a turn (a terminal, another
  // app) still moves the island's uncommitted set. Follow Source Control's
  // Git evidence: project file changes (the recursive watch sees .git),
  // window focus, Git actions and a slow safety lane; hidden pauses it.
  useEffect(() => {
    if (!active || !sessionId || busy || !gitWatchPath) return;
    return watchGitRefreshEvidence(
      gitWatchPath,
      createGitRefreshScheduler(async () => {
        await refresh(true);
      }, IDLE_GIT_REFRESH_OPTIONS)
    );
  }, [active, busy, gitWatchPath, refresh, sessionId]);
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
    adoptions,
  };
}
