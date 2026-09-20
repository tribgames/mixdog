// Progress watchdog for one dispatch: a 1s poll that aborts the agent's own
// controller when the session stops making progress under the resolved
// policy. Inactive policies produce no controller and no timer.
import { getSession, getSessionLastProgressAt, getSessionProgressSnapshot } from '../../session/manager.mjs';
import {
  abortAgentProgressWatchdog,
  agentWatchdogPolicyActive,
  evaluateAgentWatchdogAbort,
  AgentStallAbortError,
} from '../agent-progress-watchdog.mjs';

function abortDispatchWatchdog({
  controller,
  sessionId,
  agent,
  error,
  snapshot,
  policy,
  now,
  anchorTs,
  lastProgressAt,
}) {
  const sess = getSession(sessionId);
  abortAgentProgressWatchdog(controller, {
    sessionId,
    agent,
    error,
    snapshot,
    policy,
    now,
    anchorTs,
    lastProgressAt,
    iteration: typeof sess?.lastIterationIndex === 'number' ? sess.lastIterationIndex : null,
  });
}

export function startDispatchWatchdog({ agent, sessionId, policy }) {
  if (!agentWatchdogPolicyActive(policy)) return { signal: null, stop: () => {} };
  const controller = new AbortController();
  // Watchdog blind spot guard: when the runtime snapshot is missing AND
  // no progress timestamp exists (pre-liveness hang, swept runtime), the
  // dispatch start time anchors staleness so the abort still fires.
  const anchorTs = Date.now();
  const timer = setInterval(() => {
    if (controller.signal?.aborted) return;
    const now = Date.now();
    const snapshot = getSessionProgressSnapshot(sessionId);
    if (snapshot) {
      const abortErr = evaluateAgentWatchdogAbort(snapshot, now, policy);
      if (abortErr) {
        abortDispatchWatchdog({ controller, sessionId, agent, error: abortErr, snapshot, policy, now, anchorTs });
      }
      return;
    }
    const reported = getSessionLastProgressAt(sessionId);
    const last = reported || anchorTs;
    if (policy.idleStaleMs <= 0 || now - last <= policy.idleStaleMs) return;
    abortDispatchWatchdog({
      controller,
      sessionId,
      agent,
      error: new AgentStallAbortError(`agent task stale (${policy.idleStaleMs}ms without progress)`),
      policy,
      now,
      anchorTs,
      lastProgressAt: reported,
    });
  }, 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    signal: controller.signal,
    stop: () => {
      try {
        clearInterval(timer);
      } catch {
        /* ignore */
      }
    },
  };
}
