/**
 * Agent loop ceiling — a single high runaway-guard shared by every session
 * (Lead and delegated sub-agents alike). There are intentionally NO low
 * per-agent caps: a worker/heavy-worker must be free to run as many tool +
 * synthesis turns as the task needs. This ceiling exists ONLY to stop a truly
 * runaway loop; it is not a task-length budget.
 */

function envPositiveInt(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Single runaway guard for ALL sessions. High by design; env-overridable only
// to raise/lower the safety ceiling, never used as a per-agent task budget.
export const LEAD_MAX_LOOP_ITERATIONS = envPositiveInt('MIXDOG_AGENT_MAX_LOOP', 200);

/**
 * Resolve the hard cap used by agentLoop for this session.
 *
 * Order: explicit override → session-pinned value → shared runaway guard.
 * No per-agent low caps are applied.
 */
export function resolveSessionMaxLoopIterations(sessionRef, explicit) {
    if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
    if (Number.isFinite(sessionRef?.maxLoopIterations) && sessionRef.maxLoopIterations > 0) {
        return Math.floor(sessionRef.maxLoopIterations);
    }
    return LEAD_MAX_LOOP_ITERATIONS;
}
