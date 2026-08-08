/**
 * Agent loop ceilings. Lead and general delegated agents share one high
 * runaway guard. Explorer is the sole bounded exception: locator work gets at
 * at most five tool-capable turns, followed by the loop's tool-less report turn.
 */

function envPositiveInt(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Single runaway guard for ALL sessions. High by design; env-overridable only
// to raise/lower the safety ceiling, never used as a general task-length budget.
export const LEAD_MAX_LOOP_ITERATIONS = envPositiveInt('MIXDOG_AGENT_MAX_LOOP', 200);

// Explorer's first turn is the whole maximum-fanout search; turns 2-5 are
// bounded miss recovery. The override may shorten this but never add a sixth.
export const EXPLORE_MAX_LOOP_ITERATIONS = Math.min(
    5,
    envPositiveInt('MIXDOG_EXPLORE_MAX_LOOP', 5),
);

/**
 * Resolve the hard cap used by agentLoop for this session.
 *
 * Explorer: the lowest positive explicit/session value, clamped to its
 * dedicated five-turn ceiling. Others: explicit → session-pinned → shared guard.
 */
export function resolveSessionMaxLoopIterations(sessionRef, explicit) {
    const sessionAgent = String(sessionRef?.agent || '').trim().toLowerCase();
    if (sessionAgent === 'explorer' || sessionAgent === 'explore') {
        const requested = Number.isFinite(explicit) && explicit > 0
            ? Math.floor(explicit)
            : Number.isFinite(sessionRef?.maxLoopIterations) && sessionRef.maxLoopIterations > 0
                ? Math.floor(sessionRef.maxLoopIterations)
                : EXPLORE_MAX_LOOP_ITERATIONS;
        return Math.min(EXPLORE_MAX_LOOP_ITERATIONS, requested);
    }
    if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
    if (Number.isFinite(sessionRef?.maxLoopIterations) && sessionRef.maxLoopIterations > 0) {
        return Math.floor(sessionRef.maxLoopIterations);
    }
    return LEAD_MAX_LOOP_ITERATIONS;
}
