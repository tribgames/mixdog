// Hidden (sub-agent) role registry, extracted from loop.mjs.
// Source of truth: defaults/agents.json — read once and cached. HIDDEN_AGENT_NAMES
// is built eagerly so it stays in sync with the declarative registry (no
// hardcoded duplicate).
import { readFileSync as _readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath } from 'path';

const _AGENTS_JSON = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../../../defaults/agents.json');
let _hiddenAgentsCache = null;
function _getHiddenAgents() {
    if (_hiddenAgentsCache) return _hiddenAgentsCache;
    try {
        _hiddenAgentsCache = JSON.parse(_readFileSync(_AGENTS_JSON, 'utf8'));
    } catch { _hiddenAgentsCache = { agents: [] }; }
    return _hiddenAgentsCache;
}

export const HIDDEN_AGENT_NAMES = new Set(
    (_getHiddenAgents().agents || []).map((r) => r && r.agent).filter((n) => typeof n === 'string' && n.length > 0)
);
