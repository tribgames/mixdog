// Progress watchdog for one dispatch: a 1s poll that aborts the agent's own
// controller when the session stops making progress under the resolved
// policy. Inactive policies produce no controller and no timer. Progress is
// judged from the session's runtime snapshot only. The dispatch links its
// abort before the ask (agent-dispatch.mjs), which creates that runtime with
// no progress clock, so nothing is judged until the ask stamps one
// (markSessionAskStart); a session whose runtime is gone gets no verdict.
import { getSession, getSessionProgressSnapshot } from '../../session/manager.mjs';
import {
  abortAgentProgressWatchdog,
  agentWatchdogPolicyActive,
  evaluateAgentWatchdogAbort,
} from '../agent-progress-watchdog.mjs';

export function startDispatchWatchdog({ agent, sessionId, policy }) {
  if (!agentWatchdogPolicyActive(policy)) return { signal: null, stop: () => {} };
  const controller = new AbortController();
  const anchorTs = Date.now();
  const timer = setInterval(() => {
    if (controller.signal?.aborted) return;
    const now = Date.now();
    const snapshot = getSessionProgressSnapshot(sessionId);
    const error = evaluateAgentWatchdogAbort(snapshot, now, policy);
    if (!error) return;
    const sess = getSession(sessionId);
    abortAgentProgressWatchdog(controller, {
      sessionId,
      agent,
      error,
      snapshot,
      policy,
      now,
      anchorTs,
      iteration: typeof sess?.lastIterationIndex === 'number' ? sess.lastIterationIndex : null,
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
