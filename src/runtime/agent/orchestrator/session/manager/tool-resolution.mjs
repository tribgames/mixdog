// Session tool schema resolution. Lead and Agent share one full-capability
// catalog; Agent removes only the recursive `agent` control tool.
import { getMcpTools } from '../../mcp/client.mjs';
import { getInternalTools } from '../../internal-tools.mjs';
import { BUILTIN_TOOLS } from '../../tools/builtin/builtin-tools.mjs';
import { PATCH_TOOL_DEFS } from '../../tools/patch-tool-defs.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../../tools/code-graph-tool-defs.mjs';
import { buildSkillToolDefs } from '../../context/collect.mjs';
import { filterModelEditTools } from '../../../../shared/edit-tool-dialect.mjs';

// Merge externally-connected MCP tools with the plugin's in-process tools
// (registered by agent's toolExecutor adapter). Internal tools are exposed
// under their bare names — no mcp__ prefix, since the dispatcher in
// server.mjs handles them directly without a transport.
// Sorted deterministically by name — protects BP_1 hash stability from
// listTools() ordering churn. Anthropic / OpenAI / Gemini all hash the
// tools array verbatim, so any reorder rewrites the prefix.
// No cache: getMcpTools() and getInternalTools() are O(n) in-memory reads;
// the sort overhead on ~30 tools is negligible.
function _getMcpTools(mcpScopeId = null) {
    const mcp = getMcpTools(mcpScopeId) || [];
    // `public:false` tools stay registered in internal-tools for runtime
    // rewrites/dispatch, but must never enter any model-visible schema (Lead
    // full/mcp included). Filter before mapping because the projection below
    // intentionally drops module-private metadata such as `public`.
    const internalRaw = (getInternalTools() || []).filter(t => t?.public !== false);
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

// Canonical route order (mirrors the shared Tool Workflow and the deferred
// catalog's ROUTE_TOOL_ORDER): locator → path → content → symbol → read →
// edit → execute → web.
const SESSION_ROUTE_TOOL_ORDER = [
    'find',
    'glob',
    'list',
    'grep',
    'code_graph',
    'read',
    'edit',
    'apply_patch',
    'git',
    'git_stage',
    'shell',
    'task',
    'web_search',
    'web_fetch',
];
const SESSION_ROUTE_TOOL_RANK = new Map(SESSION_ROUTE_TOOL_ORDER.map((name, index) => [name, index]));
const FILESYSTEM_TOOL_NAMES = new Set([
    'code_graph',
    'find',
    'glob',
    'list',
    'grep',
    'read',
    'edit',
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
    if (ownerIsAgent) {
        out = out.filter(t => String(t?.name || '').toLowerCase() !== 'agent');
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

export function resolveSessionTools(toolSpec, skills, {
    ownerIsAgentSession = false,
    mcpScopeId = null,
    modelName = null,
} = {}) {
    const mcp = _getMcpTools(mcpScopeId);
    // Agent sessions freeze the skill meta-tool into the schema
    // unconditionally — concrete skill resolution is cwd-scoped at tool-call
    // time (loop.mjs), so the schema bytes stay bit-identical across roles /
    // cwds and the provider cache shard does not fragment.
    const skillTools = buildSkillToolDefs(skills, { ownerIsAgentSession });
    return filterModelEditTools(
        _computeBaseTools(toolSpec, mcp, skillTools, { ownerIsAgentSession }),
        modelName,
    );
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
            return orderSessionTools(_dedupByName([...ALL_BUILTIN_SESSION_TOOLS, ...mcp, ...skillTools]));
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
                case 'tools:analysis':
                    addMany(ALL_BUILTIN_SESSION_TOOLS.filter(t => t.name === 'shell' || t.name === 'task'));
                    break;
                case 'tools:git':
                    addMany(ALL_BUILTIN_SESSION_TOOLS.filter(t => t.name === 'git' || t.name === 'git_stage' || t.name === 'shell' || t.name === 'task'));
                    break;
                case 'tools:mcp':
                    addMany(mcp);
                    break;
                case 'tools:websearch':
                    // Name-pattern match: picks up `web_search` and any future
                    // web-search tool. `recall` deliberately does
                    // NOT match — it needs `tools:mcp` (full mcp surface) or its own
                    // toolset id if a role wants targeted retrieval. Public agent
                    // roles never reach the wrapper bodies regardless: see the
                    // isBlockedPublicWrapperCall guard in session/loop.mjs.
                    addMany(mcp.filter(t => /search/i.test(t?.name || '')));
                    break;
                default:
                    process.stderr.write(`[session] unknown toolset id "${tag}" (profile.tools); skipping\n`);
            }
        }
        return orderSessionTools(_dedupByName([...byName.values(), ...skillTools]));
    }

    switch (toolSpec) {
        case 'mcp':
            return orderSessionTools(_dedupByName([...mcp, ...skillTools]));
        case 'readonly': {
            const readTools = ALL_BUILTIN_SESSION_TOOLS.filter(t => READONLY_TOOL_NAMES.has(t.name));
            return orderSessionTools(_dedupByName([...readTools, ...mcp, ...skillTools]));
        }
        case 'full':
        default:
            return orderSessionTools(_dedupByName([...ALL_BUILTIN_SESSION_TOOLS, ...mcp, ...skillTools]));
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
