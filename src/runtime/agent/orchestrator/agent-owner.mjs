export const AGENT_OWNER = 'agent';

function ownerValue(value) {
    if (value && typeof value === 'object') return String(value.owner || '').trim().toLowerCase();
    return String(value || '').trim().toLowerCase();
}

export function isAgentOwner(value) {
    const owner = ownerValue(value);
    return owner === AGENT_OWNER;
}
