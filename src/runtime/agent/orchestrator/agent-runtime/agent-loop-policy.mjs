/**
 * Agent loop ceilings. Lead and delegated agents share one high runaway guard.
 */

import { envPositiveInt } from '../../../shared/env.mjs';

// Single runaway guard for ALL sessions. High by design; env-overridable only
// to raise/lower the safety ceiling, never used as a general task-length budget.
export const LEAD_MAX_LOOP_ITERATIONS = envPositiveInt('MIXDOG_AGENT_MAX_LOOP', 200);

/** Resolve the hard cap used by agentLoop for this session. */
export function resolveSessionMaxLoopIterations(sessionRef, explicit) {
    if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
    if (Number.isFinite(sessionRef?.maxLoopIterations) && sessionRef.maxLoopIterations > 0) {
        return Math.floor(sessionRef.maxLoopIterations);
    }
    return LEAD_MAX_LOOP_ITERATIONS;
}
