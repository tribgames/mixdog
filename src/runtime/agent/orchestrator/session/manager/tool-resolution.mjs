// Session tool schema resolution + permission narrowing, extracted verbatim
// from manager.mjs. Behavior-preserving: same toolset ids, same ordering,
// same dedup, same fail-closed permission intersection.
import { getMcpTools } from '../../mcp/client.mjs';
import { getInternalTools } from '../../internal-tools.mjs';
import { BUILTIN_TOOLS } from '../../tools/builtin/builtin-tools.mjs';
import { PATCH_TOOL_DEFS } from '../../tools/patch-tool-defs.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../../tools/code-graph-tool-defs.mjs';
import { buildSkillToolDefs } from '../../context/collect.mjs';
import { getHiddenAgent, listHiddenAgentNames } from '../../internal-agents.mjs';

// Merge externally-connected MCP tools with the plugin's in-process tools
// (registered by agent's toolExecutor adapter). Internal tools are exposed
// under their bare names — no mcp__ prefix, since the dispatcher in
// server.mjs handles them directly without a transport.
// Sorted deterministically by name — protects BP_1 hash stability from
// listTools() ordering churn. Anthropic / OpenAI / Gemini all hash the
// tools array verbatim, so any reorder rewrites the prefix.
// No cache: getMcpTools() and getInternalTools() are O(n) in-memory reads;
// the sort overhead on ~30 tools is negligible.
function _getMcpTools() {
    const mcp = getMcpTools() || [];
    const internalRaw = getInternalTools() || [];
    const internal = internalRaw.map(t => ({
        name: t.name,
        description: typeof t.description === 'string' ? t.description : '',
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
        // Keep annotations so the permission filter / role invariants can
        // tell read-only from write-capable internal tools, and so
        // agentHidden can be read during deny filtering.
        annotations: t.annotations || {},
    }));
    return [...mcp, ...internal].sort((a, b) => {
        const an = a?.name || '';
        const bn = b?.name || '';
        return an < bn ? -1 : an > bn ? 1 : 0;
    });
}

const SESSION_ROUTE_TOOL_ORDER = [
    'code_graph',
    'find',
    'glob',
    'list',
    'grep',
    'read',
    'apply_patch',
    'shell',
    'task',
];
const SESSION_ROUTE_TOOL_RANK = new Map(SESSION_ROUTE_TOOL_ORDER.map((name, index) => [name, index]));
const FILESYSTEM_TOOL_NAMES = new Set([
    'code_graph',
    'find',
    'glob',
    'list',
    'grep',
    'read',
    'apply_patch',
]);
const READONLY_TOOL_NAMES = new Set([
    'code_graph',
    'find',
    'glob',
    'list',
    'grep',
    'read',
]);

const AGENT_STRING_PERMISSION_READ_ALLOW = Object.freeze([
    'code_graph',
    'find',
    'glob',
    'list',
    'grep',
    'read',
    // shell/task: read-role agents (reviewer/debugger) must run their own
    // verification (tests/repro). task is required because shell's
    // auto-background transition settles with a bare jobId — agent sessions
    // get no completion notification, so `task wait/read` is the only way to
    // collect a long-running result. apply_patch stays excluded: read roles
    // keep the no-edit contract.
    'shell',
    'task',
    'explore',
    'search',
    'web_fetch',
    'Skill',
]);

// Retrieval/locator roles never self-verify, so they keep the historical
// no-shell read surface. Covers hidden retrieval agents (kind 'retrieval')
// AND public wrapper roles (explore + any invokedBy wrapper) — the same set
// pre-dispatch-deny treats as recursive wrappers. Only verifying read roles
// (reviewer/debugger) get shell/task.
const AGENT_STRING_PERMISSION_READ_RETRIEVAL_ALLOW = Object.freeze(
    AGENT_STRING_PERMISSION_READ_ALLOW.filter((n) => n !== 'shell' && n !== 'task'),
);

function isRetrievalToolRole(agent) {
    if (!agent) return false;
    if (getHiddenAgent(agent)?.kind === 'retrieval') return true;
    return Boolean(recursiveWrapperToolNameForPublicAgent(agent));
}

function stringToolPermissionAllowList(toolPermission, { retrieval = false } = {}) {
    if (toolPermission === 'read') {
        return retrieval ? AGENT_STRING_PERMISSION_READ_RETRIEVAL_ALLOW : AGENT_STRING_PERMISSION_READ_ALLOW;
    }
    if (toolPermission === 'read-write') return AGENT_STRING_PERMISSION_READ_WRITE_ALLOW;
    if (toolPermission === 'none') return [];
    return null;
}

// Read-write agent bundle: full edit surface INCLUDING shell/task so
// write-role agents can run their own verification (build/test) without
// bouncing it back to Lead. Deploy/ship remains a workflow-level rule,
// not a tool-surface restriction.
const AGENT_STRING_PERMISSION_READ_WRITE_ALLOW = Object.freeze([
    'code_graph',
    'find',
    'glob',
    'list',
    'grep',
    'read',
    'apply_patch',
    'shell',
    'task',
    'explore',
    'search',
    'web_fetch',
    'Skill',
]);

export function applyToolPermissionNarrowing(tools, toolPermission, warnRole = null) {
    if (toolPermission === 'none') return [];
    const allowList = stringToolPermissionAllowList(toolPermission, { retrieval: isRetrievalToolRole(warnRole) });
    if (allowList) {
        const allowSet = new Set(allowList.map((n) => String(n).toLowerCase()));
        return tools.filter((t) => allowSet.has(String(t?.name || '').toLowerCase()));
    }
    if (toolPermission && typeof toolPermission === 'object') {
        const allowSet = Array.isArray(toolPermission.allow) && toolPermission.allow.length > 0
            ? new Set(toolPermission.allow.map(n => String(n).toLowerCase()))
            : null;
        const denySet = Array.isArray(toolPermission.deny) && toolPermission.deny.length > 0
            ? new Set(toolPermission.deny.map(n => String(n).toLowerCase()))
            : null;
        if (allowSet || denySet) {
            const filtered = tools.filter(t => {
                const name = String(t?.name || '').toLowerCase();
                if (denySet && denySet.has(name)) return false;
                if (allowSet && !allowSet.has(name)) return false;
                return true;
            });
            if (filtered.length === 0) {
                process.stderr.write(`[session] WARN: role permission intersection produced 0 tools — failing closed (role=${warnRole || 'unknown'})\n`);
            }
            return filtered;
        }
    }
    return tools;
}

export function recursiveWrapperToolNameForPublicAgent(agent) {
    if (!agent) return null;
    const key = String(agent).trim();
    if (key === 'explore') return 'explore';
    for (const hiddenName of listHiddenAgentNames()) {
        const def = getHiddenAgent(hiddenName);
        const invokedBy = typeof def?.invokedBy === 'string' ? def.invokedBy.trim() : '';
        if (hiddenName === key && invokedBy) return invokedBy;
        if (invokedBy && invokedBy === key) return invokedBy;
    }
    return null;
}

export function finalizeSessionToolList(tools, {
    schemaAllowedTools = null,
    disallowedTools = null,
    ownerIsAgent = false,
    resolvedAgent = null,
} = {}) {
    let out = Array.isArray(tools) ? tools : [];
    const hasCallerAllow = Array.isArray(schemaAllowedTools);
    if (hasCallerAllow) {
        const allowSet = new Set(schemaAllowedTools.map(n => String(n).toLowerCase()));
        out = out.filter(t => allowSet.has(String(t?.name || '').toLowerCase()));
    }
    const callerDeny = Array.isArray(disallowedTools) ? disallowedTools.map(n => String(n)) : [];
    if (callerDeny.length) {
        const denySet = new Set(callerDeny.map(n => n.toLowerCase()));
        out = out.filter(t => !denySet.has(String(t?.name || '').toLowerCase()));
    }
    // NOTE: the self-wrapper anti-recursion deny is intentionally NOT applied
    // here. Stripping a role's own wrapper tool (e.g. explore) from the schema
    // would fork the read-only cache group into one shard per wrapper role.
    // The bundle stays bit-identical; recursion is broken at call time in
    // pre-dispatch-deny.mjs (recursiveWrapperToolNameForPublicAgent) instead.
    if (ownerIsAgent) {
        out = out.filter(t => !t?.annotations?.agentHidden);
        out = orderSessionTools(out);
    }
    return out;
}

function orderSessionTools(tools) {
    return tools.map((tool, index) => ({ tool, index }))
        .sort((a, b) => {
            const ar = SESSION_ROUTE_TOOL_RANK.get(a.tool?.name) ?? 10_000;
            const br = SESSION_ROUTE_TOOL_RANK.get(b.tool?.name) ?? 10_000;
            if (ar !== br) return ar - br;
            return a.index - b.index;
        })
        .map((entry) => entry.tool);
}

const ALL_BUILTIN_SESSION_TOOLS = orderSessionTools(_dedupByName([
    ...BUILTIN_TOOLS,
    ...PATCH_TOOL_DEFS,
    ...CODE_GRAPH_TOOL_DEFS,
]));

export function resolveSessionTools(toolSpec, skills, { ownerIsAgentSession = false } = {}) {
    const mcp = _getMcpTools();
    // Agent sessions freeze the skill meta-tool into the schema
    // unconditionally — concrete skill resolution is cwd-scoped at tool-call
    // time (loop.mjs), so the schema bytes stay bit-identical across roles /
    // cwds and the provider cache shard does not fragment.
    const skillTools = buildSkillToolDefs(skills, { ownerIsAgentSession });
    return _computeBaseTools(toolSpec, mcp, skillTools, { ownerIsAgentSession });
}

export function previewSessionTools(toolSpec, skills = [], options = {}) {
    return resolveSessionTools(toolSpec, skills, options);
}

// Dedup by name, first occurrence wins. BUILTIN_TOOLS is passed in ahead
// of the MCP-registered internal tools so plugin-side definitions take
// precedence when both surfaces declare the same name (e.g. read / grep / glob).
// Without this merge, Anthropic rejected the request with
// "tools: Tool names must be unique" and the orchestrator burned up to
// 20 iterations retrying before the final answer landed.
function _dedupByName(tools) {
    const seen = new Map();
    for (const t of tools) {
        const n = t?.name;
        if (!n || seen.has(n)) continue;
        seen.set(n, t);
    }
    return [...seen.values()];
}

// Agent visibility is declared per-tool via annotations.agentHidden.
// Tools with agentHidden:true are stripped from agent sessions at schema
// build time (see deny filtering below). No code-level name list needed.

function _computeBaseTools(toolSpec, mcp, skillTools, { ownerIsAgentSession = false } = {}) {
    if (Array.isArray(toolSpec)) {
        if (toolSpec.length === 0) {
            // Explicit "no tools" — skill meta tools still travel so the model
            // can at least discover and invoke skills if that is the one
            // dynamic surface the profile retains.
            return _dedupByName([...skillTools]);
        }
        if (toolSpec.includes('full')) {
            return _dedupByName([...ALL_BUILTIN_SESSION_TOOLS, ...mcp, ...skillTools]);
        }
        const byName = new Map();
        const add = (tool) => { if (tool?.name && !byName.has(tool.name)) byName.set(tool.name, tool); };
        const addMany = (arr) => { for (const t of arr) add(t); };
        for (const tagRaw of toolSpec) {
            const tag = String(tagRaw || '').trim();
            switch (tag) {
                case 'tools:filesystem':
                    addMany(ALL_BUILTIN_SESSION_TOOLS.filter(t => FILESYSTEM_TOOL_NAMES.has(t.name)));
                    break;
                case 'tools:readonly':
                    addMany(ALL_BUILTIN_SESSION_TOOLS.filter(t => READONLY_TOOL_NAMES.has(t.name)));
                    break;
                case 'tools:shell':
                case 'tools:git':
                case 'tools:analysis':
                    // Shell-class toolset. `tools:git` / `tools:analysis` exist so
                    // profile authors can name the intent (git workflows / data
                    // analysis) without inventing new toolset ids.
                    addMany(ALL_BUILTIN_SESSION_TOOLS.filter(t => t.name === 'shell' || t.name === 'task'));
                    break;
                case 'tools:mcp':
                    addMany(mcp);
                    break;
                case 'tools:search':
                    // Name-pattern match: picks up `search` and any future tool
                    // whose name contains `search`. `recall` and `explore` deliberately do NOT match
                    // — they need `tools:mcp` (full mcp surface) or their own
                    // toolset id if a role wants targeted retrieval. Public agent
                    // roles never reach the wrapper bodies regardless: see the
                    // isBlockedPublicWrapperCall guard in session/loop.mjs.
                    addMany(mcp.filter(t => /search/i.test(t?.name || '')));
                    break;
                default:
                    process.stderr.write(`[session] unknown toolset id "${tag}" (profile.tools); skipping\n`);
            }
        }
        return _dedupByName([...byName.values(), ...skillTools]);
    }

    switch (toolSpec) {
        case 'mcp':
            return _dedupByName([...mcp, ...skillTools]);
        case 'readonly': {
            const readTools = ALL_BUILTIN_SESSION_TOOLS.filter(t => READONLY_TOOL_NAMES.has(t.name));
            // Read-ROLE agent sessions (reviewer/debugger) must self-verify, so
            // their base bundle carries shell/task defs. The 'read' permission
            // allowlist (AGENT_STRING_PERMISSION_READ_ALLOW) is a pure FILTER —
            // it can only keep tools already assembled here, so without this the
            // allowlist's shell/task entries were dead letters. Non-agent
            // 'readonly' profiles stay strictly read-only.
            const verifyTools = ownerIsAgentSession
                ? ALL_BUILTIN_SESSION_TOOLS.filter(t => t.name === 'shell' || t.name === 'task')
                : [];
            return _dedupByName([...readTools, ...verifyTools, ...mcp, ...skillTools]);
        }
        case 'full':
        default:
            return _dedupByName([...ALL_BUILTIN_SESSION_TOOLS, ...mcp, ...skillTools]);
    }
}

export function permissionFromToolSpec(toolSpec) {
    if (toolSpec === 'readonly') return 'read';
    if (toolSpec === 'mcp') return 'mcp';
    if (Array.isArray(toolSpec)) {
        const tags = new Set(toolSpec.map(t => String(t || '').trim()));
        const hasWriteOrShell = tags.has('full')
            || tags.has('tools:filesystem')
            || tags.has('tools:shell')
            || tags.has('tools:git')
            || tags.has('tools:analysis');
        if (tags.has('tools:readonly') && !hasWriteOrShell) return 'read';
    }
    return null;
}
