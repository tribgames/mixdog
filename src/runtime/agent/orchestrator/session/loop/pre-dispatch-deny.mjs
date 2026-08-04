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

const IMAGE_PATH_RE = /\.(?:png|jpe?g|gif|webp)(?:$|[?#])/i;
const COMPACTED_PATCH_LINE_RE = /^\s*\[mixdog compacted\b[^\]\n]*\]/;

function hasCompactedPatchPlaceholder(call) {
    if (call?.name !== 'apply_patch') return false;
    const value = typeof call?.arguments === 'string'
        ? call.arguments
        : call?.arguments?.patch;
    if (typeof value !== 'string') return false;
    for (const line of value.split(/\r?\n/)) {
        if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) continue;
        if (COMPACTED_PATCH_LINE_RE.test(line)) return true;
    }
    return false;
}

function callUrls(call) {
    const value = call?.arguments?.url;
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    if (Array.isArray(value) && value.length && value.every((item) => typeof item === 'string' && item.trim())) {
        return value.map((item) => item.trim());
    }
    return [];
}

export function isLoopbackHttpUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        const host = url.hostname.toLowerCase();
        if (host === 'localhost' || host === '[::1]' || host === '::1') return true;
        const match = host.match(/^(\d{1,3})(?:\.(\d{1,3})){3}$/);
        return Boolean(match && Number(match[1]) === 127);
    } catch {
        return false;
    }
}

/**
 * Rewrite only calls whose complete URL set has one unambiguous transport.
 * Mixed document/image or public/loopback batches stay on web_fetch, whose
 * existing SSRF checks fail closed rather than broadening local_fetch.
 */
export function routeWebFetchCall(call) {
    if (call?.name !== 'web_fetch') return call;
    const urls = callUrls(call);
    if (!urls.length) return call;
    if (urls.every(isLoopbackHttpUrl)) call.name = 'local_fetch';
    else if (urls.every((value) => IMAGE_PATH_RE.test(value))) call.name = 'image_fetch';
    return call;
}

function _preDispatchDeny(call, toolKind, sessionRef) {
    const name = call?.name;
    if (typeof name !== 'string' || !name) return null;
    if (hasCompactedPatchPlaceholder(call)) {
        return 'Error: [tool-input-validation] apply_patch received a compacted-history placeholder, not executable patch content. Re-read the current target files and submit a fresh full patch; do not replay or reconstruct the stored marker.';
    }
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
