// Idle-progress watchdogs for running agent sessions, extracted from
// agent-tool.mjs. One shared 1s timer sweeps every watched session, so a burst
// of agents costs a single interval; the timer stops as soon as the last
// watchdog is released. Abort policy itself lives in the runtime module.
import {
  abortAgentProgressWatchdog,
  agentWatchdogPolicyActive,
  evaluateAgentWatchdogAbort,
  AgentStallAbortError,
} from '../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';

const WATCHDOG_SWEEP_INTERVAL_MS = 1000;

export function createProgressWatchdogRegistry({ mgr }) {
  const watched = new Map();
  let timer = null;

  function stopTimerIfIdle() {
    if (watched.size > 0 || !timer) return;
    try { clearInterval(timer); } catch {}
    timer = null;
  }

  function check(state) {
    const { sessionId, watchdogPolicy, agent, controller, anchorTs } = state;
    if (controller.signal?.aborted) {
      watched.delete(sessionId);
      stopTimerIfIdle();
      return;
    }
    const now = Date.now();
    const snapshot = typeof mgr.getSessionProgressSnapshot === 'function'
      ? mgr.getSessionProgressSnapshot(sessionId)
      : null;
    // Turn boundary: askStartedAt is re-stamped by markSessionAskStart for
    // EVERY turn of one askSession call, including the follow-up turns drained
    // from the pending-message queue. The sweep already reads this snapshot, so
    // observing the change is the cheapest per-turn signal available here.
    const askStartedAt = Number(snapshot?.askStartedAt || 0);
    if (askStartedAt > 0 && askStartedAt !== state.lastAskStartedAt) {
      state.lastAskStartedAt = askStartedAt;
      try { state.onTurnStart?.(askStartedAt); } catch { /* bookkeeping only */ }
    }
    const abortErr = snapshot ? evaluateAgentWatchdogAbort(snapshot, now, watchdogPolicy) : null;
    const sess = typeof mgr.getSession === 'function' ? mgr.getSession(sessionId) : null;
    const iteration = typeof sess?.lastIterationIndex === 'number' ? sess.lastIterationIndex : null;
    // No progress snapshot: fall back to the coarse last-progress timestamp so a
    // session that never reports structured progress can still stall out.
    if (!abortErr && !snapshot) {
      const reported = mgr.getSessionLastProgressAt(sessionId);
      const last = reported || anchorTs;
      if (watchdogPolicy.idleStaleMs > 0 && now - last > watchdogPolicy.idleStaleMs) {
        abortAgentProgressWatchdog(controller, {
          sessionId,
          agent,
          error: new AgentStallAbortError(`agent task stale (${watchdogPolicy.idleStaleMs}ms without progress)`),
          policy: watchdogPolicy,
          now,
          anchorTs,
          lastProgressAt: reported,
          iteration,
        });
      }
      return;
    }
    if (abortErr) {
      abortAgentProgressWatchdog(controller, {
        sessionId,
        agent,
        error: abortErr,
        snapshot,
        policy: watchdogPolicy,
        now,
        anchorTs,
        iteration,
      });
    }
  }

  function ensureTimer() {
    if (timer || watched.size === 0) return;
    timer = setInterval(() => {
      for (const state of [...watched.values()]) check(state);
    }, WATCHDOG_SWEEP_INTERVAL_MS);
    timer.unref?.();
  }

  return {
    /** Watch a session until the returned handle is stopped; null when the
     *  policy is off or the manager cannot link an abort signal. */
    start(sessionId, watchdogPolicy, agent = null, { onTurnStart = null } = {}) {
      if (!sessionId || !agentWatchdogPolicyActive(watchdogPolicy)) return null;
      if (typeof mgr.getSessionProgressSnapshot !== 'function'
        && typeof mgr.getSessionLastProgressAt !== 'function') return null;
      if (typeof mgr.linkParentSignalToSession !== 'function') return null;
      const controller = new AbortController();
      const anchorTs = Date.now();
      try { mgr.linkParentSignalToSession(sessionId, controller.signal); } catch { return null; }
      const state = {
        sessionId,
        watchdogPolicy,
        agent,
        controller,
        anchorTs,
        onTurnStart: typeof onTurnStart === 'function' ? onTurnStart : null,
        lastAskStartedAt: 0,
      };
      watched.set(sessionId, state);
      ensureTimer();
      return {
        stop: () => {
          if (watched.get(sessionId) === state) watched.delete(sessionId);
          stopTimerIfIdle();
        },
      };
    },
  };
}
