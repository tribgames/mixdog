// Shared pre-dispatch deny — single source of truth for the remaining
// control-plane / role scoping rejects. Called by BOTH the eager dispatch
// path (startEagerTool) and the serial dispatch path (executeTool body).
// Returns null when the call is allowed to proceed; otherwise returns the
// Error string the serial path would emit. The eager caller ignores the
// message body and just treats non-null as "do not start eager".
//
// This is NOT a permission gate — runtime permission enforcement was removed
// (every tool call is trusted). What remains is architectural scoping:
// agent workers are sandboxed to code/research tools. They must never reach
// owner/host control surfaces: session management, the ENTIRE channels module
// (Discord messaging, schedules, webhook/config, channel-bridge toggle,
// command injection), or host input injection. Explicit name list (no imports)
// keeps this hot-path gate dependency-free; add new owner/channel tools here.
import { isAgentOwner } from '../../agent-owner.mjs';
import { recursiveWrapperToolNameForPublicAgent } from '../manager/tool-resolution.mjs';

const WORKER_DENIED_TOOLS = new Set([
    // session control-plane — unified into the single `agent` tool
    // (type=spawn|send|close|list). Denying the one name blocks all worker
    // session control.
    'agent',
    // channels module (owner/Discord-facing)
    'reply', 'fetch',
    // host input injection
    'inject_input',
]);

function _preDispatchDeny(call, toolKind, sessionRef) {
    const name = call?.name;
    if (typeof name !== 'string' || !name) return null;
    const _agentOwned = sessionRef?.scope?.startsWith?.('agent:')
        || isAgentOwner(sessionRef);
    const _controlPlaneTool = WORKER_DENIED_TOOLS.has(name);
    if (_agentOwned && _controlPlaneTool) {
        return `Error: control-plane tool "${name}" is Lead-only and not available to agent workers.`;
    }
    // Anti-recursion break, moved OFF the schema so the read-only tool bundle
    // stays bit-identical across every read role (explore ships in the schema
    // for all of them, incl. the explore agent itself — one cache group).
    // A public agent that IS a recursive wrapper (e.g. explore) must not call
    // its own wrapper tool; reject it here at call time instead.
    if (_agentOwned) {
        const selfWrapper = recursiveWrapperToolNameForPublicAgent(sessionRef?.agent || null);
        if (selfWrapper && name.toLowerCase() === selfWrapper.toLowerCase()) {
            return `Error: tool "${name}" is not available inside agent "${sessionRef.agent}" (would recurse into its own wrapper). Return the answer directly.`;
        }
    }
    const noToolAgent = sessionRef?.agent === 'cycle1-agent' || sessionRef?.agent === 'cycle2-agent';
    if (noToolAgent) {
        return `Error: tool "${name}" is not available in agent "${sessionRef.agent}". Re-emit the answer as pipe-separated text per the agent's output format (first character a digit, NO tool_use blocks, NO JSON, NO prose, NO apology).`;
    }
    return null;
}

/** Exported for smoke tests — same runtime deny as the agent loop. */
export function preDispatchDenyForSession(sessionRef, call, toolKind = 'builtin') {
    return _preDispatchDeny(call, toolKind, sessionRef);
}
