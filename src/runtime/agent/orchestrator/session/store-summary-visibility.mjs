export const SESSION_VISIBILITY_ORDINARY = 'ordinary';
export const SESSION_VISIBILITY_AGENT_ONLY = 'agent-only';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function clean(value) {
    return String(value || '').trim();
}

export function linkedParentSessionId(value) {
    if (!value || typeof value !== 'object') return '';
    for (const candidate of [value.ownerSessionId, value.parentSessionId]) {
        const id = clean(candidate);
        if (SESSION_ID_PATTERN.test(id)) return id;
    }
    return '';
}

/** A root Lead may carry a self owner link, but it is not a child session. */
export function isRootLeadSession(value) {
    if (!value || typeof value !== 'object') return false;
    if (clean(value.agent).toLowerCase() !== 'lead') return false;
    const id = clean(value.id);
    const parentId = linkedParentSessionId(value);
    return !parentId || parentId === id;
}

/** Backward-compatible classification for child records written before the
 * durable visibility field existed. Both Agent ownership and an external,
 * valid parent link are required so ownerless/root sessions remain ordinary. */
export function isCanonicalAgentChildSession(value) {
    if (!value || typeof value !== 'object') return false;
    const id = clean(value.id);
    const parentId = linkedParentSessionId(value);
    return clean(value.owner).toLowerCase() === 'agent'
        && Boolean(parentId)
        && parentId !== id;
}

export function sessionVisibility(value) {
    // Root Lead sessions are ordinary catalog entries even if stale metadata
    // accidentally retained an agent-only declaration.
    if (isRootLeadSession(value)) return SESSION_VISIBILITY_ORDINARY;
    const declared = clean(value?.visibility || value?.sessionVisibility).toLowerCase();
    if (declared === SESSION_VISIBILITY_AGENT_ONLY || isCanonicalAgentChildSession(value)) {
        return SESSION_VISIBILITY_AGENT_ONLY;
    }
    return SESSION_VISIBILITY_ORDINARY;
}

export function isAgentOnlySession(value) {
    return sessionVisibility(value) === SESSION_VISIBILITY_AGENT_ONLY;
}

export function isOrdinarySession(value) {
    return !isAgentOnlySession(value);
}
