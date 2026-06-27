export const AGENT_OWNER = 'agent';
export const LEGACY_AGENT_OWNER = 'bridge';

function ownerValue(value) {
    if (value && typeof value === 'object') return String(value.owner || '').trim().toLowerCase();
    return String(value || '').trim().toLowerCase();
}

export function isAgentOwner(value) {
    const owner = ownerValue(value);
    return owner === AGENT_OWNER || owner === LEGACY_AGENT_OWNER;
}
