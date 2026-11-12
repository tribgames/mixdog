// Idle-progress watchdogs for running agent sessions.
// One shared 1s timer sweeps every watched session, so a burst
// of agents costs a single interval; the timer stops as soon as the last
// watchdog is released. Abort policy itself lives in the runtime module.
import { randomUUID } from 'node:crypto';
import { emitSessionActivityChange } from '../../runtime/shared/session-activity-signal.mjs';
import { armTurnTimeout } from '../../runtime/agent/orchestrator/session/manager/turn-reap.mjs';
import {
  abortAgentProgressWatchdog,
  agentWatchdogPolicyActive,
  evaluateAgentWatchdogAbort,
  AgentStallAbortError,
} from '../../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';

const WATCHDOG_SWEEP_INTERVAL_MS = 1000;
const registrations = new WeakMap();

export function getProgressWatchdogState(mgr, sessionId) {
  const state = registrations.get(mgr)?.get(sessionId);
  return {
    registered: Boolean(state?.linked && !state.controller.signal.aborted),
    lastCheckedAt: state?.lastCheckedAt || null,
    error: state?.error || null,
    // The policy this session's watchdog actually enforces.
    policy: state?.watchdogPolicy || null,
  };
}

// This watchdog owns its timeout: arm the session's shell reap before the
// abort propagates, unless the turn is already stopped (the guard skips it).
function abortOnTimeout(controller, ctx) {
  if (!controller?.signal?.aborted && ctx?.error) armTurnTimeout(ctx.sessionId);
  abortAgentProgressWatchdog(controller, ctx);
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
    // Failed sweeps count from when the watchdog can actually stop the turn.
    state.anchorTs = Date.now();
    // Agent status shows whether the watchdog is armed.
    emitSessionActivityChange(state.sessionId);
    return true;
  }

  // Agent status shows the last check's error (getProgressWatchdogState).
  function setError(state, error) {
    if (state.error === error) return;
    state.error = error;
    emitSessionActivityChange(state.sessionId);
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
    setError(state, null);
    const snapshot =
      typeof mgr.getSessionProgressSnapshot === 'function' ? mgr.getSessionProgressSnapshot(sessionId) : null;
    const sess = typeof mgr.getSession === 'function' ? mgr.getSession(sessionId) : null;
    const iteration = typeof sess?.lastIterationIndex === 'number' ? sess.lastIterationIndex : null;
    // In-turn progress. The worker index is otherwise stamped only at turn
    // boundaries, so a turn that runs dozens of tool iterations would leave
    // the Agents panel frozen on its start stamp. This sweep already holds the
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
    // Progress is judged from the runtime's own snapshot only: a turn with
    // none in view gets no verdict (evaluateAgentWatchdogAbort returns null).
    const abortErr = evaluateAgentWatchdogAbort(snapshot, now, watchdogPolicy);
    if (!abortErr) return;
    let observation = null;
    try {
      observation =
        typeof mgr.getSessionProgressObservation === 'function' ? mgr.getSessionProgressObservation(sessionId) : null;
    } catch {
      observation = null;
    }
    abortOnTimeout(controller, {
      sessionId,
      agent,
      error: abortErr,
      snapshot,
      policy: watchdogPolicy,
      now,
      anchorTs,
      iteration,
      observation,
      registrationId: state.registrationId,
    });
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
          setError(state, String(error?.message || error));
          const compared = state.lastSuccessfulCheckAt
            ? { at: state.lastSuccessfulCheckAt, field: 'last_successful_check_at' }
            : { at: state.anchorTs, field: 'anchor_ts' };
          const elapsed = Date.now() - compared.at;
          if (state.watchdogPolicy.idleStaleMs > 0 && elapsed > state.watchdogPolicy.idleStaleMs) {
            abortOnTimeout(state.controller, {
              sessionId: state.sessionId,
              agent: state.agent,
              error: new AgentStallAbortError(`agent progress checks failed: ${state.error}`),
              policy: state.watchdogPolicy,
              anchorTs: state.anchorTs,
              comparedClock: compared,
              registrationId: state.registrationId,
            });
          }
        }
      }
    }, WATCHDOG_SWEEP_INTERVAL_MS);
    timer.unref?.();
  }

  return {
    /** Watch a session's ask until the returned handle is stopped; null when
     *  the policy is off or the manager has no progress snapshot or abort
     *  hook. A session whose runtime is not loaded yet is linked on a later
     *  sweep. */
    start(sessionId, watchdogPolicy, agent = null, { onProgress = null } = {}) {
      if (!sessionId || !agentWatchdogPolicyActive(watchdogPolicy)) return null;
      if (typeof mgr.getSessionProgressSnapshot !== 'function') return null;
      if (typeof mgr.linkParentSignalToSession !== 'function') return null;
      const state = {
        registrationId: randomUUID().slice(0, 8),
        sessionId,
        watchdogPolicy,
        agent,
        controller: new AbortController(),
        unlink: null,
        linked: false,
        anchorTs: Date.now(),
        onProgress: typeof onProgress === 'function' ? onProgress : null,
        lastProgressSignature: '',
      };
      // An abort ends the watchdog's armed state (getProgressWatchdogState).
      state.controller.signal.addEventListener('abort', () => emitSessionActivityChange(sessionId), { once: true });
      watched.set(sessionId, state);
      link(state);
      // The registration (its policy) replaces any earlier one for the session.
      emitSessionActivityChange(sessionId);
      ensureTimer();
      return {
        stop: () => {
          state.unlink?.();
          if (watched.get(sessionId) === state) {
            watched.delete(sessionId);
            emitSessionActivityChange(sessionId);
          }
          stopTimerIfIdle();
        },
      };
    },
  };
}
