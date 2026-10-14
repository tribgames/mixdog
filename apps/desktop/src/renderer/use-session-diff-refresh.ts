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

/** Same diff content, compared without re-serialising the (large) patch. */
function sameDiff(left: SessionDiffResult | null, right: SessionDiffResult | null): boolean {
  if (left === right) return true;
  if (!left || !right || left.patch !== right.patch) return false;
  return JSON.stringify({ ...left, patch: undefined }) === JSON.stringify({ ...right, patch: undefined });
}

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
  // The latest state asked for, so an unchanged result can skip setState
  // (a functional no-op update still costs a render pass).
  const asked = useRef(state);
  const apply = useCallback((next: typeof state) => {
    asked.current = next;
    setState(next);
  }, []);
  const request = useRef(0);
  // Counts adopted fresh results so a waiter can tell a refresh it did not
  // issue (cadence, revision) has landed.
  const [adoptions, setAdoptions] = useState(0);
  // A read that did not land (skipped, superseded, failed) may have a waiter
  // counting on the next adopted result, so that one is always announced even
  // when it equals what is shown.
  const missedAdoption = useRef(false);
  const lastAdopted = useRef<{ sessionId: string; result: SessionDiffResult | null } | null>(null);
  const inflight = useRef(0);
  useEffect(() => {
    request.current += 1;
    apply({ sessionId, result: peekSessionDiff(sessionId), loading: false, error: '' });
  }, [apply, sessionId]);
  const refresh = useCallback(
    // Resolves true only when this call's own result was adopted; a skipped
    // read, a failed read, or a superseded response resolves false. A
    // `background` read (cadence, Git evidence) neither flips `loading` nor
    // re-renders when its result equals the one shown.
    async (force = true, background = false): Promise<boolean> => {
      if (!active || !sessionId || document.visibilityState === 'hidden') {
        missedAdoption.current = true;
        return false;
      }
      const token = ++request.current;
      if (inflight.current > 0) missedAdoption.current = true;
      inflight.current += 1;
      if (!background) {
        const previous = asked.current;
        apply({
          sessionId,
          result: previous.sessionId === sessionId ? previous.result : peekSessionDiff(sessionId),
          loading: true,
          error: '',
        });
      }
      try {
        const next = await fetchSessionDiff(sessionId, { force });
        if (request.current !== token) {
          missedAdoption.current = true;
          return false;
        }
        const last = lastAdopted.current;
        const changed = !(last?.sessionId === sessionId && sameDiff(last.result, next));
        lastAdopted.current = { sessionId, result: next };
        const shown = asked.current;
        if (!(shown.sessionId === sessionId && !shown.loading && !shown.error && sameDiff(shown.result, next))) {
          apply({ sessionId, result: next, loading: false, error: '' });
        }
        if (!background || changed || missedAdoption.current) {
          missedAdoption.current = false;
          setAdoptions((count) => count + 1);
        }
        return true;
      } catch (reason) {
        missedAdoption.current = true;
        if (request.current !== token) return false;
        apply({
          ...asked.current,
          loading: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
        return false;
      } finally {
        inflight.current -= 1;
      }
    },
    [active, apply, sessionId]
  );
  // A change-history mutation (Undo/Reapply, Delete history) moves this diff too.
  const mutations = useTurnChangesEpoch(sessionId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and mutations are the triggers that force a fresh diff read
  useEffect(() => {
    if (!active || !sessionId) {
      if (asked.current.loading) apply({ ...asked.current, loading: false });
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
        await refresh(true, true);
      }, IDLE_GIT_REFRESH_OPTIONS)
    );
  }, [active, busy, gitWatchPath, refresh, sessionId]);
  useEffect(() => {
    if (!active || !sessionId) return;
    return startVisibleRefreshCadence({
      win: window,
      intervalMs: busy ? 4_000 : undefined,
      refresh: () => void refresh(true, true),
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
