// Tool-name classification + intra-turn signature helpers, extracted from
// loop.mjs. These drive cross-turn read dedup, scoped caching, shell routing,
// and duplicate-call detection. Strips the MCP prefix so direct calls and
// MCP-wrapped calls share the same cache.
import { createHash } from 'crypto';

export const MCP_TOOL_PREFIX = 'mcp__plugin_mixdog_mixdog__';

export function _stripMcpPrefix(name) {
    return typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX)
        ? name.slice(MCP_TOOL_PREFIX.length) : name;
}
export function _isReadTool(name) {
    return _stripMcpPrefix(name) === 'read';
}
export function _isMutationTool(name) {
    const n = _stripMcpPrefix(name);
    return n === 'apply_patch';
}
export const SCOPED_CACHEABLE_TOOLS = new Set([
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
export function _intraTurnSig(name, args) {
    return createHash('sha256').update(`${name}:${_canonicalArgs(args)}`).digest('hex').slice(0, 16);
}
