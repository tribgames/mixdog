import { gitCommandMutates } from '../../tools/builtin/git-command-policy.mjs';

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
    return n === 'apply_patch' || n === 'edit' || (n === 'git' && gitCommandMutates(args));
}
export function _isGitMutationTool(name, args = null) {
    const n = String(_stripMcpPrefix(name) || '').toLowerCase();
    return n === 'git' && gitCommandMutates(args);
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

export function _intraTurnSig(name, args) {
    return `${name}:${_canonicalArgs(args)}`;
}
