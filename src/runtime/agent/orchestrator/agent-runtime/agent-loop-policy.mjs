/**
 * Public workflow agent loop caps — prevents unbounded tool/reasoning turns on
 * delegated sub-sessions while leaving Lead (owner=user) on the high ceiling.
 */

import { getHiddenRole } from '../internal-roles.mjs';
import { isAgentOwner } from '../agent-owner.mjs';

export const LEAD_MAX_LOOP_ITERATIONS = 200;

function envPositiveInt(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const ROLE_LOOP_CAPS = Object.freeze({
    'heavy-worker': () => envPositiveInt('MIXDOG_AGENT_HEAVY_WORKER_MAX_LOOP', 12),
    worker: () => envPositiveInt('MIXDOG_AGENT_WORKER_MAX_LOOP', 16),
    explore: () => envPositiveInt('MIXDOG_AGENT_EXPLORE_MAX_LOOP', 10),
    reviewer: () => envPositiveInt('MIXDOG_AGENT_REVIEWER_MAX_LOOP', 10),
    debugger: () => envPositiveInt('MIXDOG_AGENT_DEBUGGER_MAX_LOOP', 12),
    maintainer: () => envPositiveInt('MIXDOG_AGENT_MAINTAINER_MAX_LOOP', 8),
});

/**
 * Default iteration cap for a public workflow agent (agent-tool spawn / Lead delegate).
 * Hidden internal roles return null so the loop keeps the legacy 200 ceiling unless
 * the caller passes an explicit maxLoopIterations.
 */
export function resolvePublicAgentMaxLoopIterations(role, permission) {
    const id = String(role || '').trim().toLowerCase();
    if (!id || getHiddenRole(id)) return null;
    const byRole = ROLE_LOOP_CAPS[id];
    if (byRole) return byRole();
    if (permission === 'read') {
        return envPositiveInt('MIXDOG_AGENT_READONLY_MAX_LOOP', 10);
    }
    return envPositiveInt('MIXDOG_AGENT_PUBLIC_MAX_LOOP', 14);
}

/**
 * Resolve the hard cap used by agentLoop for this session.
 */
export function resolveSessionMaxLoopIterations(sessionRef, explicit) {
    if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
    if (Number.isFinite(sessionRef?.maxLoopIterations) && sessionRef.maxLoopIterations > 0) {
        return Math.floor(sessionRef.maxLoopIterations);
    }
    if (sessionRef && isAgentOwner(sessionRef) && sessionRef.role) {
        const cap = resolvePublicAgentMaxLoopIterations(sessionRef.role, sessionRef.permission);
        if (Number.isFinite(cap) && cap > 0) return cap;
    }
    return LEAD_MAX_LOOP_ITERATIONS;
}
