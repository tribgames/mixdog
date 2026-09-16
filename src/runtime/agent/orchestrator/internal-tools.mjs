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

import { isToolEnvelope, makeToolEnvelope, normalizeToolEnvelope } from './session/tool-envelope.mjs';
import { classifyResultKind } from './session/result-classification.mjs';

// Runtimes share this module, but their executors close over different
// configuration, sessions and lifecycle state. Use the same scope carried by
// session.mcpScopeId; an explicit scope must never fall back to another runtime.
const _providersByScope = new Map();

function providerScopeKey(scopeId) {
    return String(scopeId || '').trim() || 'global';
}

export function setInternalToolsProvider({ executor, tools, scopeId = null }) {
    if (typeof executor !== 'function') throw new Error('internal-tools: executor must be a function');
    const key = providerScopeKey(scopeId);
    const base = Array.isArray(tools) ? [...tools] : [];
    const provider = { executor, tools: base, names: new Set(base.map(t => t?.name).filter(Boolean)) };
    _providersByScope.set(key, provider);
    return () => {
        if (_providersByScope.get(key) !== provider) return false;
        return _providersByScope.delete(key);
    };
}

export function getInternalTools(scopeId = null) {
    return _providersByScope.get(providerScopeKey(scopeId))?.tools || [];
}

export function isInternalTool(name, scopeId = null) {
    return _providersByScope.get(providerScopeKey(scopeId))?.names.has(name) || false;
}

export async function executeInternalTool(name, args, callerCtx = {}) {
    const provider = _providersByScope.get(providerScopeKey(callerCtx.scopeId));
    if (!provider?.names.has(name)) throw new Error(`internal-tools: "${name}" is not registered`);
    const result = await provider.executor(name, args ?? {}, callerCtx);
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
        const normalized = normalizeToolEnvelope(_normalize(result.result));
        return makeToolEnvelope(normalized.result, result.newMessages, {
            explicitSuccess: normalized.explicitSuccess || result.explicitSuccess === true,
            explicitFailure: normalized.explicitFailure || result.explicitFailure === true,
        });
    }
    if (result && typeof result === 'object' && Array.isArray(result.content)) {
        const hasStructuredMedia = result.content.some((part) => part && typeof part === 'object' && part.type !== 'text');
        if (hasStructuredMedia) {
            return result.isError === true
                ? makeToolEnvelope(result, [], { explicitFailure: true })
                : result;
        }
        const text = result.content
            .map((c) => (c?.type === 'text' ? c.text || '' : JSON.stringify(c)))
            .join('\n');
        // Preserve MCP-style handler outcome metadata across the object→string
        // boundary. Explicit failures retain the canonical Error: convention;
        // explicit successes use a transient envelope so legitimate output
        // beginning with Error: is not mistaken for a failed execution.
        if (result.isError === true) return !text.startsWith('Error:') ? `Error: ${text}` : text;
        if (result.isError === false && classifyResultKind(text) === 'error') {
            return makeToolEnvelope(text, [], { explicitSuccess: true });
        }
        return text;
    }
    if (typeof result === 'string') return result;
    return JSON.stringify(result);
}
