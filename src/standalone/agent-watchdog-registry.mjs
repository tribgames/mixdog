// Idle-progress watchdogs for running agent sessions.
// One shared 1s timer sweeps every watched session, so a burst
// of agents costs a single interval; the timer stops as soon as the last
// watchdog is released. Abort policy itself lives in the runtime module.
import {
  abortAgentProgressWatchdog,
  agentWatchdogPolicyActive,
  evaluateAgentWatchdogAbort,
  AgentStallAbortError,
} from '../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';

const WATCHDOG_SWEEP_INTERVAL_MS = 1000;
const registrations = new WeakMap();

export function getProgressWatchdogState(mgr, sessionId) {
  const state = registrations.get(mgr)?.get(sessionId);
  return {
    registered: Boolean(state?.linked && !state.controller.signal.aborted),
    lastCheckedAt: state?.lastCheckedAt || null,
    error: state?.error || null,
  };
}

export function createProgressWatchdogRegistry({ mgr }) {
  const watched = new Map();
  registrations.set(mgr, watched);
  let timer = null;

  function stopTimerIfIdle() {
    if (watched.size > 0 || !timer) return;
    clearInterval(timer);
    timer = null;
  }

  // Link the watchdog's abort to the session runtime. A rehydrated agent's
  // runtime loads only once its turn starts, so a failed link is retried on
  // every sweep instead of leaving that turn unwatched.
  function link(state) {
    try {
      const unlink = mgr.linkParentSignalToSession(state.sessionId, state.controller.signal);
      state.unlink = typeof unlink === 'function' ? unlink : null;
    } catch {
      return false;
    }
    state.linked = true;
    // Progress baselines count from when the watchdog can actually stop the turn.
    state.anchorTs = Date.now();
    return true;
  }

  function check(state) {
    const { sessionId, watchdogPolicy, agent, controller } = state;
    if (controller.signal?.aborted) {
      state.unlink?.();
      watched.delete(sessionId);
      stopTimerIfIdle();
      return;
    }
    if (!state.linked && !link(state)) return;
    const { anchorTs } = state;
    const now = Date.now();
    state.lastCheckedAt = now;
    state.error = null;
    const snapshot =
      typeof mgr.getSessionProgressSnapshot === 'function' ? mgr.getSessionProgressSnapshot(sessionId) : null;
    // Turn boundary: askStartedAt is re-stamped by markSessionAskStart for
    // EVERY turn of one askSession call, including the follow-up turns drained
    // from the pending-message queue. The sweep already reads this snapshot, so
    // observing the change is the cheapest per-turn signal available here.
    const askStartedAt = Number(snapshot?.askStartedAt || 0);
    if (askStartedAt > 0 && askStartedAt !== state.lastAskStartedAt) {
      state.lastAskStartedAt = askStartedAt;
      try {
        state.onTurnStart?.(askStartedAt);
      } catch {
        /* bookkeeping only */
      }
    }
    const sess = typeof mgr.getSession === 'function' ? mgr.getSession(sessionId) : null;
    const iteration = typeof sess?.lastIterationIndex === 'number' ? sess.lastIterationIndex : null;
    // In-turn progress. The worker index is otherwise stamped only at spawn and
    // at turn boundaries, so a FIRST turn that runs dozens of tool iterations
    // leaves the Agents panel frozen on its start stamp for minutes (user
    // report: 위임한 세션이 안 도는 것처럼 보인다). This sweep already holds the
    // live session, so reporting the change costs no extra read.
    if (state.onProgress) {
      const messages = Array.isArray(sess?.messages) ? sess.messages.length : Number(sess?.messageCount) || 0;
      const signature = `${iteration ?? ''}:${messages}:${snapshot?.lastProgressAt || 0}`;
      if (signature !== state.lastProgressSignature) {
        state.lastProgressSignature = signature;
        try {
          state.onProgress({ iteration, messages, stage: snapshot?.stage || null });
        } catch {
          /* bookkeeping only */
        }
      }
    }
    const abortErr = snapshot ? evaluateAgentWatchdogAbort(snapshot, now, watchdogPolicy) : null;
    // No progress snapshot: fall back to the coarse last-progress timestamp so a
    // session that never reports structured progress can still stall out.
    if (!abortErr && !snapshot) {
      // start() admits a manager that provides EITHER progress source, so this
      // fallback must not assume the coarse one exists: throwing here escaped
      // the shared interval and disabled watchdog coverage for every session.
      let reported = 0;
      if (typeof mgr.getSessionLastProgressAt === 'function') {
        try {
          reported = Number(mgr.getSessionLastProgressAt(sessionId)) || 0;
        } catch {
          reported = 0;
        }
      }
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
      // One session's failure must never cancel the sweep for the others.
      for (const state of [...watched.values()]) {
        try {
          check(state);
          state.lastSuccessfulCheckAt = Date.now();
        } catch (error) {
          state.error = String(error?.message || error);
          const elapsed = Date.now() - (state.lastSuccessfulCheckAt || state.anchorTs);
          if (state.watchdogPolicy.idleStaleMs > 0 && elapsed > state.watchdogPolicy.idleStaleMs) {
            abortAgentProgressWatchdog(state.controller, {
              sessionId: state.sessionId,
              agent: state.agent,
              error: new AgentStallAbortError(`agent progress checks failed: ${state.error}`),
              policy: state.watchdogPolicy,
              anchorTs: state.anchorTs,
            });
          }
        }
      }
    }, WATCHDOG_SWEEP_INTERVAL_MS);
    timer.unref?.();
  }

  return {
    /** Watch a session until the returned handle is stopped; null when the
     *  policy is off or the manager has no progress or abort hooks. A session
     *  whose runtime is not loaded yet is linked on a later sweep. */
    start(sessionId, watchdogPolicy, agent = null, { onTurnStart = null, onProgress = null } = {}) {
      if (!sessionId || !agentWatchdogPolicyActive(watchdogPolicy)) return null;
      if (typeof mgr.getSessionProgressSnapshot !== 'function' && typeof mgr.getSessionLastProgressAt !== 'function')
        return null;
      if (typeof mgr.linkParentSignalToSession !== 'function') return null;
      const state = {
        sessionId,
        watchdogPolicy,
        agent,
        controller: new AbortController(),
        unlink: null,
        linked: false,
        anchorTs: Date.now(),
        onTurnStart: typeof onTurnStart === 'function' ? onTurnStart : null,
        onProgress: typeof onProgress === 'function' ? onProgress : null,
        lastAskStartedAt: 0,
        lastProgressSignature: '',
      };
      link(state);
      watched.set(sessionId, state);
      ensureTimer();
      return {
        stop: () => {
          state.unlink?.();
          if (watched.get(sessionId) === state) watched.delete(sessionId);
          stopTimerIfIdle();
        },
      };
    },
  };
}
