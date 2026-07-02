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

const WORKER_DENIED_TOOLS = new Set([
    // session control-plane — unified into the single `agent` tool
    // (type=spawn|send|close|list). Denying the one name blocks all worker
    // session control.
    'agent',
    // channels module (owner/Discord-facing)
    'reply', 'react', 'edit_message', 'download_attachment', 'fetch',
    'schedule_status', 'trigger_schedule', 'schedule_control',
    'activate_channel_bridge', 'reload_config', 'inject_command',
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
