import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionDiffResult } from './session-diff-model';
import {
  answerSessionDiffSignal,
  answeredSessionDiffSignal,
  fetchSessionDiff,
  peekSessionDiff,
  sameSessionDiff as sameDiff,
} from './session-diff-cache';
import { useTurnChangesEpoch } from './turn-changes-model';

const SIGNAL_DEBOUNCE_MS = 150;
/** The signal a read now running will answer (others join it, not repeat it);
 *  removed when that read settles. The signal a session's last SUCCESSFUL read
 *  answered lives in the session-diff cache (bounded with it): a signal stays
 *  dirty until a read that started after it has landed, so a failed read is
 *  retried on the next focus / visibility / request. */
const readingSignal = new Map<string, string>();

export function useSessionDiffRefresh({
  sessionId,
  active,
  revision,
}: {
  sessionId: string;
  active: boolean;
  revision: string;
  busy?: boolean;
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
  // A history mutation (Undo/Reapply, Delete history) moves this diff too.
  const mutations = useTurnChangesEpoch(sessionId);
  // The change signal (revision, history mutation) as of the latest render.
  const signalKey = `${revision}|${mutations}`;
  // This caller's own newest signal per session it still has a read for: an
  // inactive or stale sibling never replaces another caller's ownership, and
  // a read for a session switched away from still answers its own signal.
  const signals = useRef(new Map<string, string>());
  const reads = useRef(new Map<string, number>());
  const shownSession = useRef(sessionId);
  shownSession.current = sessionId;
  if (sessionId) signals.current.set(sessionId, signalKey);
  for (const held of [...signals.current.keys()]) {
    if (held !== sessionId && !reads.current.has(held)) signals.current.delete(held);
  }
  useEffect(() => {
    request.current += 1;
    apply({ sessionId, result: peekSessionDiff(sessionId), loading: false, error: '' });
  }, [apply, sessionId]);
  const refresh = useCallback(
    // Resolves true only when this call's own result was adopted; a skipped
    // read, a failed read, or a superseded response resolves false. A
    // `background` read (focus, Git evidence) neither flips `loading` nor
    // re-renders when its result equals the one shown. Only an explicit
    // `force` (the user's Refresh) recomputes regardless of signals; without
    // it a read happens only when the change signal is not yet answered, and
    // joins a read already answering it.
    async (force = false, background = false): Promise<boolean> => {
      if (!active || !sessionId || document.visibilityState === 'hidden') {
        missedAdoption.current = true;
        return false;
      }
      const signal = signals.current.get(sessionId) as string;
      const answered = answeredSessionDiffSignal(sessionId) === signal;
      const joining = readingSignal.get(sessionId) === signal;
      const recompute = force || (!answered && !joining);
      const answers = answered ? undefined : signal;
      if (answers && recompute) readingSignal.set(sessionId, answers);
      const token = ++request.current;
      reads.current.set(sessionId, (reads.current.get(sessionId) ?? 0) + 1);
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
        const next = await fetchSessionDiff(sessionId, { force: recompute });
        // The read landed: it started after `signal`, so the signal is
        // answered (unless a newer one has arrived meanwhile).
        if (answers && signals.current.get(sessionId) === answers) answerSessionDiffSignal(sessionId, answers);
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
        if (answers && readingSignal.get(sessionId) === answers) readingSignal.delete(sessionId);
        const left = (reads.current.get(sessionId) ?? 1) - 1;
        if (left > 0) reads.current.set(sessionId, left);
        else {
          reads.current.delete(sessionId);
          if (sessionId !== shownSession.current) signals.current.delete(sessionId);
        }
      }
    },
    [active, apply, sessionId]
  );
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!active || !sessionId) {
      if (asked.current.loading) apply({ ...asked.current, loading: false });
      return;
    }
    const stale = answeredSessionDiffSignal(sessionId) !== signalKey;
    // Debounce a signal over a shown result; a first load starts at once.
    const delay = stale && peekSessionDiff(sessionId) ? SIGNAL_DEBOUNCE_MS : 0;
    let timer: number | undefined;
    if (delay === 0) void refreshRef.current(false);
    else timer = window.setTimeout(() => void refreshRef.current(false), delay);
    // A pane that closed or changed session cannot adopt a late response.
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      request.current += 1;
    };
  }, [active, apply, sessionId, signalKey]);
  // Window focus / visibility only re-adopt the cached result (and catch up a
  // signal that arrived while hidden or whose read failed); there is no polling.
  useEffect(() => {
    if (!active || !sessionId) return;
    const adopt = () => {
      if (document.visibilityState !== 'hidden') void refreshRef.current(false, true);
    };
    document.addEventListener('visibilitychange', adopt);
    window.addEventListener('focus', adopt);
    window.addEventListener('pageshow', adopt);
    return () => {
      document.removeEventListener('visibilitychange', adopt);
      window.removeEventListener('focus', adopt);
      window.removeEventListener('pageshow', adopt);
    };
  }, [active, sessionId]);
  return {
    result: current.result,
    loading: current.loading || Boolean(sessionId && !current.result && !current.error),
    error: current.error,
    refresh,
    adoptions,
  };
}
