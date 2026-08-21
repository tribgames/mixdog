import { gitCommandMutates } from '../../tools/builtin/git-command-policy.mjs';
import { isAbsolute, normalize, resolve } from 'node:path';

// Tool-name classification + intra-turn signature helpers, extracted from
// loop.mjs. These drive cross-turn read dedup, scoped caching, shell routing,
// and duplicate-call detection. Strips the MCP prefix so direct calls and
// MCP-wrapped calls share the same cache.
const MCP_TOOL_PREFIX = 'mcp__plugin_mixdog_mixdog__';

export function _stripMcpPrefix(name) {
    return typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX)
        ? name.slice(MCP_TOOL_PREFIX.length) : name;
}
export function _isReadTool(name) {
    return _stripMcpPrefix(name) === 'read';
}
export function _isMutationTool(name, args = null) {
    const n = String(_stripMcpPrefix(name) || '').toLowerCase();
    return n === 'apply_patch' || n === 'edit' || n === 'git_stage' || (n === 'git' && gitCommandMutates(args));
}
export function _isGitMutationTool(name, args = null) {
    const n = String(_stripMcpPrefix(name) || '').toLowerCase();
    return n === 'git_stage' || (n === 'git' && gitCommandMutates(args));
}
export function _isEditTool(name) {
    return String(_stripMcpPrefix(name) || '').toLowerCase() === 'edit';
}
const SCOPED_CACHEABLE_TOOLS = new Set([
    'code_graph',
    'grep',
    'list',
    'glob',
]);
export function _isScopedCacheableTool(name) {
    const n = _stripMcpPrefix(name);
    return SCOPED_CACHEABLE_TOOLS.has(n);
}
export function _isShellTool(name) {
    const n = _stripMcpPrefix(name);
    return n === 'shell' || n === 'bash_session';
}

// Canonical signature for intra-turn duplicate detection. Sorting keys
// produces a stable hash regardless of arg-object key order. Anything
// non-serializable falls back to String(args) — still deterministic for
// the model's typical structured-arg shape.
export function _canonicalArgs(args) {
    if (args == null || typeof args !== 'object') {
        try { return JSON.stringify(args); } catch { return String(args); }
    }
    try {
        const keys = Object.keys(args).sort();
        const sorted = {};
        for (const k of keys) sorted[k] = args[k];
        return JSON.stringify(sorted);
    } catch { return String(args); }
}

function _argShape(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `array[${value.map(_argShape).join(',')}]`;
    if (typeof value !== 'object') return typeof value;
    return `{${Object.keys(value).sort().map((key) => `${key}:${_argShape(value[key])}`).join(',')}}`;
}

export function _argShapeSig(name, args) {
    return `${name}:${_argShape(args)}`;
}

export function _isToolArgShapeFailure(resultText) {
    const first = String(resultText ?? '').split(/\r?\n/).find((line) => line.trim()) || '';
    return /\b(?:arg(?:ument)?s?|builtin arg)\b.*\b(?:invalid|must|required|requires|expected)\b/i.test(first)
        || /\b(?:requires|required)\b.*\b(?:arg(?:ument)?|pattern|path|query|command|task_id)\b/i.test(first)
        || /\binvalid json\b/i.test(first);
}

const FAILURE_PATH_KEYS = new Set([
    'base_path', 'cwd', 'dir', 'dir_path', 'directory',
    'file_path', 'files', 'path', 'paths',
]);

function _normalizeFailurePath(value, cwd) {
    if (typeof value !== 'string' || value.length === 0 || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
        return value;
    }
    const base = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
    let out = isAbsolute(value) ? normalize(value) : resolve(base, value);
    if (process.platform === 'win32') out = out.toLowerCase();
    return out.replace(/\\/g, '/');
}

function _canonicalFailureValue(value, key, cwd) {
    if (typeof value === 'string') {
        return FAILURE_PATH_KEYS.has(String(key || '').toLowerCase())
            ? _normalizeFailurePath(value, cwd)
            : value;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => _canonicalFailureValue(entry, key, cwd));
    }
    if (value && typeof value === 'object') {
        const sorted = {};
        for (const childKey of Object.keys(value).sort()) {
            sorted[childKey] = _canonicalFailureValue(value[childKey], childKey, cwd);
        }
        return sorted;
    }
    return value;
}

export function _repeatFailureSig(name, args, cwd) {
    try {
        return `${_stripMcpPrefix(name)}:${JSON.stringify(_canonicalFailureValue(args, '', cwd))}`;
    } catch {
        return _intraTurnSig(_stripMcpPrefix(name), args);
    }
}

// History contains executed failures only. Return the cycle length when the
// proposed signature would continue a 1..5-call pattern that has already
// repeated repeatLimit times; otherwise return 0.
export function _repeatFailurePatternWouldContinue(history, signature, repeatLimit = 3) {
    if (!Array.isArray(history) || typeof signature !== 'string' || repeatLimit < 1) return 0;
    const n = history.length;
    for (let cycleLength = 1; cycleLength <= 5; cycleLength++) {
        const required = cycleLength * repeatLimit;
        if (n < required) continue;
        const start = n - required;
        const cycle = history.slice(start, start + cycleLength);
        let matches = true;
        for (let i = 0; i < required; i++) {
            if (history[start + i] !== cycle[i % cycleLength]) {
                matches = false;
                break;
            }
        }
        if (matches && signature === cycle[0]) return cycleLength;
    }
    return 0;
}

export function _intraTurnSig(name, args) {
    return `${name}:${_canonicalArgs(args)}`;
}
