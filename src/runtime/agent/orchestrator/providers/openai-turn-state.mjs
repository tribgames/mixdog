const MAX_TURN_STATE_SCOPES = 4096;
const _turnStateByScope = new Map();

function _clean(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function _ensureCapacity(scopeKey) {
    if (_turnStateByScope.has(scopeKey) || _turnStateByScope.size < MAX_TURN_STATE_SCOPES) return;
    const oldest = _turnStateByScope.keys().next().value;
    if (oldest !== undefined) _turnStateByScope.delete(oldest);
}

// A turn-state token belongs to one logical turn, not to the physical
// connection that happened to carry it. Activating a new turn clears the prior
// value even when the caller reuses the same WebSocket or HTTP session.
export function activateCodexTurnState(scopeKey, turnId, owner = null) {
    const scope = _clean(scopeKey);
    const turn = _clean(turnId);
    if (!scope || !turn) return null;
    const current = _turnStateByScope.get(scope);
    if (current?.turnId === turn) {
        // One physical WS connection owns the token while it is live. HTTP
        // fallback has no WS owner and may read the same turn-scoped value.
        if (owner && current.owner && current.owner !== owner) return null;
        if (owner && !current.owner) current.owner = owner;
        return current.value || null;
    }
    _ensureCapacity(scope);
    _turnStateByScope.set(scope, { turnId: turn, value: null, owner: owner || null });
    return null;
}

// The first server value wins for the whole logical turn.
export function captureCodexTurnState(scopeKey, turnId, value, owner = null) {
    const scope = _clean(scopeKey);
    const turn = _clean(turnId);
    const token = _clean(value);
    if (!scope || !turn || !token) return null;
    activateCodexTurnState(scope, turn, owner);
    const current = _turnStateByScope.get(scope);
    if (!current || current.turnId !== turn) return null;
    if (owner && current.owner && current.owner !== owner) return null;
    if (owner && !current.owner) current.owner = owner;
    if (current.value) return current.value;
    current.value = token;
    return token;
}

// A replacement connection may adopt the turn token only after the physical
// connection that owned it has actually closed.
export function retireCodexTurnStateOwner(scopeKey, owner) {
    const scope = _clean(scopeKey);
    if (!scope || !owner) return;
    const current = _turnStateByScope.get(scope);
    if (current?.owner === owner) current.owner = null;
}

export function clearCodexTurnStateScope(scopeKey) {
    const scope = _clean(scopeKey);
    if (scope) _turnStateByScope.delete(scope);
}

export function clearAllCodexTurnStates() {
    _turnStateByScope.clear();
}

export const _clearCodexTurnStatesForTest = clearAllCodexTurnStates;
