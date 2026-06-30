/**
 * Internal tool registry — in-process tools exposed to external LLMs via the agent runtime.
 *
 * Populated by agent/index.mjs.handleToolCall when the server injects a
 * context carrying { toolExecutor, internalTools }. The executor dispatches
 * to Mixdog's existing module router (worker IPC for memory/channels,
 * in-process loadModule for search). No MCP loopback, no HTTP hop.
 *
 * Orchestrator modules (session/manager.mjs, session/loop.mjs) import from
 * here instead of going through mcp/client.mjs for internal tools.
 *
 * Permission enforcement has been removed (every tool call is trusted). The
 * only remaining dispatch-time gate is the architectural scoping in
 * _preDispatchDeny() in session/loop.mjs (agent-worker control-plane reject +
 * no-tool role guard) — not a permission check. No gating is needed here.
 */

import { isToolEnvelope, makeToolEnvelope } from './session/tool-envelope.mjs';

let _executor = null;
let _tools = [];
let _names = new Set();

let _bootReady = false;
let _bootResolver = null;
const _bootPromise = new Promise((r) => { _bootResolver = r; });
export function markBootReady() { if (_bootReady) return; _bootReady = true; _bootResolver(); }

export function setInternalToolsProvider({ executor, tools }) {
    if (typeof executor !== 'function') throw new Error('internal-tools: executor must be a function');
    _executor = executor;
    const base = Array.isArray(tools) ? [...tools] : [];
    _tools = base;
    _names = new Set(_tools.map(t => t?.name).filter(Boolean));
}

export function getInternalTools() {
    return _tools;
}

export function isInternalTool(name) {
    return _names.has(name);
}

export async function executeInternalTool(name, args, callerCtx = {}) {
    if (!_names.has(name)) throw new Error(`internal-tools: "${name}" is not registered`);
    if (!_executor) throw new Error(`internal-tools: executor not initialized (tool=${name})`);
    const result = await _executor(name, args ?? {}, callerCtx);
    return _normalize(result);
}

// Mirror executeMcpTool's shape normalization so the session loop sees a
// plain string either way. Worker/module handlers return the MCP-shaped
// `{ content: [{type:'text', text}] }` envelope directly.
function _normalize(result) {
    // General newMessages tool-result channel: a tool may return a
    // `{ __toolEnvelope, result, newMessages }` envelope (e.g. Skill, whose
    // body rides ONE injected user message). Preserve the envelope shape, only
    // normalizing its inner `result` to a string, so the agent loop's central
    // normalizeToolEnvelope still splits it into stub + injected user body.
    // Without this guard the envelope object would fall through to
    // JSON.stringify below and the loop would see the stringified envelope as
    // the tool_result (body inlined + duplicated, no newMessages).
    if (isToolEnvelope(result)) {
        return makeToolEnvelope(_normalize(result.result), result.newMessages);
    }
    if (result && typeof result === 'object' && Array.isArray(result.content)) {
        return result.content
            .map((c) => (c?.type === 'text' ? c.text || '' : JSON.stringify(c)))
            .join('\n');
    }
    if (typeof result === 'string') return result;
    return JSON.stringify(result);
}
