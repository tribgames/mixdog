import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { randomBytes, createHash } from 'crypto';
import { join } from 'path';
import { getProvider, providerInputExcludesCache } from '../providers/registry.mjs';
import { getModelMetadataSync } from '../providers/model-catalog.mjs';
import { fetchOAuthUsageSnapshot } from '../providers/oauth-usage.mjs';
// Image content is kept in-memory and in the model-visible history so multi-turn
// recognition matches reference agent behavior (live transcript always retains images). The
// stored-history placeholder swap now happens only at disk-serialization time
// inside the session store, so it is no longer imported here.
import {
    recallFastTrackCompactMessages,
    semanticCompactMessages,
    compactTypeIsRecallFastTrack,
    compactTypeIsSemantic,
    normalizeCompactType,
    DEFAULT_COMPACT_TYPE,
    SUMMARY_PREFIX,
    DEFAULT_COMPACTION_BUFFER_RATIO,
    compactionBufferTokensForBoundary,
    normalizeCompactionBufferRatio,
    drainSessionCycle1,
} from './compact.mjs';
import { estimateMessagesTokens, estimateRequestReserveTokens } from './context-utils.mjs';
import { getMcpTools } from '../mcp/client.mjs';
import { getInternalTools, executeInternalTool } from '../internal-tools.mjs';
import { BUILTIN_TOOLS } from '../tools/builtin/builtin-tools.mjs';
import { PATCH_TOOL_DEFS } from '../tools/patch-tool-defs.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../tools/code-graph-tool-defs.mjs';
import { collectSkillsCached, buildSkillManifest, buildSkillToolDefs, composeSystemPrompt } from '../context/collect.mjs';
import { saveSession, saveSessionAsync, loadSession, listStoredSessionSummaries, sweepStaleSessions, markSessionClosed, publishHeartbeat, deleteHeartbeat, setLiveSession } from './store.mjs';
import { clearReadDedupSession, tryPrefetchCached, setPrefetchCached } from './read-dedup.mjs';
import { clearOffloadSession } from './tool-result-offload.mjs';
import { classifyResultKind } from './result-classification.mjs';
import { createAbortController } from '../../../shared/abort-controller.mjs';
import { isInternalRuntimeNotificationText as contractIsInternalRuntimeNotificationText } from '../../../shared/tool-execution-contract.mjs';
import { logLlmCall } from '../../../shared/llm/usage-log.mjs';
import { resolvePluginData, mixdogRoot } from '../../../shared/plugin-paths.mjs';
import { updateJsonAtomicSync } from '../../../shared/atomic-file.mjs';
import { appendAgentTrace } from '../agent-trace.mjs';
import { isAgentOwner } from '../agent-owner.mjs';
import { maxMtimeRecursive } from '../cache-mtime.mjs';
import { getHiddenRole, getRoleInstructionDir } from '../internal-roles.mjs';
import { DEFAULT_ACTIVITY_HEARTBEAT_MS } from '../stall-policy.mjs';
import {
    buildGatewayLimits,
    recordGatewayUsageEvent,
    summarizeGatewayUsage,
} from '../providers/statusline-route-meta.mjs';
// Phase B: Pool B Tier 2 content builder (common rules only).
// Loaded once per process via createRequire so the CJS module reaches us.
const _require = createRequire(import.meta.url);
const _rulesBuilder = (() => {
    const candidates = [
        join(mixdogRoot(), 'lib', 'rules-builder.cjs'),
    ].filter(Boolean);
    for (const p of candidates) {
        try { return _require(p); } catch { /* fall through */ }
    }
    // Fallback: walk up from this file's location to find lib/rules-builder.cjs.
    try { return _require('../../../../lib/rules-builder.cjs'); } catch { return null; }
})();

// BP1/BP2/BP3 prompt-layer caches — invalidated by source file mtime, not a
// timer. Cheap: O(sentinel-count) stat calls on each session creation, no file
// I/O when warm.
let _sharedRulesCache = null;
let _sharedRulesMtime = 0;
const _agentRulesCacheByProfile = new Map();
let _leadRulesCache = null;
let _leadRulesMtime = 0;
let _leadMetaCache = null;
let _leadMetaMtime = 0;
let _codeGraphRuntimePromise = null;
let _agentLoopPromise = null;
let _bashSessionRuntimePromise = null;
async function _executeCodeGraphToolLazy(name, args, cwd, signal = null, options = {}) {
    _codeGraphRuntimePromise ??= import('../tools/code-graph.mjs');
    const mod = await _codeGraphRuntimePromise;
    if (typeof mod.executeCodeGraphTool !== 'function') throw new Error('code_graph runtime is not available');
    return mod.executeCodeGraphTool(name, args, cwd, signal, options);
}
async function _getAgentLoop() {
    _agentLoopPromise ??= import('./loop.mjs');
    const mod = await _agentLoopPromise;
    if (typeof mod.agentLoop !== 'function') throw new Error('agent loop runtime is not available');
    return mod.agentLoop;
}
function _closeBashSessionLazy(sessionId, reason) {
    if (!sessionId) return;
    _bashSessionRuntimePromise ??= import('../tools/bash-session.mjs');
    _bashSessionRuntimePromise
        .then((mod) => { if (typeof mod.closeBashSession === 'function') mod.closeBashSession(sessionId, reason); })
        .catch(() => {});
}
function _buildSharedRules() {
    if (!_rulesBuilder || typeof _rulesBuilder.buildSharedToolContent !== 'function') return '';
    const PLUGIN_ROOT = mixdogRoot();
    const RULES_DIR = join(PLUGIN_ROOT, 'rules');
    const mtime = maxMtimeRecursive([
        join(RULES_DIR, 'shared'),
    ]);
    if (_sharedRulesCache !== null && mtime <= _sharedRulesMtime) {
        return _sharedRulesCache;
    }
    try {
        const built = _rulesBuilder.buildSharedToolContent({ PLUGIN_ROOT, DATA_DIR: resolvePluginData() });
        _sharedRulesCache = built;
        _sharedRulesMtime = mtime;
        return built;
    } catch (e) {
        throw new Error(`[session] shared tool rules build failed: ${e.message}`);
    }
}

function _buildAgentRules(profile = 'full') {
    if (!_rulesBuilder || typeof _rulesBuilder.buildAgentRoleContent !== 'function') return '';
    const key = String(profile || 'full');
    const PLUGIN_ROOT = mixdogRoot();
    const DATA_DIR = resolvePluginData();
    const RULES_DIR = join(PLUGIN_ROOT, 'rules');
    const mtime = maxMtimeRecursive([
        join(RULES_DIR, 'agent'),
        join(DATA_DIR, 'mixdog-config.json'),
    ]);
    const cached = _agentRulesCacheByProfile.get(key);
    if (cached && mtime <= cached.mtime) {
        return cached.value;
    }
    try {
        const built = _rulesBuilder.buildAgentRoleContent({ PLUGIN_ROOT, DATA_DIR, profile: key });
        _agentRulesCacheByProfile.set(key, { mtime, value: built });
        return built;
    } catch (e) {
        throw new Error(`[session] agent role rules build failed: ${e.message}`);
    }
}

function _buildLeadRules() {
    if (!_rulesBuilder || typeof _rulesBuilder.buildLeadRoleContent !== 'function') return '';
    const PLUGIN_ROOT = mixdogRoot();
    const DATA_DIR = resolvePluginData();
    const RULES_DIR = join(PLUGIN_ROOT, 'rules');
    const mtime = maxMtimeRecursive([
        join(RULES_DIR, 'lead'),
        join(DATA_DIR, 'mixdog-config.json'),
    ]);
    if (_leadRulesCache !== null && mtime <= _leadRulesMtime) {
        return _leadRulesCache;
    }
    try {
        const built = _rulesBuilder.buildLeadRoleContent({ PLUGIN_ROOT, DATA_DIR });
        _leadRulesCache = built;
        _leadRulesMtime = mtime;
        return built;
    } catch (e) {
        throw new Error(`[session] lead role rules build failed: ${e.message}`);
    }
}

function _buildLeadMetaContext() {
    if (!_rulesBuilder || typeof _rulesBuilder.buildLeadMetaContent !== 'function') return '';
    const PLUGIN_ROOT = mixdogRoot();
    const DATA_DIR = resolvePluginData();
    const RULES_DIR = join(PLUGIN_ROOT, 'rules');
    const mtime = maxMtimeRecursive([
        join(RULES_DIR, 'lead'),
        join(DATA_DIR, 'history'),
        join(DATA_DIR, 'mixdog-config.json'),
        join(DATA_DIR, 'user-workflow.md'),
        join(PLUGIN_ROOT, 'output-styles'),
        join(DATA_DIR, 'output-styles'),
    ]);
    if (_leadMetaCache !== null && mtime <= _leadMetaMtime) {
        return _leadMetaCache;
    }
    try {
        const built = _rulesBuilder.buildLeadMetaContent({ PLUGIN_ROOT, DATA_DIR });
        _leadMetaCache = built;
        _leadMetaMtime = mtime;
        return built;
    } catch (e) {
        throw new Error(`[session] lead meta context build failed: ${e.message}`);
    }
}

// BP4-adjacent role-specific data cache — keyed by role. webhook / schedule
// roles each have their own scoped instruction set; other roles return ''.
const _roleSpecificCache = new Map(); // role → { value, mtime }
function _buildRoleSpecific(currentRole) {
    if (!_rulesBuilder || typeof _rulesBuilder.buildAgentRoleSpecificContent !== 'function') return '';
    if (!currentRole) return '';
    const PLUGIN_ROOT = mixdogRoot();
    const DATA_DIR = resolvePluginData();
    const RULES_DIR = join(PLUGIN_ROOT, 'rules');
    const roleInstructionDir = getRoleInstructionDir(currentRole);
    const mtime = maxMtimeRecursive([
        join(RULES_DIR, 'shared'),
        join(DATA_DIR, 'mixdog-config.json'),
        join(DATA_DIR, 'webhooks'),
        join(DATA_DIR, 'schedules'),
        ...(roleInstructionDir ? [join(DATA_DIR, roleInstructionDir)] : []),
        join(PLUGIN_ROOT, 'defaults', 'hidden-roles.json'),
    ]);
    const entry = _roleSpecificCache.get(currentRole);
    if (entry && mtime <= entry.mtime) {
        return entry.value;
    }
    try {
        const built = _rulesBuilder.buildAgentRoleSpecificContent({ PLUGIN_ROOT, DATA_DIR, currentRole });
        _roleSpecificCache.set(currentRole, { mtime, value: built });
        return built;
    } catch (e) {
        throw new Error(`[session] role-specific rules build failed (role: ${currentRole}): ${e.message}`);
    }
}

// Agent Runtime is optional — injected via setAgentRuntime() during plugin init
// so session creation never depends on a circular import. If never injected,
// createSession simply falls back to classic preset-only behavior.
let _agentRuntimeApi = null;
let _agentRuntimeWarned = false;

/**
 * Inject the Agent Runtime singleton. Called once by agent/index.mjs init()
 * after initAgentRuntime(). Safe to call multiple times — later calls
 * replace the previous reference.
 */
export function setAgentRuntime(api) {
    _agentRuntimeApi = api || null;
}

function getAgentRuntimeSync() {
    return _agentRuntimeApi;
}

/**
 * Thrown when a session is closed while a call is in-flight. Callers (agent
 * handler, CLI) should render this as "cancelled" rather than a hard error.
 */
export class SessionClosedError extends Error {
    constructor(sessionId, reason, closeReason) {
        super(reason ? `Session "${sessionId}" closed: ${reason}` : `Session "${sessionId}" closed`);
        this.name = 'SessionClosedError';
        this.sessionId = sessionId;
        this.cancelled = true;
        // closeReason is the diagnostic enum (request-abort / manual /
        // idle-sweep / runner-crash). Kept separate from `reason` (the free
        // -form message) so consumers can branch on it without regex parsing.
        this.reason = closeReason || null;
    }
}
const HEARTBEAT_THROTTLE_MS = 60_000; // 60s
// Cap how long the terminal unwind blocks on the post-result session save.
// The result is already produced (and relayed for agent surfaces) before this
// save, so a stalled disk write must not hold askSession() open — otherwise the
// owning background task is stranded in `running` and its completion
// notification never fires. A slow write finishes in the background.
const TERMINAL_SAVE_TIMEOUT_MS = nonNegativeIntEnv('MIXDOG_TERMINAL_SAVE_TIMEOUT_MS', 5_000);

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

// Phase D-2 — profile.tools resolution.
//
// `toolSpec` may be:
//   • Array<string>  (profile.tools) — toolset ids like "tools:filesystem",
//                     "tools:git", "tools:mcp", "tools:search",
//                     "tools:readonly", or the literal "full"
//   • 'full' / 'readonly' / 'mcp'  — legacy preset.tools strings
//   • null / undefined             — same as 'full' (historical default)
//
// Array form is the Phase B/D target: each profile declares its tool surface
// explicitly, BP_1 hash differs across profiles with different tool subsets
// (by design — sub-task profile cannot see bash; worker-full can), and
// adding a new toolset id here is a localised change.
//
// Unified-shard policy — the session's tool array normally never narrows
// with permission or role. Agent sessions share the same schema so BP_1
// stays bit-identical and the provider-side cache shard is shared
// workspace-wide. Rare specialist roles may pass schemaAllowedTools from a
// declarative hidden-role toolSchemaProfile to keep their first-turn routing
// surface intentionally tiny; runtime permission guards in loop.mjs remain
// the fail-safe either way.

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

function resolveSessionTools(toolSpec, skills, { ownerIsAgentSession = false } = {}) {
    const mcp = _getMcpTools();
    // Agent sessions freeze the skill meta-tool into the schema
    // unconditionally — concrete skill resolution is cwd-scoped at tool-call
    // time (loop.mjs), so the schema bytes stay bit-identical across roles /
    // cwds and the provider cache shard does not fragment.
    const skillTools = buildSkillToolDefs(skills, { ownerIsAgentSession });
    return _computeBaseTools(toolSpec, mcp, skillTools);
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

function _computeBaseTools(toolSpec, mcp, skillTools) {
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
            return _dedupByName([...readTools, ...mcp, ...skillTools]);
        }
        case 'full':
        default:
            return _dedupByName([...ALL_BUILTIN_SESSION_TOOLS, ...mcp, ...skillTools]);
    }
}

function permissionFromToolSpec(toolSpec) {
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

let nextId = Date.now();
// Known context windows for the current-generation models this plugin
// routes to. Anything not listed falls through to guessContextWindow() —
// local llama/mistral/phi default to 8192, everything else 128000. Keep
// this map trimmed to live models; older generations slow down reads
// without buying anything.
const CONTEXT_WINDOWS = {
    // OpenAI GPT-5.x family
    'gpt-5.5': 272000,
    'gpt-5.4': 272000,
    'gpt-5.4-mini': 272000,
    'gpt-5.4-nano': 272000,
    // Anthropic Claude 4.x
    'claude-opus-4-8': 1000000,
    'claude-opus-4-7': 1000000,
    'claude-sonnet-4-6': 1000000,
    'claude-haiku-4-5-20251001': 200000,
    // Google Gemini 3.x
    'gemini-3.1-pro': 1000000,
    'gemini-3-pro': 1000000,
    'gemini-3.5-flash': 1000000,
    'gemini-3-flash': 1000000,
};
function guessContextWindow(model) {
    if (CONTEXT_WINDOWS[model])
        return CONTEXT_WINDOWS[model];
    if (model.includes('llama') || model.includes('mistral') || model.includes('phi'))
        return 8192;
    return 128000;
}
function positiveContextWindow(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
function envFlag(name, fallback = false) {
    const v = process.env[name];
    if (v === undefined) return fallback;
    return !['0', 'false', 'off', 'no'].includes(String(v).trim().toLowerCase());
}
function boundedPercent(value, fallback = null) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0 && n <= 100) return n;
    return fallback;
}
function providerNameOf(provider) {
    if (typeof provider === 'string') return provider.toLowerCase();
    return String(provider?.name || provider?.id || '').toLowerCase();
}
function compactBufferRatioForSession(session) {
    const cfg = session?.compaction || {};
    return normalizeCompactionBufferRatio(
        cfg.bufferPercent
            ?? cfg.bufferPct
            ?? cfg.bufferRatio
            ?? cfg.bufferFraction
            ?? process.env.MIXDOG_AGENT_COMPACT_BUFFER_PERCENT
            ?? process.env.MIXDOG_AGENT_COMPACT_BUFFER_RATIO,
        DEFAULT_COMPACTION_BUFFER_RATIO,
    );
}
function compactBufferTokensForSession(session, boundaryTokens) {
    const cfg = session?.compaction || {};
    const explicit = positiveContextWindow(cfg.bufferTokens ?? cfg.buffer)
        || positiveContextWindow(process.env.MIXDOG_AGENT_COMPACT_BUFFER_TOKENS)
        || 0;
    return compactionBufferTokensForBoundary(boundaryTokens, {
        explicitTokens: explicit,
        ratio: compactBufferRatioForSession(session),
        maxRatio: 0.25,
    });
}
const COMPACT_TARGET_RATIO = 0.02;
const COMPACT_TARGET_MIN_TOKENS = 4_000;
const COMPACT_TARGET_MAX_TOKENS = 16_000;
function compactTargetRatio() {
    const raw = process.env.MIXDOG_AGENT_COMPACT_TARGET_PERCENT
        ?? process.env.MIXDOG_COMPACT_TARGET_PERCENT
        ?? COMPACT_TARGET_RATIO;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return COMPACT_TARGET_RATIO;
    return n > 1 ? n / 100 : n;
}
function compactTargetTokensForBoundary(boundaryTokens) {
    const boundary = positiveContextWindow(boundaryTokens);
    if (!boundary) return null;
    const explicit = positiveContextWindow(
        process.env.MIXDOG_AGENT_COMPACT_TARGET_TOKENS
            ?? process.env.MIXDOG_COMPACT_TARGET_TOKENS,
    );
    if (explicit) return Math.max(1, Math.min(boundary, explicit));
    const minTarget = Math.min(boundary, positiveContextWindow(process.env.MIXDOG_COMPACT_TARGET_MIN_TOKENS) || COMPACT_TARGET_MIN_TOKENS);
    const maxTarget = Math.min(boundary, positiveContextWindow(process.env.MIXDOG_COMPACT_TARGET_MAX_TOKENS) || COMPACT_TARGET_MAX_TOKENS);
    const byRatio = Math.max(1, Math.floor(boundary * compactTargetRatio()));
    return Math.max(1, Math.min(boundary, maxTarget, Math.max(minTarget, byRatio)));
}
function defaultEffectiveContextWindowPercent(provider) {
    // Gateway/statusline route metadata reserves a universal 10% headroom from
    // the raw catalog window. Keep session compaction on the same effective
    // capacity so /context, the TUI statusline, and gateway telemetry agree.
    return 90;
}
function resolveSessionContextMeta(provider, model, seed = {}) {
    const info = typeof provider?.getCachedModelInfo === 'function'
        ? provider.getCachedModelInfo(model)
        : null;
    const catalogInfo = getModelMetadataSync(model, providerNameOf(provider));
    const rawContextWindow = positiveContextWindow(info?.contextWindow)
        || positiveContextWindow(info?.maxContextWindow)
        || positiveContextWindow(info?.context_window)
        || positiveContextWindow(info?.max_context_window)
        || positiveContextWindow(catalogInfo?.contextWindow)
        || positiveContextWindow(catalogInfo?.maxContextWindow)
        || positiveContextWindow(catalogInfo?.context_window)
        || positiveContextWindow(catalogInfo?.max_context_window)
        || positiveContextWindow(seed.rawContextWindow)
        || positiveContextWindow(seed.raw_context_window)
        || positiveContextWindow(seed.contextWindow)
        || guessContextWindow(model);
    const effectiveContextWindowPercent = boundedPercent(
        seed.effectiveContextWindowPercent
            ?? seed.effective_context_window_percent
            ?? info?.effectiveContextWindowPercent
            ?? info?.effective_context_window_percent
            ?? catalogInfo?.effectiveContextWindowPercent
            ?? catalogInfo?.effective_context_window_percent,
        defaultEffectiveContextWindowPercent(provider),
    );
    const pct = boundedPercent(effectiveContextWindowPercent, 100);
    const contextWindow = Math.max(1, Math.floor(rawContextWindow * pct / 100));
    const explicitCompactLimit = positiveContextWindow(
        seed.autoCompactTokenLimit
            ?? seed.auto_compact_token_limit
            ?? info?.autoCompactTokenLimit
            ?? info?.auto_compact_token_limit
            ?? catalogInfo?.autoCompactTokenLimit
            ?? catalogInfo?.auto_compact_token_limit,
    );
    // Do NOT derive the auto-compact limit from the full effective window.
    // Setting it to contextWindow makes autoTriggerTokens == boundary and the
    // compaction buffer collapse to 0 (loop.mjs:708-713 / compactTriggerForSession),
    // so auto-compact only fires when the context is already at the limit —
    // at which point semantic compact fails ("result exceeds budget" /
    // "summary cannot fit") and the turn can no longer be resumed.
    // Leave it null unless the provider/catalog/seed supplies an explicit
    // limit; the downstream buffer logic (default 10%, capped 25%) then
    // triggers compaction with headroom, matching the reference auto-compact threshold.
    const autoCompactTokenLimit = explicitCompactLimit || null;
    const compactBoundaryTokens = contextWindow;
    return {
        contextWindow,
        rawContextWindow,
        effectiveContextWindowPercent,
        autoCompactTokenLimit: autoCompactTokenLimit || null,
        compactBoundaryTokens,
    };
}
function compactTriggerForSession(session, boundaryTokens) {
    const boundary = positiveContextWindow(boundaryTokens);
    if (!boundary) return null;
    const autoLimit = positiveContextWindow(session?.autoCompactTokenLimit ?? session?.compaction?.autoCompactTokenLimit);
    if (autoLimit && autoLimit <= boundary) return Math.max(1, autoLimit);
    const buffer = compactBufferTokensForSession(session, boundary);
    return Math.max(1, boundary - buffer);
}
function compactTargetBudget(boundaryTokens, reserveTokens, _sourceTokens = null, _ratio = null) {
    const boundary = positiveContextWindow(boundaryTokens);
    if (!boundary) return null;
    const reserve = Math.max(0, Number(reserveTokens) || 0);
    const targetEffective = compactTargetTokensForBoundary(boundary) || boundary;
    return Math.max(1, Math.min(boundary, targetEffective + reserve));
}
function semanticCompactionEnabledForSession(session) {
    const cfg = session?.compaction || {};
    if (process.env.MIXDOG_AGENT_COMPACT_SEMANTIC !== undefined) return envFlag('MIXDOG_AGENT_COMPACT_SEMANTIC', true);
    if (process.env.MIXDOG_COMPACT_SEMANTIC !== undefined) return envFlag('MIXDOG_COMPACT_SEMANTIC', true);
    if (cfg.semantic === false || cfg.semantic === 'false' || cfg.semantic === 'off') return false;
    if (cfg.semantic === true || cfg.semantic === 'true' || cfg.semantic === 'on' || cfg.semantic === 'auto') return true;
    return true;
}
function compactTypeForSession(session) {
    const cfg = session?.compaction || {};
    const configured = process.env.MIXDOG_AGENT_COMPACT_TYPE
        ?? process.env.MIXDOG_COMPACT_TYPE
        ?? cfg.type
        ?? cfg.compactType
        ?? cfg.compact_type;
    return normalizeCompactType(configured, DEFAULT_COMPACT_TYPE);
}
function addCompactUsageToSession(session, usage) {
    if (!session || !usage) return;
    const inputTokens = usage.inputTokens || 0;
    const outputTokens = usage.outputTokens || 0;
    const cachedTokens = usage.cachedTokens || 0;
    const cacheWriteTokens = usage.cacheWriteTokens || 0;
    session.totalInputTokens = (session.totalInputTokens || 0) + inputTokens;
    session.totalOutputTokens = (session.totalOutputTokens || 0) + outputTokens;
    session.totalCachedReadTokens = (session.totalCachedReadTokens || 0) + cachedTokens;
    session.totalCacheWriteTokens = (session.totalCacheWriteTokens || 0) + cacheWriteTokens;
    session.tokensCumulative = (session.tokensCumulative || 0) + inputTokens + outputTokens;
}
async function runRecallFastTrackForSession(session, messages, opts = {}) {
    const sessionId = opts.sessionId || session?.id || null;
    if (!sessionId) throw new Error('recall-fasttrack requires a session id');
    const query = `session:${sessionId}:all-chunks`;
    const querySha = createHash('sha256').update(query).digest('hex').slice(0, 16);
    const callerCtx = {
        callerSessionId: sessionId,
        callerCwd: session?.cwd || undefined,
        routingSessionId: sessionId,
        clientHostPid: session?.clientHostPid,
        signal: opts.signal || null,
    };
    const hydrateLimit = positiveContextWindow(session?.compaction?.recallIngestLimit)
        || Math.max(500, Math.min(5000, messages.length || 0));
    try {
        await executeInternalTool('memory', {
            action: 'ingest_session',
            sessionId,
            messages,
            cwd: session?.cwd,
            limit: hydrateLimit,
        }, callerCtx);
    } catch (err) {
        try { process.stderr.write(`[session] recall-fasttrack ingest skipped (sess=${sessionId}): ${err?.message || err}\n`); } catch {}
    }
    const dumpArgs = {
        action: 'dump_session_roots',
        sessionId,
        includeRaw: true,
        limit: positiveContextWindow(session?.compaction?.recallChunkLimit ?? session?.compaction?.recallLimit) || hydrateLimit,
    };
    const runTool = (name, args) => executeInternalTool(name, args, callerCtx);
    let recallText = await executeInternalTool('memory', dumpArgs, callerCtx);
    let cycle1Text = '';
    const hasRawRows = /(?:^|\n)# raw_pending\s+\d+\s+id=/i.test(String(recallText || ''));
    if (hasRawRows) {
        try {
            // Drain this session's cycle1 in window×concurrency units until no
            // raw rows remain, so the injected root is fully chunked rather than
            // carrying the unprocessed transcript tail (single-pass left raw in).
            const drained = await drainSessionCycle1(runTool, {
                sessionId,
                dumpArgs,
                deadlineMs: positiveContextWindow(session?.compaction?.recallCycle1DeadlineMs) || 120_000,
                maxPasses: positiveContextWindow(session?.compaction?.recallCycle1MaxPasses) || 0,
                cycleArgs: {
                    min_batch: 1,
                    session_cap: 1,
                    batch_size: positiveContextWindow(session?.compaction?.recallCycle1BatchSize) || 100,
                    rows_per_session: positiveContextWindow(session?.compaction?.recallRowsPerSession) || 100,
                    window_size: positiveContextWindow(session?.compaction?.recallWindowSize) || 20,
                    concurrency: positiveContextWindow(session?.compaction?.recallConcurrency) || 5,
                },
            });
            recallText = drained.recallText;
            cycle1Text = drained.cycle1Text;
            if (drained.rawRemaining > 0) {
                try { process.stderr.write(`[session] recall-fasttrack drained passes=${drained.passes} rawRemaining=${drained.rawRemaining} (sess=${sessionId})\n`); } catch {}
            }
        } catch (err) {
            try { process.stderr.write(`[session] recall-fasttrack cycle1 skipped (sess=${sessionId}): ${err?.message || err}\n`); } catch {}
        }
    } else {
        cycle1Text = 'cycle1: skipped (session chunks already hydrated)';
    }
    return { query, querySha, recallText: [`session_id=${sessionId}`, cycle1Text, recallText].map(v => String(v || '').trim()).filter(Boolean).join('\n\n') };
}
async function runSessionCompaction(session, opts = {}) {
    if (!session || session.closed === true) return null;
    const mode = opts.mode === 'auto' ? 'auto' : 'manual';
    const force = opts.force === true || mode === 'manual';
    if (mode === 'auto' && session.compaction?.auto === false) return null;
    const messages = Array.isArray(session.messages) ? session.messages : [];
    if (messages.length < 3 && !force) return null;
    const boundary = positiveContextWindow(session.compactBoundaryTokens)
        || positiveContextWindow(session.autoCompactTokenLimit)
        || positiveContextWindow(session.contextWindow);
    if (!boundary) {
        if (force) throw new Error('compact: no context window is available for this session');
        return null;
    }
    const reserveTokens = estimateRequestReserveTokens(session.tools || []);
    const beforeMessageTokens = estimateMessagesTokens(messages);
    const lastContextTokens = positiveContextWindow(session.lastContextTokens) || 0;
    const triggerTokens = compactTriggerForSession(session, boundary)
        || positiveContextWindow(session.compaction?.triggerTokens)
        || boundary;
    const bufferTokens = Math.max(0, boundary - triggerTokens);
    const bufferRatio = boundary ? (bufferTokens / boundary) : compactBufferRatioForSession(session);
    const pressureTokens = Math.max(beforeMessageTokens + reserveTokens, lastContextTokens);
    const beforeTokens = pressureTokens;
    const compactType = compactTypeForSession(session);
    if (!force && pressureTokens < triggerTokens) return {
        changed: false,
        reason: 'below threshold',
        compactType,
        beforeMessages: messages.length,
        afterMessages: messages.length,
        beforeTokens,
        afterTokens: beforeTokens,
        beforeMessageTokens,
        afterMessageTokens: beforeMessageTokens,
        pressureTokens,
        triggerTokens,
        bufferTokens,
        bufferRatio,
        boundaryTokens: boundary,
        budgetTokens: boundary,
        targetBudgetTokens: boundary,
        reserveTokens,
        semanticCompact: false,
    };
    const budgetSourceTokens = force ? Math.max(pressureTokens, triggerTokens) : pressureTokens;
    const compactBudget = compactTargetBudget(boundary, reserveTokens, budgetSourceTokens);
    const budget = compactBudget || boundary;
    try { opts.onStageChange?.('compacting'); } catch { /* best-effort */ }
    const provider = opts.provider || getProvider(session.provider) || null;
    let compacted;
    let compactError = null;
    let semanticCompactResult = null;
    let semanticCompactError = null;
    let recallFastTrackResult = null;
    let recallFastTrackError = null;
    if (compactTypeIsRecallFastTrack(compactType)) {
        try {
            const recallPayload = await runRecallFastTrackForSession(session, messages, opts);
            recallFastTrackResult = recallFastTrackCompactMessages(messages, budget, {
                reserveTokens,
                force: true,
                recallText: recallPayload.recallText,
                query: recallPayload.query,
                querySha: recallPayload.querySha,
                allowEmptyRecall: true,
                tailTurns: positiveContextWindow(session.compaction?.tailTurns) || 2,
                keepTokens: positiveContextWindow(session.compaction?.keepTokens ?? session.compaction?.keep?.tokens),
                preserveRecentTokens: positiveContextWindow(session.compaction?.preserveRecentTokens),
            });
            if (Array.isArray(recallFastTrackResult?.messages)) {
                compacted = recallFastTrackResult.messages;
            }
        } catch (err) {
            recallFastTrackError = err;
            compactError = err;
            try {
                process.stderr.write(`[session] recall-fasttrack ${mode} compact failed (sess=${session.id || 'unknown'}): ${err?.message || err}\n`);
            } catch { /* best-effort */ }
        }
    } else if (compactTypeIsSemantic(compactType)) {
        try {
            if (!semanticCompactionEnabledForSession(session)) {
                throw new Error('semantic compact is disabled for this session');
            }
            if (!provider || typeof provider.send !== 'function') {
                throw new Error(`semantic compact provider unavailable: ${session.provider || 'unknown'}`);
            }
            semanticCompactResult = await semanticCompactMessages(
                provider,
                messages,
                opts.model || session.model,
                budget,
                {
                    reserveTokens,
                    providerName: session.provider || provider?.name || null,
                    sessionId: opts.sessionId || session.id || null,
                    signal: opts.signal || null,
                    promptCacheKey: session.promptCacheKey || null,
                    providerCacheKey: session.promptCacheKey || null,
                    timeoutMs: positiveContextWindow(session.compaction?.timeoutMs) || 30_000,
                    tailTurns: positiveContextWindow(session.compaction?.tailTurns) || 2,
                    keepTokens: positiveContextWindow(session.compaction?.keepTokens ?? session.compaction?.keep?.tokens),
                    preserveRecentTokens: positiveContextWindow(session.compaction?.preserveRecentTokens),
                    force: true,
                },
            );
            if (Array.isArray(semanticCompactResult?.messages)) {
                compacted = semanticCompactResult.messages;
                addCompactUsageToSession(session, semanticCompactResult.usage);
            }
        } catch (err) {
            semanticCompactError = err;
            compactError = err;
            try {
                process.stderr.write(`[session] semantic ${mode} compact failed (sess=${session.id || 'unknown'}): ${err?.message || err}\n`);
            } catch { /* best-effort */ }
        }
    }
    if (!compacted && !compactError) {
        compactError = new Error(`${compactType} compact produced no messages`);
    }
    if (!compacted) {
        const now = Date.now();
        session.compaction = {
            ...(session.compaction || {}),
            auto: mode === 'auto' ? true : session.compaction?.auto !== false,
            boundaryTokens: boundary,
            triggerTokens,
            bufferTokens,
            bufferRatio,
            reserveTokens,
            lastStage: mode === 'auto' ? 'post_turn_failed' : 'manual_failed',
            lastBeforeTokens: beforeTokens,
            lastAfterTokens: beforeTokens,
            lastBeforeMessageTokens: beforeMessageTokens,
            lastAfterMessageTokens: beforeMessageTokens,
            lastPressureTokens: pressureTokens,
            lastCheckedAt: now,
            lastChanged: false,
            type: compactType,
            compactType,
            lastCompactType: compactType,
            lastSemantic: false,
            lastSemanticError: semanticCompactError?.message || null,
            lastRecallFastTrack: false,
            lastRecallFastTrackError: recallFastTrackError?.message || null,
            lastError: compactError?.message || semanticCompactError?.message || recallFastTrackError?.message || String(compactError || semanticCompactError || recallFastTrackError || 'compact failed'),
        };
        return {
            changed: false,
            error: session.compaction.lastError,
            compactType,
            beforeMessages: messages.length,
            afterMessages: messages.length,
            beforeTokens,
            afterTokens: beforeTokens,
            beforeMessageTokens,
            afterMessageTokens: beforeMessageTokens,
            pressureTokens,
            triggerTokens,
            bufferTokens,
            bufferRatio,
            boundaryTokens: boundary,
            budgetTokens: boundary,
            targetBudgetTokens: budget,
            reserveTokens,
            semanticCompact: false,
            semanticError: semanticCompactError?.message || null,
            recallFastTrack: false,
            recallFastTrackError: recallFastTrackError?.message || null,
        };
    }
    let beforeEncoded = '';
    let afterEncoded = '';
    try { beforeEncoded = JSON.stringify(messages); } catch { beforeEncoded = ''; }
    try { afterEncoded = JSON.stringify(compacted); } catch { afterEncoded = ''; }
    const afterMessageTokens = estimateMessagesTokens(compacted);
    const afterTokens = afterMessageTokens + reserveTokens;
    const changed = beforeEncoded && afterEncoded
        ? beforeEncoded !== afterEncoded
        : (compacted.length !== messages.length || afterMessageTokens !== beforeMessageTokens);
    const unchangedReason = changed ? null : (force ? 'nothing to compact' : 'below threshold');
    const now = Date.now();
    session.messages = compacted;
    session.providerState = undefined;
    session.compaction = {
        ...(session.compaction || {}),
        auto: mode === 'auto' ? true : session.compaction?.auto !== false,
        boundaryTokens: boundary,
        triggerTokens,
        bufferTokens,
        bufferRatio,
        reserveTokens,
        type: compactType,
        compactType,
        lastCompactType: compactType,
        lastStage: mode === 'auto' ? 'post_turn' : 'manual',
        lastBeforeTokens: beforeTokens,
        lastAfterTokens: afterTokens,
        lastBeforeMessageTokens: beforeMessageTokens,
        lastAfterMessageTokens: afterMessageTokens,
        lastPressureTokens: pressureTokens,
        lastCheckedAt: now,
        lastChanged: changed,
        lastChangedAt: changed ? now : session.compaction?.lastChangedAt || null,
        lastCompactAt: changed ? now : session.compaction?.lastCompactAt || null,
        lastSemantic: semanticCompactResult?.semantic === true,
        lastSemanticError: semanticCompactError?.message || null,
        lastRecallFastTrack: recallFastTrackResult?.recallFastTrack === true,
        lastRecallFastTrackError: recallFastTrackError?.message || null,
        lastRecallFastTrackQuerySha: recallFastTrackResult?.query ? createHash('sha256').update(recallFastTrackResult.query).digest('hex').slice(0, 16) : null,
        lastSemanticUsage: semanticCompactResult?.usage ? {
            inputTokens: semanticCompactResult.usage.inputTokens || 0,
            outputTokens: semanticCompactResult.usage.outputTokens || 0,
            cachedTokens: semanticCompactResult.usage.cachedTokens || 0,
            cacheWriteTokens: semanticCompactResult.usage.cacheWriteTokens || 0,
        } : null,
        compactCount: (session.compaction?.compactCount || 0) + (changed ? 1 : 0),
    };
    if (changed && mode === 'auto') session.lastContextTokensStaleAfterCompact = true;
    return {
        changed,
        reason: unchangedReason,
        compactType,
        beforeMessages: messages.length,
        afterMessages: compacted.length,
        beforeTokens,
        afterTokens,
        beforeMessageTokens,
        afterMessageTokens,
        pressureTokens,
        triggerTokens,
        bufferTokens,
        bufferRatio,
        boundaryTokens: boundary,
        budgetTokens: boundary,
        targetBudgetTokens: budget,
        reserveTokens,
        semanticCompact: semanticCompactResult?.semantic === true,
        semanticError: semanticCompactError?.message || null,
        recallFastTrack: recallFastTrackResult?.recallFastTrack === true,
        recallFastTrackError: recallFastTrackError?.message || null,
        usage: semanticCompactResult?.usage || null,
    };
}
// Provider-scoped unified cache key. Goal: all orchestrator-internal
// dispatches (agent/maintenance/mcp/scheduler/webhook) targeting the
// same provider land in a single server-side cache shard, so the
// shared prefix (tools + system + pool system prompt) is reused
// regardless of role. Per-role / per-session differentiation lives after the
// system prefix (BP3 sessionMarker system block / later messages), which is
// naturally separated by provider-side content hashing.
const PROVIDER_ALIAS = {
    'openai-oauth': 'codex',      // ChatGPT subscription (OpenAI OAuth backend)
    'anthropic-oauth': 'claude',  // Claude Max subscription
    'openai': 'openai',
    'anthropic': 'anthropic',
    'gemini': 'gemini',
    'deepseek': 'deepseek',
    'xai': 'xai',
};
function providerCacheKey(provider, override) {
    if (override) return String(override);
    if (!provider) return 'mixdog-default';
    return `mixdog-${PROVIDER_ALIAS[provider] || provider}`;
}

// ── Prefetch permission guard ─────────────────────────────────────────────────
// Runs the shared permission evaluator for tool calls that originate in the
// prefetch path (outside the agent loop). Permission enforcement is disabled
// (the evaluator always returns allow), so this is effectively a pass-through
// kept for API compatibility. Returns an error string if blocked, or null.
const _permEvalForPrefetch = (() => {
    const _req = createRequire(import.meta.url);
    try {
        const { dirname: _pdir, resolve: _pres } = _req('path');
        const _hooksLib = _pres(_pdir(fileURLToPath(import.meta.url)), '../../../../hooks/lib/permission-evaluator.cjs');
        return _req(_hooksLib).evaluatePermission;
    } catch { return null; }
})();
function _guardedPrefetchTool(toolName, toolArgs, session) {
    if (!_permEvalForPrefetch) return null;
    // When no explicit mode is attached to the session, run the evaluator
    // under 'default'. The evaluator now always allows, so this never blocks.
    const permissionMode = session?.permissionMode || 'default';
    const projectDir = session?.cwd || undefined;
    const userCwd = session?.cwd || undefined;
    const MCP_PFX = 'mcp__plugin_mixdog_mixdog__';
    const fullName = toolName.startsWith(MCP_PFX) || toolName.startsWith('mcp__') ? toolName : `${MCP_PFX}${toolName}`;
    try {
        const { decision, reason } = _permEvalForPrefetch({ toolName: fullName, toolInput: toolArgs || {}, permissionMode, projectDir, userCwd });
        if (decision === 'deny' || decision === 'ask') {
            return `Error: prefetch tool "${toolName}" blocked (decision=${decision}): ${reason}`;
        }
    } catch (e) {
        process.stderr.write(`[prefetch-guard] evaluator error: ${e?.message}\n`);
    }
    return null;
}

async function _tryBridgeExplicitPrefetch(session, explicitPrefetch) {
    if (!explicitPrefetch || typeof explicitPrefetch !== 'object') return null;
    if (!isAgentOwner(session)) return null;
    const parts = [];
    const failed = [];
    const totalEntries = [];
    // files[] — string entries use the default head excerpt; object entries
    // {path, n?, full?} let the caller widen the window or pull the full file
    // so worker doesn't have to re-read deep ranges of an already-prefetched
    // file (a recurring iter burner observed in baseline session telemetry).
    const _rawFilesIn = Array.isArray(explicitPrefetch.files) ? explicitPrefetch.files : [];
    const _readOptsByFile = new Map();
    const files = [];
    const _seenFiles = new Set();
    const _addPrefetchFile = (file, opts = null) => {
        if (typeof file !== 'string' || !file) return;
        if (!_seenFiles.has(file)) {
            _seenFiles.add(file);
            files.push(file);
        }
        if (!opts || Object.keys(opts).length === 0) return;
        const prev = _readOptsByFile.get(file) || {};
        const merged = { ...prev };
        if (opts.mode === 'full') {
            merged.mode = 'full';
            delete merged.n;
        } else if (merged.mode !== 'full' && Number.isFinite(opts.n) && opts.n > 0) {
            merged.n = Math.max(Number(merged.n) || 0, opts.n);
        }
        if (Object.keys(merged).length > 0) _readOptsByFile.set(file, merged);
    };
    for (const entry of _rawFilesIn) {
        if (typeof entry === 'string' && entry) {
            _addPrefetchFile(entry);
        } else if (entry && typeof entry === 'object' && typeof entry.path === 'string' && entry.path) {
            const opts = {};
            if (entry.full === true) opts.mode = 'full';
            else if (Number.isFinite(entry.n) && entry.n > 0) opts.n = entry.n;
            _addPrefetchFile(entry.path, opts);
        }
    }
    if (files.length > 0) {
        const _pfGuard = _guardedPrefetchTool('read', { path: files }, session);
        if (_pfGuard) {
            process.stderr.write(`[agent-prefetch] files read blocked: ${_pfGuard}\n`);
            failed.push(...files);
            totalEntries.push(...files);
        } else {
        totalEntries.push(...files);
        // R20: per-file prefetch cache (cross-dispatch, process-local).
        // Try each file from cache first; batch misses into one disk read.
        const { resolve: _pfResolve, isAbsolute: _pfIsAbs, normalize: _pfNorm } = await import('path');
        const _pfCwd = session.cwd || null;
        function _pfAbsPath(f) {
            const abs = _pfIsAbs(f) ? f : _pfResolve(_pfCwd || process.cwd(), f);
            return _pfNorm(abs);
        }
        const fileHits = [];   // { file, abs, content } — satisfied from cache
        const fileMisses = []; // { file, abs } — need disk read
        for (const f of files) {
            const abs = _pfAbsPath(f);
            // Skip the cross-dispatch cache when the caller asked for a
            // non-default window (custom n or full-file). Cache key is the
            // path alone, so a default-window cache hit would silently feed
            // the wrong slice back to the next caller.
            const hit = _readOptsByFile.has(f) ? null : tryPrefetchCached(abs);
            if (hit) {
                fileHits.push({ file: f, abs, content: hit.content });
            } else {
                fileMisses.push({ file: f, abs });
            }
        }
        // Disk read for misses (single batch call).
        const missFiles = fileMisses.map(m => m.file);
        const missResults = {}; // file → content string
        if (missFiles.length > 0) {
            // Read each miss file individually so we can cache per-file.
            // The files list is small (typically 2-5), so N awaits is fine.
            await Promise.all(missFiles.map(async (f) => {
                const opts = _readOptsByFile.get(f) || {};
                const readArgs = { path: f };
                if (opts.mode === 'full') {
                    readArgs.mode = 'full';
                } else {
                    readArgs.mode = 'head';
                    readArgs.n = Number.isFinite(opts.n) ? opts.n : 120;
                }
                const out = await executeInternalTool('read', readArgs).catch((e) => {
                    process.stderr.write(`[agent-prefetch] file read failed (${f}): ${e && e.message || e}\n`);
                    return null;
                });
                if (out !== null) {
                    missResults[f] = String(out);
                }
            }));
            // Cache successful miss results.
            for (const { file, abs } of fileMisses) {
                const content = missResults[file];
                if (content && classifyResultKind(content) !== 'error') {
                    // Only cache default-window reads; custom-window results
                    // would poison the shared cross-dispatch cache.
                    if (!_readOptsByFile.has(file)) setPrefetchCached(abs, content);
                } else if (content === undefined || classifyResultKind(content) === 'error') {
                    failed.push(file);
                }
            }
        }
        // Assemble combined output preserving original file order.
        const readParts = [];
        const hitByFile = new Map(fileHits.map((h) => [h.file, h]));
        for (const f of files) {
            const hitEntry = hitByFile.get(f);
            if (hitEntry) {
                readParts.push(hitEntry.content);
                continue;
            }
            const content = missResults[f];
            if (content && classifyResultKind(content) !== 'error') {
                readParts.push(content);
            }
            // else: already pushed to failed above
        }
        if (readParts.length > 0) {
            parts.push(`### prefetch files\nread ${readParts.length}\n\n${readParts.join('\n\n')}`);
        }
        // Log hit/miss counters so dispatch telemetry shows prefetch effectiveness.
        if (process.env.MIXDOG_DEBUG_SESSION_LOG) {
            process.stderr.write(
                `[prefetch] files=${files.length} cached=${fileHits.length} miss=${fileMisses.length} failed=${failed.length}\n`
            );
        }
        // Attach stats to session so post-hoc analyzers (inspect-session.mjs)
        // can see prefetch effectiveness without parsing stderr logs.
        if (session && typeof session === 'object') {
            if (!session.prefetchStats) session.prefetchStats = { files: 0, cached: 0, miss: 0, failed: 0 };
            session.prefetchStats.files += files.length;
            session.prefetchStats.cached += fileHits.length;
            session.prefetchStats.miss += fileMisses.length;
            session.prefetchStats.failed += failed.length;
        }
        }
    }
    // callers[]
    const callers = Array.isArray(explicitPrefetch.callers) ? explicitPrefetch.callers.filter(c => c && typeof c.symbol === 'string') : [];
    {
        const callerTasks = callers.map(({ symbol, file }) => {
            const cgArgs = { mode: 'callers', symbol };
            if (file) cgArgs.file = file;
            if (session?.cwd) cgArgs.cwd = session.cwd;
            totalEntries.push(symbol);
            const blocked = _guardedPrefetchTool('code_graph', cgArgs, session);
            if (blocked) {
                process.stderr.write(`[agent-prefetch] callers(${symbol}) blocked: ${blocked}\n`);
                return Promise.resolve({ symbol, out: null, blocked: true });
            }
            return _executeCodeGraphToolLazy('code_graph', cgArgs, session?.cwd)
                .then(out => ({ symbol, out }))
                .catch(e => {
                    process.stderr.write(`[agent-prefetch] callers(${symbol}) failed: ${e && e.message || e}\n`);
                    return { symbol, out: null };
                });
        });
        const callerResults = await Promise.allSettled(callerTasks);
        for (const r of callerResults) {
            const { symbol, out, blocked } = r.status === 'fulfilled' ? r.value : { symbol: '?', out: null };
            if (blocked) { failed.push(symbol); continue; }
            if (out && classifyResultKind(String(out)) !== 'error') {
                parts.push(`### prefetch callers ${symbol}\n${out}`);
            } else {
                failed.push(symbol);
            }
        }
    }
    // references[]
    const references = Array.isArray(explicitPrefetch.references) ? explicitPrefetch.references.filter(r => r && typeof r.symbol === 'string') : [];
    {
        const refTasks = references.map(({ symbol, file }) => {
            const cgArgs = { mode: 'references', symbol };
            if (file) cgArgs.file = file;
            if (session?.cwd) cgArgs.cwd = session.cwd;
            totalEntries.push(symbol);
            const blocked = _guardedPrefetchTool('code_graph', cgArgs, session);
            if (blocked) {
                process.stderr.write(`[agent-prefetch] references(${symbol}) blocked: ${blocked}\n`);
                return Promise.resolve({ symbol, out: null, blocked: true });
            }
            return _executeCodeGraphToolLazy('code_graph', cgArgs, session?.cwd)
                .then(out => ({ symbol, out }))
                .catch(e => {
                    process.stderr.write(`[agent-prefetch] references(${symbol}) failed: ${e && e.message || e}\n`);
                    return { symbol, out: null };
                });
        });
        const refResults = await Promise.allSettled(refTasks);
        for (const r of refResults) {
            const { symbol, out, blocked } = r.status === 'fulfilled' ? r.value : { symbol: '?', out: null };
            if (blocked) { failed.push(symbol); continue; }
            if (out && classifyResultKind(String(out)) !== 'error') {
                parts.push(`### prefetch references ${symbol}\n${out}`);
            } else {
                failed.push(symbol);
            }
        }
    }
    if (session && typeof session === 'object' && (callers.length > 0 || references.length > 0)) {
        if (!session.prefetchStats) session.prefetchStats = { files: 0, cached: 0, miss: 0, failed: 0, callers: 0, references: 0 };
        session.prefetchStats.callers = (session.prefetchStats.callers || 0) + callers.length;
        session.prefetchStats.references = (session.prefetchStats.references || 0) + references.length;
    }
    if (parts.length === 0) {
        // All entries failed but Lead presence must still be signalled — emit
        // warn-only so the gate logic can distinguish "prefetch was requested"
        // from "no prefetch at all".
        if (totalEntries.length > 0 && failed.length > 0) {
            return `<prefetch-warn>${failed.length} of ${totalEntries.length} prefetch entries failed: ${[...new Set(failed)].join(', ')}</prefetch-warn>`;
        }
        return null;
    }
    const warnLine = failed.length > 0
        ? `<prefetch-warn>${failed.length} of ${totalEntries.length} prefetch entries failed: ${[...new Set(failed)].join(', ')}</prefetch-warn>\n`
        : '';
    return `${warnLine}<prefetch>\n${parts.join('\n\n')}\n</prefetch>`;
}

// --- agent spawn (createSession) ---
// opts can pass either a `preset` object (from config.presets) or raw provider/model.
// Preset shape: { name, provider, model, effort?, fast?, tools? }
//
// Agent Runtime integration:
//   opts.taskType / opts.role / opts.profileId — enables profile-aware routing.
//     Rule-based SmartRouter resolves these synchronously; the resolved
//     profile controls context filtering (skip.skills/memory/etc) and cache
//     strategy. If no rule matches, falls back to classic preset behavior.
//   opts.profile — pre-resolved profile (bypasses router; used by async
//     callers who already ran AgentRuntime.resolve()).
//   opts.providerCacheOpts — pre-resolved cache options merged into ask() sendOpts.
export function createSession(opts) {
    const presetObj = opts.preset && typeof opts.preset === 'object' ? opts.preset : null;

    // --- Agent Runtime profile resolution (best-effort, sync) ---
    let profile = opts.profile || null;
    let providerCacheOpts = opts.providerCacheOpts || null;
    if (!profile && (opts.taskType || opts.role || opts.profileId)) {
        const agentRuntime = getAgentRuntimeSync();
        if (agentRuntime) {
            try {
                const resolved = agentRuntime.resolveSync({
                    taskType: opts.taskType,
                    role: opts.role,
                    profileId: opts.profileId,
                    preset: presetObj?.name || (typeof opts.preset === 'string' ? opts.preset : null),
                    provider: opts.provider || presetObj?.provider,
                });
                if (resolved) {
                    profile = resolved.profile;
                    providerCacheOpts = resolved.providerCacheOpts;
                }
            } catch (e) {
                // Agent Runtime error — log once, fall back to classic behavior.
                if (!_agentRuntimeWarned) {
                    _agentRuntimeWarned = true;
                    process.stderr.write(`[session] agent runtime resolve failed: ${e.message}\n`);
                }
            }
        }
    }

    const providerName = opts.provider || presetObj?.provider
        || (profile?.preferredProviders?.[0]);
    const modelName = opts.model || presetObj?.model;
    // opts.tools (caller-supplied) wins over presetObj.tools — caller
    // intent ('tools:readonly' from Pool C, etc.) must override the
    // preset's default 'full'. Previous priority let HAIKU's tools='full'
    // shadow Pool C's explicit readonly request, leaking write tools and
    // bash into a read-only agent.
    const toolPreset = opts.tools || presetObj?.tools || (typeof opts.preset === 'string' ? opts.preset : null) || 'full';
    const effort = Object.prototype.hasOwnProperty.call(opts, 'effort')
        ? (opts.effort || null)
        : (presetObj?.effort || null);
    const fast = presetObj?.fast === true || opts.fast === true;
    if (!providerName)
        throw new Error('createSession: provider is required');
    if (!modelName)
        throw new Error('createSession: model is required');
    const provider = getProvider(providerName);
    if (!provider)
        throw new Error(`Provider "${providerName}" not found or not enabled`);
    const id = `sess_${process.pid}_${nextId++}_${Date.now()}_${randomBytes(16).toString('hex')}`;
    const messages = [];
    const ownerIsAgent = isAgentOwner(opts.owner);
    const resolvedRole = opts.role || profile?.taskType || null;
    const hiddenRole = getHiddenRole(resolvedRole);
    const isRetrievalRole = hiddenRole?.kind === 'retrieval';
    // Skill schema is fixed; the compact manifest is discovered once through
    // the mtime-cached frontmatter index so BP1 tells every role which Skill()
    // names are available without loading full SKILL.md bodies.
    const skills = opts.skipSkills ? [] : collectSkillsCached(opts.cwd);

    // BP1 is shared tool policy (+ compact skill manifest in compose). BP2 is
    // role/system rules. User-defined schedules/webhooks ride as normal user
    // context below so event data does not rewrite BP3 memory/meta.
    const agentRulesRole = opts.role || profile?.taskType || null;
    const agentRulesProfile = isRetrievalRole ? 'retrieval' : 'full';
    const skipAgentRules = opts.skipAgentRules === true;
    const injectedRules = skipAgentRules ? '' : _buildSharedRules();
    const roleRules = skipAgentRules ? '' : (ownerIsAgent ? _buildAgentRules(agentRulesProfile) : _buildLeadRules());
    const metaContext = skipAgentRules ? '' : (ownerIsAgent ? '' : _buildLeadMetaContext());
    const roleSpecific = ownerIsAgent && !skipAgentRules ? _buildRoleSpecific(agentRulesRole) : '';
    // Agent sessions must not inherit role/profile/preset tool narrowing: Pool
    // B and Pool C share one bit-identical tool schema to maximize provider
    // prefix reuse, and permission differences are enforced only at call time. Raw
    // non-agent callers keep the historical profile.tools / preset.tools
    // behaviour.
    const toolSpec = ownerIsAgent
        ? 'full'
        : (Array.isArray(profile?.tools) ? profile.tools : toolPreset);

    // Prompt permission is metadata only. Preset tool restrictions must NOT
    // enter the prompt, or they split the shared agent cache tail; they map
    // to toolPermission below and are enforced only at call time.
    const permission = opts.permission
        || null;
    const toolPermission = opts.permission
        || profile?.permission
        || permissionFromToolSpec(toolPreset)
        || null;
    let toolsForRouting = resolveSessionTools(toolSpec, skills, { ownerIsAgentSession: ownerIsAgent });
    // Fail-closed permission intersection: when a session declares an explicit
    // object-form permission, intersect the
    // resolved tool list with the permission's allow/deny lists. If the
    // intersection produces an empty set the permission config is broken —
    // fail closed (zero tools) rather than silently falling back to the full
    // preset, which would grant the role more surface than declared.
    if (toolPermission === 'none') {
        toolsForRouting = [];
    } else if (toolPermission && typeof toolPermission === 'object') {
        const allowSet = Array.isArray(toolPermission.allow) && toolPermission.allow.length > 0
            ? new Set(toolPermission.allow.map(n => String(n).toLowerCase()))
            : null;
        const denySet = Array.isArray(toolPermission.deny) && toolPermission.deny.length > 0
            ? new Set(toolPermission.deny.map(n => String(n).toLowerCase()))
            : null;
        if (allowSet || denySet) {
            const filtered = toolsForRouting.filter(t => {
                const name = String(t?.name || '').toLowerCase();
                if (denySet && denySet.has(name)) return false;
                if (allowSet && !allowSet.has(name)) return false;
                return true;
            });
            // Fail-closed: an empty intersection means the permission config is
            // misconfigured — do not silently fall back to the full preset.
            toolsForRouting = filtered;
            if (filtered.length === 0) {
                process.stderr.write(`[session] WARN: role permission intersection produced 0 tools — failing closed (role=${opts.role || 'unknown'})
`);
            }
        }
    }

    const { baseRules, stableSystemContext, sessionMarker, volatileTail } = composeSystemPrompt({
        userPrompt: opts.systemPrompt,
        agentRules: injectedRules || undefined,
        roleRules: roleRules || undefined,
        metaContext: metaContext || undefined,
        skipRoleCatalog: !ownerIsAgent,
        profile: profile || undefined,
        role: resolvedRole,
        workflowContext: opts.workflowContext || null,
        workspaceContext: opts.workspaceContext || null,
        coreMemoryContext: opts.coreMemoryContext || null,
        skillManifest: buildSkillManifest(skills),
        tools: toolsForRouting,
        bashIsPersistent: ownerIsAgent && toolsForRouting.some(t => t?.name === 'shell'),
        // Effective cwd rides in tier3Reminder so explore-like tools know
        // their search root without needing to shove "Override cwd:" into
        // the user message body (that used to fragment the shard prefix).
        cwd: opts.cwd || null,
        provider: providerName || null,
    });
    // 4-BP layout (see composeSystemPrompt docs):
    //   system block #1 = baseRules — BP1 (1h) shared tool policy + skills
    //   system block #2 = stableSystemContext — BP2 (1h) role/system rules
    //   system block #3 = sessionMarker — BP3 (1h) memory/meta + Profile
    //     Preferences (language/name). It rides as a real `system` block so
    //     locale/name directives are pinned firmly and do not drift to English
    //     after a few turns the way a `user <system-reminder>` reminder did.
    //   later normal messages        = BP4/tail (task, role data, tool history)
    // Anthropic multi-block system pins each block with cache_control (BP3 is
    // the 3rd system block and carries the tier3 1h marker). OpenAI/xAI get
    // stable provider cache keys/session prefixes. Gemini manages explicit
    // cachedContents inside its provider.
    if (baseRules) {
        messages.push({ role: 'system', content: baseRules });
    }
    if (stableSystemContext) {
        messages.push({ role: 'system', content: stableSystemContext });
    }
    if (sessionMarker) {
        // cacheTier:'tier3' tells the Anthropic providers to pin THIS system
        // block with the tier3 1h cache_control (BP3) — distinct from the
        // BP1/BP2 system TTL. Harmless on non-Anthropic providers (they ignore
        // the field and serialize content as a normal system instruction).
        messages.push({ role: 'system', content: sessionMarker, cacheTier: 'tier3' });
    }
    if (volatileTail) {
        messages.push({ role: 'user', content: `<system-reminder>\n${volatileTail}\n</system-reminder>` });
        messages.push({ role: 'assistant', content: '.' });
    }
    if (roleSpecific) {
        messages.push({ role: 'user', content: `<system-reminder>\n${roleSpecific}\n</system-reminder>` });
        messages.push({ role: 'assistant', content: '.' });
    }
    if (opts.files?.length) {
        const fileContext = opts.files
            .map(f => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
            .join('\n\n');
        messages.push({ role: 'user', content: `Reference files:\n\n${fileContext}` });
        messages.push({ role: 'assistant', content: '.' });
    }
    let tools = toolsForRouting;

    // Schema filtering applied after schema build:
    //   - opts.schemaAllowedTools : declarative hidden-role schema profile
    //     allowlist for tiny specialist roles where one-shot tool routing
    //     beats the shared-schema cache win.
    //   - opts.disallowedTools : per-call caller override (Anthropic
    //     BuiltInAgentDefinition pattern)
    //   - annotations.agentHidden : declarative per-tool flag (tools.json
    //     and internal tool defs). Pool A (Lead) still sees all tools.
    //
    const hasCallerAllow = Array.isArray(opts.schemaAllowedTools);
    const callerAllow = hasCallerAllow ? opts.schemaAllowedTools.map(n => String(n).toLowerCase()) : [];
    if (hasCallerAllow) {
        const allowSet = new Set(callerAllow);
        const before = tools.length;
        tools = tools.filter(t => allowSet.has(String(t?.name || '').toLowerCase()));
        if (tools.length !== before && process.env.MIXDOG_DEBUG_SESSION_LOG) {
            process.stderr.write(`[session] schemaAllowedTools=${callerAllow.join(',')} kept ${tools.length}/${before} tools\n`);
        }
    }
    const callerDeny = Array.isArray(opts.disallowedTools) ? opts.disallowedTools.map(n => String(n)) : [];
    if (callerDeny.length) {
        const denySet = new Set(callerDeny);
        const before = tools.length;
        tools = tools.filter(t => !denySet.has(String(t?.name || '').toLowerCase()));
        if (tools.length !== before && process.env.MIXDOG_DEBUG_SESSION_LOG) {
            process.stderr.write(`[session] disallowedTools=${callerDeny.join(',')} stripped ${before - tools.length} tools\n`);
        }
    }
    if (ownerIsAgent) {
        const before = tools.length;
        tools = tools.filter(t => !t?.annotations?.agentHidden);
        if (tools.length !== before && process.env.MIXDOG_DEBUG_SESSION_LOG) {
            process.stderr.write(`[session] agentHidden stripped ${before - tools.length} tools\n`);
        }
    }

    // Agent tool canonicalization: keep route-sensitive tools in policy order
    // while preserving deterministic MCP/skill order for BP1 shard stability.
    if (ownerIsAgent) {
        tools = orderSessionTools(tools);
    }

    // Unified-shard policy — no broad role-specific schema filter. Keep
    // agent schemas shared unless a hidden-role schema profile explicitly
    // passes schemaAllowedTools for a small specialist; broad role
    // whitelists would fragment the cache shard.
    if (resolvedRole && process.env.MIXDOG_DEBUG_SESSION_LOG) {
        process.stderr.write(`[session] role=${resolvedRole} permission=${permission || 'full'} toolPermission=${toolPermission || 'full'} tools=${tools.length}\n`);
    }
    const contextMeta = resolveSessionContextMeta(provider, modelName);
    const workflowMeta = opts.workflow && typeof opts.workflow === 'object' && String(opts.workflow.id || '').trim()
        ? {
            id: String(opts.workflow.id || '').trim(),
            name: String(opts.workflow.name || opts.workflow.id || '').trim(),
            description: String(opts.workflow.description || '').trim(),
            source: String(opts.workflow.source || '').trim(),
        }
        : null;
    const session = {
        id,
        provider: providerName,
        model: modelName,
        messages,
        contextWindow: contextMeta.contextWindow,
        rawContextWindow: contextMeta.rawContextWindow,
        effectiveContextWindowPercent: contextMeta.effectiveContextWindowPercent,
        autoCompactTokenLimit: contextMeta.autoCompactTokenLimit,
        compactBoundaryTokens: contextMeta.compactBoundaryTokens,
        compaction: {
            auto: opts.compaction?.auto !== false,
            prune: opts.compaction?.prune === true,
            semantic: opts.compaction?.semantic ?? 'auto',
            type: normalizeCompactType(opts.compaction?.type ?? opts.compaction?.compactType ?? opts.compaction?.compact_type, DEFAULT_COMPACT_TYPE),
            compactType: normalizeCompactType(opts.compaction?.type ?? opts.compaction?.compactType ?? opts.compaction?.compact_type, DEFAULT_COMPACT_TYPE),
            model: opts.compaction?.model || null,
            timeoutMs: positiveContextWindow(opts.compaction?.timeoutMs),
            tailTurns: positiveContextWindow(opts.compaction?.tailTurns),
            bufferTokens: positiveContextWindow(opts.compaction?.bufferTokens ?? opts.compaction?.buffer),
            keepTokens: positiveContextWindow(opts.compaction?.keepTokens ?? opts.compaction?.keep?.tokens),
            preserveRecentTokens: positiveContextWindow(opts.compaction?.preserveRecentTokens),
            reservedTokens: positiveContextWindow(opts.compaction?.reservedTokens),
            recallIngestLimit: positiveContextWindow(opts.compaction?.recallIngestLimit),
            recallChunkLimit: positiveContextWindow(opts.compaction?.recallChunkLimit ?? opts.compaction?.recallLimit),
            recallCycle1BatchSize: positiveContextWindow(opts.compaction?.recallCycle1BatchSize),
            recallRowsPerSession: positiveContextWindow(opts.compaction?.recallRowsPerSession),
            recallWindowSize: positiveContextWindow(opts.compaction?.recallWindowSize),
            recallConcurrency: positiveContextWindow(opts.compaction?.recallConcurrency),
            recallCycle1DeadlineMs: positiveContextWindow(opts.compaction?.recallCycle1DeadlineMs),
            boundaryTokens: contextMeta.compactBoundaryTokens,
        },
        tools,
        preset: toolPreset,
        presetName: presetObj?.name || null,
        effort,
        fast,
        agent: opts.agent,
        owner: opts.owner || 'user',
        mcpPid: process.pid,
        scopeKey: opts.scopeKey || null,
        lane: opts.lane || 'agent',
        cwd: opts.cwd,
        workflow: workflowMeta,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastHeartbeatAt: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        // Refreshed on each completed ask() — surfaced by agent type=list for
        // debugging + consumed by store.mjs's idle-sweep to reclaim stalled
        // agent sessions past RUNNING_STALL_MS.
        lastUsedAt: Date.now(),
        tokensCumulative: 0,
        role: opts.role || null,
        taskType: opts.taskType || null,
        maxLoopIterations: Number.isFinite(opts.maxLoopIterations) ? opts.maxLoopIterations : null,
        // Agent tag (auto worker{n} on spawn) persisted so the forked status
        // process (statusline) + aggregator can read it from the session JSON.
        // In-process send/close still resolve via _tagSessionRegistry.
        agentTag: opts.agentTag || null,
        // Prompt permission is separate from runtime toolPermission so preset
        // restrictions do not fragment the agent cache prefix.
        permission: permission || null,
        toolPermission: toolPermission || null,
        // Origin tag written into every agent-trace usage row so analytics
        // can slice by (sourceType, sourceName) — e.g. maintenance/cycle1,
        // scheduler/daily-standup, webhook/github-push, lead/worker.
        sourceType: opts.sourceType || null,
        sourceName: opts.sourceName || null,
        // Provider-scoped unified cache key — one shard per provider,
        // shared across all roles / sources (agent/maintenance/mcp/
        // scheduler/webhook). Role or source-specific context must be
        // injected into the message tail, not the shared prefix.
        promptCacheKey: providerCacheKey(presetObj?.provider || opts.provider, opts.cacheKeyOverride),
        // Agent shell continuity: when an agent session explicitly opts into
        // persistent shell state (`bash` with `persistent:true`, or direct
        // `bash_session`), the minted bash_session id is stored here so later
        // opted-in `bash` calls can reuse the same shell state.
        implicitBashSessionId: null,
        // Tracks every persistent bash session id minted during this
        // orchestrator session so closeSession can kill them all, not just
        // the most recently recorded one.
        allBashSessionIds: [],
        // Agent Runtime metadata — optional. Applied on every ask() to merge
        // profile-driven cache settings into provider sendOpts.
        profileId: profile?.id || null,
        permissionMode: opts.permissionMode ?? null,
        providerCacheOpts: providerCacheOpts || null,
        ownerSessionId: opts.ownerSessionId || null,
        clientHostPid: opts.clientHostPid || null,
    };
    // In-process registry + async debounced save: same-process create → load
    // reads live memory; disk flush is for cross-process / restart durability.
    setLiveSession(session);
    saveSession(session);
    return session;
}

// ── Runtime liveness map ──────────────────────────────────────────────
// In-memory only. Tracks per-session stage + stream heartbeat so agent type=list
// can surface whether a session is actually alive vs stuck. Never persisted —
// heartbeats would otherwise churn the session JSON on every SSE delta.
// Entry shape: {
//   stage, lastStreamDeltaAt, lastToolCall, lastError, updatedAt,
//   controller?: AbortController,  // set while an ask is in flight
//   generation?: number,            // snapshot taken at ask start
//   closed?: boolean,               // flipped by closeSession()
// }
const _runtimeState = new Map();
const _toolActivityHeartbeats = new Map();
const VALID_STAGES = new Set([
    'connecting', 'requesting', 'streaming', 'tool_running', 'idle', 'error', 'done', 'cancelling',
]);
function _touchRuntime(id) {
    let entry = _runtimeState.get(id);
    if (!entry) {
        entry = { stage: 'idle', lastStreamDeltaAt: null, lastToolCall: null, lastError: null, updatedAt: Date.now() };
        _runtimeState.set(id, entry);
    }
    return entry;
}

function _stopToolActivityHeartbeat(id) {
    if (!id) return;
    const timer = _toolActivityHeartbeats.get(id);
    if (!timer) return;
    try { clearInterval(timer); } catch { /* ignore */ }
    _toolActivityHeartbeats.delete(id);
}

function _touchSessionActivityProgress(id) {
    const entry = _runtimeState.get(id);
    if (!entry || entry.closed || entry.controller?.signal?.aborted) return;
    if (entry.stage !== 'tool_running') return;
    const now = Date.now();
    entry.lastProgressAt = now;
    entry.updatedAt = now;
    publishHeartbeat(id, now);
}

function _startToolActivityHeartbeat(id) {
    _stopToolActivityHeartbeat(id);
    if (!(DEFAULT_ACTIVITY_HEARTBEAT_MS > 0)) return;
    const timer = setInterval(() => _touchSessionActivityProgress(id), DEFAULT_ACTIVITY_HEARTBEAT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    _toolActivityHeartbeats.set(id, timer);
}

export function updateSessionStage(id, stage) {
    if (!id || !VALID_STAGES.has(stage)) return;
    const entry = _touchRuntime(id);
    const now = Date.now();
    entry.stage = stage;
    if (stage === 'connecting' || stage === 'requesting') {
        entry.modelRequestStartedAt = now;
    }
    entry.lastProgressAt = now;
    entry.updatedAt = now;
    if (stage !== 'tool_running') _stopToolActivityHeartbeat(id);
}

export function updateSessionRoute(id, route = {}) {
    if (!id) return null;
    const session = loadSession(id);
    if (!session || session.closed === true) return null;
    const previousProvider = session.provider || null;
    const previousModel = session.model || null;
    if (route.provider) session.provider = route.provider;
    if (route.model) session.model = route.model;
    if (Object.prototype.hasOwnProperty.call(route, 'fast')) session.fast = route.fast === true;
    if (Object.prototype.hasOwnProperty.call(route, 'effort')) session.effort = route.effort || null;
    const provider = session.provider ? getProvider(session.provider) : null;
    if (provider && session.model) {
        const contextMeta = resolveSessionContextMeta(provider, session.model);
        session.contextWindow = contextMeta.contextWindow;
        session.rawContextWindow = contextMeta.rawContextWindow;
        session.effectiveContextWindowPercent = contextMeta.effectiveContextWindowPercent;
        session.autoCompactTokenLimit = contextMeta.autoCompactTokenLimit;
        session.compactBoundaryTokens = contextMeta.compactBoundaryTokens;
        session.compaction = {
            ...(session.compaction || {}),
            boundaryTokens: contextMeta.compactBoundaryTokens,
            contextWindow: contextMeta.contextWindow,
            rawContextWindow: contextMeta.rawContextWindow,
            effectiveContextWindowPercent: contextMeta.effectiveContextWindowPercent,
            autoCompactTokenLimit: contextMeta.autoCompactTokenLimit,
        };
    } else {
        delete session.contextWindow;
        delete session.rawContextWindow;
        delete session.effectiveContextWindowPercent;
        delete session.autoCompactTokenLimit;
        delete session.compactBoundaryTokens;
    }
    const routeChanged = (route.provider && route.provider !== previousProvider)
        || (route.model && route.model !== previousModel);
    if (routeChanged) {
        const now = Date.now();
        session.lastInputTokens = 0;
        session.lastOutputTokens = 0;
        session.lastCachedReadTokens = 0;
        session.lastCacheWriteTokens = 0;
        session.lastContextTokens = 0;
        session.lastContextTokensUpdatedAt = now;
        session.lastContextTokensStaleAfterCompact = false;
        session.providerState = undefined;
    }
    session.updatedAt = Date.now();
    setLiveSession(session);
    void saveSessionAsync(session, { expectedGeneration: session.generation })
        .catch((err) => {
            try { process.stderr.write(`[session] route update save failed: ${err?.message || err}\n`); } catch {}
        });
    return session;
}

/**
 * Reset heartbeat-visible fields for a new ask. Preserves controller/generation/
 * closed (lifecycle) but clears the previous run's streaming state so stale
 * lastToolCall / lastStreamDeltaAt from the previous ask don't leak into the
 * new one.
 */
export function markSessionAskStart(id) {
    if (!id) return;
    _stopToolActivityHeartbeat(id);
    const entry = _touchRuntime(id);
    entry.usageMetricsTurnIncremental = false;
    const sessionForTurn = entry.session ?? loadSession(id);
    if (sessionForTurn) bumpUsageMetricsTurnId(sessionForTurn);
    entry.stage = 'connecting';
    entry.lastStreamDeltaAt = null;
    entry.lastToolCall = null;
    entry.toolStartedAt = null;
    entry.lastError = null;
    // A new ask starts a fresh turn lifecycle — clear any stale empty-final
    // classification from the prior turn so inspectBridgeEntry doesn't keep
    // short-circuiting to 'empty-synthesis' (which would disable stall
    // detection for the entire new turn).
    entry.emptyFinal = false;
    entry.emptyFinalAt = null;
    // askStartedAt is the watchdog's fallback reference when a session
    // hangs before any stream delta arrives. Without it, a provider that
    // never returns a first token would stall forever because the watchdog
    // keys solely on lastStreamDeltaAt.
    const now = Date.now();
    entry.askStartedAt = now;
    entry.modelRequestStartedAt = now;
    entry.lastProgressAt = now;
    entry.updatedAt = now;
    // Publish heartbeat immediately so the status aggregator picks the
    // session up in the connecting / requesting window. Without this the
    // .hb file only landed on the first stream chunk — producing a 3–10s
    // (xhigh: 30s+) invisible gap where agent sessions ran but the CC
    // statusline showed no maintenance/agent badge. STREAM_FRESH_MS (5 min)
    // still drops a session whose provider truly never returns a chunk;
    // markSessionStreamDelta keeps refreshing once chunks arrive.
    publishHeartbeat(id, now);
}
export async function markSessionStreamDelta(id) {
    if (!id) return;
    // Non-creating lookup: a live ask ALWAYS has a runtime entry (markSessionAskStart
    // creates it before streaming begins). _touchRuntime would instead resurrect a
    // blank entry — and closeSession()/idle-sweep clear _runtimeState on a deferred
    // tick while a detached provider stream may still be trickling deltas. A delta
    // arriving after that clear must NOT re-create an entry or it would republish the
    // .hb heartbeat that markSessionClosed deleted, orphaning a dead session's
    // heartbeat indefinitely (the disk tombstone blocks ask resumption but not this
    // path). Skip a missing, tombstoned, or aborted entry — never refresh liveness.
    const entry = _runtimeState.get(id);
    if (!entry || entry.closed || entry.controller?.signal?.aborted) return;
    _stopToolActivityHeartbeat(id);
    const now = Date.now();
    entry.lastStreamDeltaAt = now;
    entry.lastProgressAt = now;
    // Only promote to 'streaming' if we were in a pre-stream stage; never downgrade
    // mid-tool (tool_running has its own delta source if the tool streams back).
    if (entry.stage === 'connecting' || entry.stage === 'requesting') {
        entry.stage = 'streaming';
    }
    // Lightweight heartbeat (≤5s self-throttled) for the status aggregator.
    // Disk-side session.lastHeartbeatAt below is the heavy 60s zombie-reaper
    // signal; the .hb file is the fast fresh-session signal consumed by the
    // status line.
    publishHeartbeat(id, now);
    const session = entry.session;
    if (session && now - (session.lastHeartbeatAt || 0) > HEARTBEAT_THROTTLE_MS) {
        session.lastHeartbeatAt = now;
        await saveSessionAsync(session, { expectedGeneration: session.generation });
    }
    entry.updatedAt = now;
}
export function markSessionToolCall(id, toolName) {
    if (!id) return;
    const entry = _touchRuntime(id);
    entry.stage = 'tool_running';
    entry.lastToolCall = toolName || null;
    entry.toolStartedAt = Date.now();
    entry.lastProgressAt = entry.toolStartedAt;
    entry.updatedAt = entry.toolStartedAt;
    publishHeartbeat(id, entry.toolStartedAt);
    _startToolActivityHeartbeat(id);
}
// Parent AbortSignal listeners are dropped on askSession unwind (finally /
// terminal return) and on error/cancel/close — not in markSessionDone, which
// also runs between queued follow-up turns within one ask.
export function markSessionDone(id, { empty = false } = {}) {
    if (!id) return;
    _stopToolActivityHeartbeat(id);
    const entry = _touchRuntime(id);
    entry.stage = 'done';
    entry.lastError = null;
    entry.askStartedAt = null;
    entry.toolStartedAt = null;
    // Non-empty completion: drop any stale empty-final flag so a subsequent
    // ask on the same reusable runtime entry starts clean. Empty-final
    // completions preserve the flag (set by markSessionEmptyFinal just prior).
    if (!empty) {
        entry.emptyFinal = false;
        entry.emptyFinalAt = null;
    }
    const doneTs = Date.now();
    entry.doneAt = doneTs;
    entry.lastProgressAt = doneTs;
    entry.updatedAt = doneTs;
    // Terminal stage — drop the heartbeat so the status badge releases
    // immediately. A subsequent ask on the same session re-publishes via
    // markSessionStreamDelta on the first chunk.
    deleteHeartbeat(id);
}
// Tag a session as having completed with empty final synthesis (no
// content/reasoning). Distinct from `markSessionDone`: still a success
// (no abort), but the stall watchdog and post-mortem tools can
// distinguish "finished empty" from "finished with content" without
// mistaking the silence for a stall.
export function markSessionEmptyFinal(id) {
    if (!id) return;
    const entry = _touchRuntime(id);
    entry.emptyFinal = true;
    entry.emptyFinalAt = Date.now();
}
export function markSessionError(id, msg) {
    if (!id) return;
    _stopToolActivityHeartbeat(id);
    const entry = _touchRuntime(id);
    entry.stage = 'error';
    entry.lastError = msg ? String(msg).slice(0, 200) : null;
    entry.askStartedAt = null;
    entry.toolStartedAt = null;
    // Error path is a non-empty completion (we have an error message, not a
    // silent empty final). Clear the flag so the next ask starts clean.
    entry.emptyFinal = false;
    entry.emptyFinalAt = null;
    const errTs = Date.now();
    entry.doneAt = errTs;
    entry.lastProgressAt = errTs;
    entry.updatedAt = errTs;
    deleteHeartbeat(id);
    _unlinkParentAbortListener(entry);
}
export function markSessionCancelled(id) {
    if (!id) return;
    _stopToolActivityHeartbeat(id);
    const entry = _touchRuntime(id);
    entry.stage = 'done';
    entry.lastError = null;
    entry.askStartedAt = null;
    entry.toolStartedAt = null;
    entry.emptyFinal = false;
    entry.emptyFinalAt = null;
    const doneTs = Date.now();
    entry.doneAt = doneTs;
    entry.lastProgressAt = doneTs;
    entry.updatedAt = doneTs;
    deleteHeartbeat(id);
    _unlinkParentAbortListener(entry);
}
export function getSessionRuntime(id) {
    return id ? (_runtimeState.get(id) || null) : null;
}

const _COMPACTION_BLOCKED_STAGES = new Set([
    'connecting', 'requesting', 'streaming', 'tool_running', 'cancelling',
]);

export function isSessionCompactionBlocked(sessionId) {
    if (!sessionId) return false;
    const entry = _runtimeState.get(sessionId);
    if (!entry || entry.closed === true) return false;
    if (entry.controller && !entry.controller.signal?.aborted) return true;
    return _COMPACTION_BLOCKED_STAGES.has(entry.stage);
}

export function getSessionProgressSnapshot(sessionId) {
    const entry = _runtimeState.get(sessionId);
    if (!entry) return null;
    const askStartedAt = entry.askStartedAt || 0;
    const modelRequestStartedAt = entry.modelRequestStartedAt || askStartedAt;
    const firstActivityAt = Math.max(
        entry.lastStreamDeltaAt || 0,
        entry.toolStartedAt || 0,
    );
    const stage = entry.stage || 'idle';
    const waitingForFirstActivity = Boolean(
        modelRequestStartedAt
        && (stage === 'connecting' || stage === 'requesting')
        && firstActivityAt <= modelRequestStartedAt
    );
    return {
        stage,
        askStartedAt,
        modelRequestStartedAt,
        firstActivityAt,
        lastStreamDeltaAt: entry.lastStreamDeltaAt || 0,
        toolStartedAt: entry.toolStartedAt || 0,
        lastProgressAt: entry.lastProgressAt || 0,
        updatedAt: entry.updatedAt || 0,
        hasFirstActivity: Boolean(firstActivityAt && (!askStartedAt || firstActivityAt >= askStartedAt)),
        waitingForFirstActivity,
    };
}

/**
 * Iterate all active session runtimes. Used by the stream watchdog.
 * Returns an iterable of [sessionId, entry] pairs; consumers should
 * treat entries as read-only snapshots and avoid mutating them.
 */
export function forEachSessionRuntime() {
    return _runtimeState.entries();
}

// --- Incremental metric persistence (fix A) ---
// Per-session idempotency tracking: sessionId → Set of seen turn:epoch:iteration:source keys.
const _metricSeenIter = new Map();

/** Monotonic per-session ask/turn id for incremental usage idempotency. */
export function bumpUsageMetricsTurnId(session) {
    if (!session || typeof session !== 'object') return 0;
    const next = (Number(session.usageMetricsTurnId) || 0) + 1;
    session.usageMetricsTurnId = next;
    return next;
}

export function resolveUsageMetricsTurnId(session, delta = {}) {
    if (delta.usageMetricsTurnId != null && Number.isFinite(Number(delta.usageMetricsTurnId))) {
        return Number(delta.usageMetricsTurnId);
    }
    return Number(session?.usageMetricsTurnId) || 0;
}

/** Advance loop metrics epoch when agentLoop resets its iteration counter (post-compact). */
export function bumpUsageMetricsEpoch(session) {
    if (!session || typeof session !== 'object') return 0;
    const next = (Number(session.usageMetricsEpoch) || 0) + 1;
    session.usageMetricsEpoch = next;
    return next;
}

/**
 * Resolve usage-metrics epoch for idempotency (exported for regression smoke).
 * Prefers session.usageMetricsEpoch (bumped in loop on compact reset) and optional
 * delta.usageMetricsEpoch; falls back to iteration regression when loop did not bump.
 */
export function resolveUsageMetricsEpoch(session, delta = {}) {
    if (!session) return 0;
    let epoch = Number(session.usageMetricsEpoch) || 0;
    if (delta.usageMetricsEpoch != null && Number.isFinite(Number(delta.usageMetricsEpoch))) {
        epoch = Math.max(epoch, Number(delta.usageMetricsEpoch));
    }
    const idx = Number(delta.iterationIndex);
    const prevLastIdx = typeof session.lastIterationIndex === 'number'
        ? session.lastIterationIndex
        : null;
    if (
        (delta.usageMetricsEpoch == null || !Number.isFinite(Number(delta.usageMetricsEpoch)))
        && prevLastIdx !== null
        && Number.isFinite(idx)
        && idx < prevLastIdx
    ) {
        epoch += 1;
    }
    return epoch;
}

export function usageMetricsSourceKey(delta = {}) {
    const raw = delta.source ?? delta.usageSource;
    if (raw == null || raw === '') return 'provider_send';
    return String(raw);
}

/** Idempotency key for incremental usage persistence (exported for regression smoke). */
export function usageMetricsIdempotencyKey(sessionId, session, delta = {}) {
    const turnId = resolveUsageMetricsTurnId(session, delta);
    const epoch = resolveUsageMetricsEpoch(session, delta);
    const source = usageMetricsSourceKey(delta);
    return `${sessionId}:${turnId}:${epoch}:${delta.iterationIndex}:${source}`;
}

/**
 * Apply terminal ask usage to session totals. Skips lifetime totals when incremental
 * per-iteration persistence already counted this turn (askSession path).
 */
export function applyAskTerminalUsageTotals(session, result, options = {}) {
    if (!session || !result?.usage) return;
    const skipTotals = options.skipTotalsIfIncremental === true;
    if (!skipTotals) {
        session.totalInputTokens = (session.totalInputTokens || 0) + (result.usage.inputTokens || 0);
        session.totalOutputTokens = (session.totalOutputTokens || 0) + (result.usage.outputTokens || 0);
        session.tokensCumulative = (session.tokensCumulative || 0)
            + (result.usage.inputTokens || 0)
            + (result.usage.outputTokens || 0);
        session.totalCachedReadTokens = (session.totalCachedReadTokens || 0) + (result.usage.cachedTokens || 0);
        session.totalCacheWriteTokens = (session.totalCacheWriteTokens || 0) + (result.usage.cacheWriteTokens || 0);
    }
    const _lastTurn = result.lastTurnUsage || result.usage || {};
    session.lastInputTokens = _lastTurn.inputTokens || 0;
    session.lastOutputTokens = _lastTurn.outputTokens || 0;
    session.lastCachedReadTokens = _lastTurn.cachedTokens || 0;
    session.lastCacheWriteTokens = _lastTurn.cacheWriteTokens || 0;
    const _inputExcludesCache = providerInputExcludesCache(session.provider);
    session.lastContextTokens = _inputExcludesCache
        ? (_lastTurn.inputTokens || 0) + (_lastTurn.cachedTokens || 0)
        : (_lastTurn.inputTokens || 0);
    session.lastContextTokensUpdatedAt = Date.now();
    session.lastContextTokensStaleAfterCompact = false;
}

/**
 * Persist incremental usage delta immediately after each provider.send iteration.
 * Idempotency key `sessionId:turnId:epoch:iterationIndex:source` scopes retries
 * per ask, compaction epoch, iteration, and usage source.
 */
export async function persistIterationMetrics(delta) {
    if (!delta || !delta.sessionId) return;
    const { sessionId, iterationIndex, deltaInput, deltaOutput, deltaCachedRead, deltaCacheWrite, ts } = delta;
    const runtimeEntry = _runtimeState.get(sessionId);
    const session = runtimeEntry?.session ?? loadSession(sessionId);
    if (!session || session.closed) return;
    const epoch = resolveUsageMetricsEpoch(session, delta);
    if (epoch !== (Number(session.usageMetricsEpoch) || 0)) {
        session.usageMetricsEpoch = epoch;
    }
    let seen = _metricSeenIter.get(sessionId);
    if (!seen) {
        seen = new Set();
        _metricSeenIter.set(sessionId, seen);
    }
    const ikey = usageMetricsIdempotencyKey(sessionId, session, delta);
    const isReplay = seen.has(ikey);
    seen.add(ikey);
    if (!isReplay) {
        if (runtimeEntry) runtimeEntry.usageMetricsTurnIncremental = true;
        session.totalInputTokens = (session.totalInputTokens || 0) + (deltaInput || 0);
        session.totalOutputTokens = (session.totalOutputTokens || 0) + (deltaOutput || 0);
        session.tokensCumulative = (session.tokensCumulative || 0) + (deltaInput || 0) + (deltaOutput || 0);
        // Cache totals — additive fields, default 0 on legacy sessions; both
        // are undefined-safe so the schema migrates lazily as new iterations
        // land. Keeps live + terminal aggregates in lock-step (loop.mjs already
        // includes cached_read / cache_write in its terminal usage rollup).
        session.totalCachedReadTokens = (session.totalCachedReadTokens || 0) + (deltaCachedRead || 0);
        session.totalCacheWriteTokens = (session.totalCacheWriteTokens || 0) + (deltaCacheWrite || 0);
        // Window snapshot updated per iteration so agent type=list reflects the
        // most-recent provider-reported input size even for short dispatches
        // that finish before askSession's terminal save lands.
        session.lastInputTokens = deltaInput || 0;
        session.lastOutputTokens = deltaOutput || 0;
        session.lastCachedReadTokens = deltaCachedRead || 0;
        // Normalized last-call context footprint: how many prompt tokens the
        // model actually saw on the most-recent send, comparable ACROSS
        // providers. Anthropic reports input_tokens EXCLUDING cache (cache_read
        // is a separate field), so the cached portion must be added back to
        // reflect real context size; openai/grok/gemini already fold cached
        // tokens INTO the input count, so input alone is the footprint.
        const _inputExcludesCache = providerInputExcludesCache(session.provider);
        session.lastContextTokens = _inputExcludesCache
            ? (deltaInput || 0) + (deltaCachedRead || 0)
            : (deltaInput || 0);
        session.lastContextTokensUpdatedAt = ts || Date.now();
        session.lastContextTokensStaleAfterCompact = false;
    }
    session.lastIterationIndex = iterationIndex;
    session.updatedAt = ts || Date.now();
    await saveSessionAsync(session, { expectedGeneration: session.generation });
}

function standaloneStatusRouteInfo(session) {
    if (!session) return null;
    return {
        provider: session.provider,
        model: session.model,
        modelDisplay: session.modelDisplay || session.displayName || session.model,
        effort: session.effort || '',
        fast: session.fast === true,
        contextWindow: session.contextWindow || null,
        rawContextWindow: session.rawContextWindow || session.contextWindow || null,
        effectiveContextWindowPercent: session.effectiveContextWindowPercent || null,
        autoCompactTokenLimit: session.autoCompactTokenLimit || session.compactBoundaryTokens || null,
        presetId: session.presetId || null,
        presetName: session.presetName || null,
    };
}

function recordStandaloneStatusTelemetry(session, result, durationMs) {
    if (!session || !result?.usage) return;
    const routeInfo = standaloneStatusRouteInfo(session);
    if (!routeInfo?.provider || !routeInfo?.model) return;
    const providerOut = {
        usage: result.usage,
        model: result.model,
        serviceTier: result.serviceTier,
    };
    // The transcript estimate is the SSOT for the displayed context footprint.
    // agentLoop()'s result has no `compact` field, so build a synthetic compact
    // arg carrying the live monotonic estimate (estimateMessagesTokens+reserve)
    // as afterTokens. This lights up summarizeGatewayUsage's estimate-based
    // contextUsedPct branch (provider input_tokens swing wildly / unbounded on
    // e.g. OpenAI gpt-5.5), and lets a genuine >100% pass through.
    const _reserve = estimateRequestReserveTokens(session.tools || []);
    const _estTokens = estimateMessagesTokens(Array.isArray(session.messages) ? session.messages : []) + _reserve;
    const _compactArg = { ...(result.compact && typeof result.compact === 'object' ? result.compact : {}), afterTokens: _estTokens };
    try {
        const summary = {
            ...summarizeGatewayUsage(routeInfo, providerOut, _compactArg, durationMs),
            requestKind: 'chat',
            sessionId: session.id || null,
            toolCount: result.toolCallsTotal ?? null,
            messageCount: Array.isArray(session.messages) ? session.messages.length : null,
            cacheStrategy: session.providerCacheOpts?.cacheStrategy || null,
        };
        recordGatewayUsageEvent(summary);
    } catch {
        // Statusline telemetry must never affect the model turn.
    }

    const provider = getProvider(routeInfo.provider);
    if (!provider) return;
    fetchOAuthUsageSnapshot(routeInfo, provider, (message) => {
        if (process.env.MIXDOG_STATUSLINE_TRACE) {
            process.stderr.write(`[statusline] ${message}\n`);
        }
    })
        .then((snapshot) => {
            try { buildGatewayLimits(routeInfo, providerOut, snapshot); } catch {}
        })
        .catch(() => {});
}

/** Force-flush session metrics to disk. Used by watchdog terminal-reap (fix B). */
export async function flushSessionMetrics(sessionId) {
    if (!sessionId) return;
    const session = loadSession(sessionId);
    if (!session) return;
    session.updatedAt = Date.now();
    await saveSessionAsync(session, { expectedGeneration: session.generation });
}

/** Mark session hidden so listSessions() filters it out (runtime-only). */
export function hideSessionFromList(sessionId) {
    if (!sessionId) return;
    const entry = _runtimeState.get(sessionId);
    if (entry) entry.listHidden = true;
}

export function getSessionAbortSignal(sessionId) {
    return _runtimeState.get(sessionId)?.controller?.signal ?? null;
}

/**
 * Return the most recent "session is making progress" timestamp.
 *
 * Combines three independent progress signals so an idle watchdog can stay
 * alive across both streaming and long tool calls:
 *   - lastStreamDeltaAt: provider stream chunk landed
 *   - toolStartedAt: a tool call just kicked off (nested tool work may
 *     stall the outer stream for a while; this keeps the watchdog from
 *     killing legitimate sub-agent runs)
 *   - askStartedAt: ask just started; covers the pre-stream connect window
 *
 * Returns 0 when the runtime entry is unknown so callers can decide to
 * either skip the watchdog or treat 0 as "no progress yet".
 */
export function getSessionLastProgressAt(sessionId) {
    const entry = _runtimeState.get(sessionId);
    if (!entry) return 0;
    return Math.max(
        entry.lastProgressAt || 0,
        entry.lastStreamDeltaAt || 0,
        entry.toolStartedAt || 0,
        entry.askStartedAt || 0,
    );
}

/**
 * Link a parent AbortSignal to a sub-session's controller so that aborting
 * the parent (fan-out deadline or caller ESC) tears down the agent role's
 * provider call promptly. Safe to call after prepareAgentSession but before
 * askSession completes. No-op if the session runtime isn't found.
 *
 * @param {string} sessionId — the sub-session to abort
 * @param {AbortSignal} parentSignal — upstream signal (from fan-out coordinator)
 */
export function linkParentSignalToSession(sessionId, parentSignal) {
    if (!(parentSignal instanceof AbortSignal)) return;
    const entry = _touchRuntime(sessionId);
    if (!entry.controller) entry.controller = createAbortController();
    const abortReason = () => {
        const reason = parentSignal.reason;
        if (reason instanceof Error) return reason;
        if (reason !== undefined && reason !== null && reason !== '') return new Error(String(reason));
        return new Error('parent signal aborted');
    };
    if (parentSignal.aborted) {
        _unlinkParentAbortListener(entry);
        try { entry.controller.abort(abortReason()); } catch { /* ignore */ }
        return;
    }
    _unlinkParentAbortListener(entry);
    const onParentAbort = () => {
        try { entry.controller?.abort(abortReason()); } catch { /* ignore */ }
    };
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
    entry.parentAbortLink = { signal: parentSignal, listener: onParentAbort };
}
function _unlinkParentAbortListener(entry) {
    const link = entry?.parentAbortLink;
    if (!link) return;
    try { link.signal.removeEventListener('abort', link.listener); } catch { /* ignore */ }
    entry.parentAbortLink = null;
}
function _clearSessionRuntime(id) {
    if (id) {
        _stopToolActivityHeartbeat(id);
        _unlinkParentAbortListener(_runtimeState.get(id));
        _runtimeState.delete(id);
        // R15: also drop the per-session metric-idempotency Set; otherwise it
        // grows O(sessions x iterations) for the whole server lifetime since
        // nothing else deletes from _metricSeenIter on session close.
        _metricSeenIter.delete(id);
    }
}

/**
 * Wrap an async call so that if the session's controller aborts mid-flight,
 * the wrapper settles with a SessionClosedError even if the underlying promise
 * hasn't returned yet. The original promise is kept alive with a detached
 * `.catch()` to prevent unhandled-rejection warnings once it eventually
 * settles. Callers still must check generation/closed after await returns
 * to handle providers that ignore the AbortSignal entirely.
 */
export async function _api_call_with_interrupt(sessionId, fn) {
    const entry = _touchRuntime(sessionId);
    if (!entry.controller) entry.controller = createAbortController();
    const signal = entry.controller.signal;
    const closedFromAbort = (phase) => {
        const reason = signal.reason;
        if (reason instanceof SessionClosedError) return reason;
        const detail = reason instanceof Error
            ? reason.message
            : (reason !== undefined && reason !== null && reason !== '' ? String(reason) : '');
        return new SessionClosedError(sessionId, detail ? `${phase}: ${detail}` : phase);
    };
    if (signal.aborted) throw closedFromAbort('aborted before call');
    const underlying = fn(signal);
    underlying.catch(() => {}); // prevent unhandled rejection if we race ahead
    let onAbort = null;
    const aborted = new Promise((_, reject) => {
        onAbort = () => reject(closedFromAbort('aborted during call'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([underlying, aborted]);
    } finally {
        // If the underlying promise settled first, the abort listener is
        // still attached. Remove it to avoid accumulating listeners across
        // many asks on the same session.
        if (onAbort && !signal.aborted) {
            try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
        }
    }
}

// Per-session mutex: queues concurrent askSession calls to prevent message loss
const _sessionLocks = new Map();
// Per-session pending-message queue (in-flight send enqueue pattern).
// A `agent type=send` to a worker whose turn is still in flight ENQUEUES the
// message here instead of rejecting; askSession drains the queue after each
// turn and runs the messages as the next user turn(s), preserving order — the
// queued send runs AFTER the in-flight prompt, which also closes the spawn
// startup race (a send landing before the initial turn settles no longer
// jumps ahead of the original prompt).
//
// The in-memory map is mirrored to disk. Without that, a compact/API error or
// daemon restart after returning queued:true can strand or lose a follow-up:
// the original ask never reaches its drain point, and no new ask is scheduled.
// Keeping the queue outside the session JSON avoids racing session saves that
// loaded before the send arrived.
//
// Map<sessionId, Array<string|{text?:string,content:any}>>. Shared with
// index.mjs's agent send handler via the enqueue/drain accessors below — one
// queue contract, two call sites. Rich content is kept in memory for the live
// relay path; the disk mirror stores only a text fallback so image bytes do not
// leak into the pending-message JSON.
const _sessionPendingMessages = new Map();
const PENDING_MESSAGES_FILE = 'session-pending-messages.json';
const PENDING_MESSAGES_MODE = 0o600;
const _pendingPersistBuffers = new Map();
let _pendingPersistImmediate = null;

function pendingMessagesPath() {
    return join(resolvePluginData(), PENDING_MESSAGES_FILE);
}

function isValidPendingSessionId(sessionId) {
    return typeof sessionId === 'string' && /^[A-Za-z0-9_-]+$/.test(sessionId);
}

function normalizePendingStore(raw) {
    const sessions = raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object'
        ? raw.sessions
        : {};
    const out = { version: 1, updatedAt: Date.now(), sessions: {} };
    for (const [sid, value] of Object.entries(sessions)) {
        if (!isValidPendingSessionId(sid) || !Array.isArray(value)) continue;
        const q = value
            .map((entry) => {
                if (typeof entry === 'string') return entry;
                if (entry && typeof entry === 'object' && typeof entry.message === 'string') return entry.message;
                return '';
            })
            .filter(Boolean);
        if (q.length > 0) out.sessions[sid] = q;
    }
    return out;
}

function normalizePendingMessageEntry(entry) {
    if (typeof entry === 'string') {
        const text = entry.trim();
        return text ? { content: text, text } : null;
    }
    if (Array.isArray(entry)) {
        if (entry.length === 0) return null;
        const text = promptContentText(entry).trim();
        return { content: entry, text };
    }
    if (!entry || typeof entry !== 'object') return null;
    const content = Object.prototype.hasOwnProperty.call(entry, 'content') ? entry.content : null;
    if (content == null) return null;
    const text = typeof entry.text === 'string' ? entry.text.trim() : promptContentText(content).trim();
    if (Array.isArray(content)) return content.length > 0 ? { content, text } : null;
    if (typeof content === 'string') {
        const value = content.trim();
        return value ? { content: value, text: text || value } : null;
    }
    const fallback = promptContentText(content).trim();
    return fallback ? { content: fallback, text: text || fallback } : null;
}

function pendingMessageText(entry) {
    const normalized = normalizePendingMessageEntry(entry);
    return normalized ? String(normalized.text || promptContentText(normalized.content) || '').trim() : '';
}

function pendingMessageQueueEntry(entry) {
    const normalized = normalizePendingMessageEntry(entry);
    if (!normalized) return null;
    if (typeof normalized.content === 'string' && normalized.content === normalized.text) return normalized.content;
    return { content: normalized.content, text: normalized.text || promptContentText(normalized.content).trim() };
}

function persistPendingMessages(sessionId, messages) {
    if (!isValidPendingSessionId(sessionId)) return 0;
    const persistedMessages = (Array.isArray(messages) ? messages : [messages])
        .map(pendingMessageText)
        .filter(Boolean);
    if (persistedMessages.length === 0) return 0;
    let depth = 0;
    try {
        updateJsonAtomicSync(pendingMessagesPath(), (raw) => {
            const next = normalizePendingStore(raw);
            const q = Array.isArray(next.sessions[sessionId]) ? next.sessions[sessionId] : [];
            q.push(...persistedMessages);
            next.sessions[sessionId] = q;
            next.updatedAt = Date.now();
            depth = q.length;
            return next;
        }, { compact: true, lock: true, mode: PENDING_MESSAGES_MODE, fsync: false });
    } catch (err) {
        try { process.stderr.write(`[session] pending-message persist failed sessionId=${sessionId}: ${err?.message || err}\n`); } catch {}
    }
    return depth;
}

function flushPendingMessagePersistsSync() {
    if (_pendingPersistImmediate) {
        try { clearImmediate(_pendingPersistImmediate); } catch {}
        _pendingPersistImmediate = null;
    }
    if (_pendingPersistBuffers.size === 0) return;
    const batches = [..._pendingPersistBuffers.entries()];
    _pendingPersistBuffers.clear();
    for (const [sid, messages] of batches) {
        persistPendingMessages(sid, messages);
    }
}

function schedulePendingMessagePersist(sessionId, message) {
    if (!isValidPendingSessionId(sessionId)) return 0;
    const persistedMessage = pendingMessageText(message);
    if (!persistedMessage) return 0;
    const q = _pendingPersistBuffers.get(sessionId) || [];
    q.push(persistedMessage);
    _pendingPersistBuffers.set(sessionId, q);
    if (!_pendingPersistImmediate) {
        _pendingPersistImmediate = setImmediate(() => {
            _pendingPersistImmediate = null;
            flushPendingMessagePersistsSync();
        });
    }
    return q.length;
}

function takeBufferedPendingMessages(sessionId) {
    if (!isValidPendingSessionId(sessionId)) return [];
    const buffered = _pendingPersistBuffers.get(sessionId);
    if (!buffered || buffered.length === 0) return [];
    _pendingPersistBuffers.delete(sessionId);
    return buffered.slice();
}

function drainPersistedPendingMessages(sessionId) {
    if (!isValidPendingSessionId(sessionId)) return [];
    let drained = [];
    try {
        updateJsonAtomicSync(pendingMessagesPath(), (raw) => {
            const next = normalizePendingStore(raw);
            const q = Array.isArray(next.sessions[sessionId]) ? next.sessions[sessionId] : [];
            drained = q.filter((m) => typeof m === 'string' && m.length > 0);
            if (drained.length === 0) return undefined;
            delete next.sessions[sessionId];
            next.updatedAt = Date.now();
            return next;
        }, { compact: true, lock: true, mode: PENDING_MESSAGES_MODE, fsync: false });
    } catch (err) {
        try { process.stderr.write(`[session] pending-message drain failed sessionId=${sessionId}: ${err?.message || err}\n`); } catch {}
    }
    return drained;
}

export function enqueuePendingMessage(sessionId, message) {
    const entry = pendingMessageQueueEntry(message);
    if (!sessionId || !entry) return 0;
    let q = _sessionPendingMessages.get(sessionId);
    if (!q) { q = []; _sessionPendingMessages.set(sessionId, q); }
    q.push(entry);
    const bufferedDepth = schedulePendingMessagePersist(sessionId, entry);
    return Math.max(q.length, bufferedDepth || 0);
}
export function drainPendingMessages(sessionId) {
    const q = _sessionPendingMessages.get(sessionId);
    const memory = q && q.length > 0 ? q.slice() : [];
    _sessionPendingMessages.delete(sessionId);
    const persisted = [...takeBufferedPendingMessages(sessionId), ...drainPersistedPendingMessages(sessionId)];
    const memoryVisible = modelVisiblePendingMessages(memory);
    const persistedVisible = modelVisiblePendingMessages(persisted);
    if (memoryVisible.length === 0) return persistedVisible;
    if (persistedVisible.length === 0) return memoryVisible;
    const persistedTexts = persistedVisible.map(pendingMessageText);
    const prefixMatches = memoryVisible.every((m, i) => persistedTexts[i] === pendingMessageText(m));
    if (prefixMatches) return [...memoryVisible, ...persistedVisible.slice(memoryVisible.length)];
    const out = persistedVisible.slice();
    const seen = new Set(persistedTexts);
    for (const m of memoryVisible) {
        const text = pendingMessageText(m);
        if (!text || seen.has(text)) continue;
        out.push(m);
        seen.add(text);
    }
    return out;
}

function promptContentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (typeof part === 'string') return part;
            if (part?.type === 'text') return part.text || '';
            if (part?.type === 'image') return '[Image]';
            return part?.text || '';
        }).filter(Boolean).join('\n');
    }
    return String(content ?? '');
}

function promptContentBytes(content) {
    try {
        if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
        return Buffer.byteLength(JSON.stringify(content), 'utf8');
    } catch {
        return Buffer.byteLength(promptContentText(content), 'utf8');
    }
}

function prefixUserTurnContent(content, contextBlock) {
    if (!contextBlock) return content;
    if (Array.isArray(content)) {
        return [{ type: 'text', text: `${contextBlock}# Task\n` }, ...content];
    }
    return `${contextBlock}# Task\n${content}`;
}

function prefixSessionStartContent(content, sessionBlock) {
    if (!sessionBlock) return content;
    if (Array.isArray(content)) {
        return [{ type: 'text', text: `${sessionBlock}\n\n` }, ...content];
    }
    return `${sessionBlock}\n\n${content}`;
}

function localIsoDate(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function localDateTimeWithZone(date = new Date()) {
    const datePart = localIsoDate(date);
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    let zone = '';
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}
    return zone ? `${datePart} ${hh}:${mm}:${ss} ${zone}` : `${datePart} ${hh}:${mm}:${ss}`;
}

function temporalPromptText(content) {
    const text = promptContentText(content)
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    return text;
}

function promptNeedsDateReminder(content) {
    const text = temporalPromptText(content);
    if (!text) return false;
    return /(?:오늘|내일|어제|모레|그저께|요즘|최근|방금|아까|현재\s*(?:날짜|시간|시각)|지금\s*(?:몇\s*시|시간|날짜|요일)|몇\s*월\s*몇\s*일|몇\s*시|무슨\s*요일|요일|날짜|이번\s*(?:주|달|월|년)|지난\s*(?:주|달|월|년)|다음\s*(?:주|달|월|년)|올해|작년|내년|today|tomorrow|yesterday|recently|current\s+(?:date|time)|what\s+(?:date|time)|which\s+day|weekday|this\s+(?:week|month|year)|last\s+(?:week|month|year)|next\s+(?:week|month|year))/i.test(text);
}

function promptNeedsTimeReminder(content) {
    const text = temporalPromptText(content);
    if (!text) return false;
    return /(?:현재\s*(?:시간|시각)|지금\s*(?:몇\s*시|시간)|몇\s*시|시각|시간|current\s+time|what\s+time|time\s+is\s+it)/i.test(text);
}

function buildCurrentTimeBlock(content) {
    const needsTime = promptNeedsTimeReminder(content);
    if (!needsTime && !promptNeedsDateReminder(content)) return '';
    return localDateTimeWithZone(new Date());
}

function sessionModelDisplay(model) {
    const text = String(model || '').trim();
    if (!text) return '';
    return text
        .replace(/-\d{4}-\d{2}-\d{2}$/, '')
        .replace(/^gpt-/i, 'GPT-')
        .replace(/(?:^|-)([a-z])/g, (m) => m.toUpperCase());
}

function sessionShellDisplay() {
    return process.platform === 'win32' ? 'powershell' : 'bash';
}

function buildSessionStartBlock(session, cwd) {
    if (!session || session.owner === 'agent') return '';
    const lines = ['# Session'];
    const effectiveCwd = String(cwd || session.cwd || '').trim();
    if (effectiveCwd) lines.push(`Cwd: ${effectiveCwd}`);
    const modelBits = [
        sessionModelDisplay(session.model),
        session.effort ? String(session.effort).trim().toUpperCase() : '',
        session.fast === true ? 'FAST' : '',
    ].filter(Boolean);
    if (modelBits.length) lines.push(`Model: ${modelBits.join(' · ')}`);
    const workflowName = String(session.workflow?.name || session.workflow?.id || '').trim();
    if (workflowName) lines.push(`Workflow: ${workflowName}`);
    lines.push(`Shell: ${sessionShellDisplay()}`);
    return lines.length > 1 ? lines.join('\n') : '';
}

function isReferenceFilesMessage(message) {
    return message?.role === 'user'
        && typeof message.content === 'string'
        && /^Reference files:\s*/i.test(message.content.trimStart());
}

function isProtectedContextUserMessage(message) {
    return message?.role === 'user'
        && typeof message.content === 'string'
        && message.content.trimStart().startsWith('<system-reminder>');
}

function hasUserConversationMessage(messages) {
    return (Array.isArray(messages) ? messages : []).some((message) => (
        message?.role === 'user'
        && !isProtectedContextUserMessage(message)
        && !isReferenceFilesMessage(message)
    ));
}

function modelVisiblePendingMessages(messages) {
    return (Array.isArray(messages) ? messages : [])
        .map(pendingMessageQueueEntry)
        .filter(Boolean)
        .filter((message) => !isInternalRuntimeNotificationText(
            message && typeof message === 'object' && Object.prototype.hasOwnProperty.call(message, 'content')
                ? message.content
                : message,
        ));
}

export function _mergePendingMessageEntries(entries) {
    const normalized = (Array.isArray(entries) ? entries : [])
        .map(normalizePendingMessageEntry)
        .filter(Boolean);
    if (normalized.length === 0) return null;
    const displayText = normalized.map((entry) => entry.text || promptContentText(entry.content))
        .filter((text) => String(text || '').trim())
        .join('\n');
    if (normalized.every((entry) => typeof entry.content === 'string')) {
        return {
            content: normalized.map((entry) => entry.content).filter(Boolean).join('\n'),
            text: displayText,
            count: normalized.length,
        };
    }
    const parts = [];
    for (const entry of normalized) {
        if (typeof entry.content === 'string') {
            if (entry.content.trim()) parts.push({ type: 'text', text: entry.content });
        } else if (Array.isArray(entry.content)) {
            parts.push(...entry.content);
        } else {
            const text = promptContentText(entry.content);
            if (text.trim()) parts.push({ type: 'text', text });
        }
        parts.push({ type: 'text', text: '\n' });
    }
    while (parts.length && parts[parts.length - 1]?.type === 'text' && parts[parts.length - 1]?.text === '\n') parts.pop();
    return { content: parts, text: displayText || promptContentText(parts), count: normalized.length };
}

function isInternalRuntimeNotificationText(content) {
    return contractIsInternalRuntimeNotificationText(promptContentText(content));
}

export const _isInternalRuntimeNotificationText = isInternalRuntimeNotificationText;

function isInternalCancelledAssistantMessage(message) {
    if (!message || message.role !== 'assistant') return false;
    if (message.cancelled === true) return true;
    const text = promptContentText(message.content).trim();
    return /^\[cancelled\]\s+This turn was interrupted before completion\./i.test(text)
        || /Preserve the user request above as the active task context/i.test(text);
}

function sanitizeSessionMessagesForModel(messages) {
    // Drop internal runtime-notification turns and cancelled-assistant stubs so
    // they never reach the model, but KEEP image content intact. Reference-agent
    // parity: the live transcript and every model request retain attached
    // images across turns; only the compaction-summary call strips them. The
    // disk-stored session JSON replaces image bytes with a text placeholder at
    // serialization time (see store.mjs), so this no longer touches images.
    if (!Array.isArray(messages) || messages.length === 0) return [];
    const out = [];
    let droppingInternalTurn = false;
    for (const message of messages) {
        if (isInternalCancelledAssistantMessage(message)) {
            droppingInternalTurn = false;
            continue;
        }
        if (message?.role === 'user' && isInternalRuntimeNotificationText(message.content)) {
            droppingInternalTurn = true;
            continue;
        }
        if (droppingInternalTurn) {
            if (message?.role === 'user') {
                droppingInternalTurn = false;
            } else {
                continue;
            }
        }
        out.push(message);
    }
    return out;
}

function acquireSessionLock(sessionId) {
    let entry = _sessionLocks.get(sessionId);
    if (!entry) {
        entry = { promise: Promise.resolve(), count: 0 };
        _sessionLocks.set(sessionId, entry);
    }
    entry.count++;
    const prev = entry.promise;
    let release;
    entry.promise = new Promise(r => { release = r; });
    // Self-heal: if the previous holder rejected, swallow so subsequent
    // queued waiters don't propagate that rejection and brick the lock chain.
    return prev.catch(() => {}).then(() => () => {
        entry.count--;
        if (entry.count === 0) _sessionLocks.delete(sessionId);
        release();
    });
}

function sessionMessagesSnapshotChanged(before, after) {
    if (!Array.isArray(before) || !Array.isArray(after)) return before !== after;
    if (before.length !== after.length) return true;
    for (let i = 0; i < before.length; i += 1) {
        if (before[i] !== after[i]) return true;
        try {
            if (JSON.stringify(before[i]) !== JSON.stringify(after[i])) return true;
        } catch {
            return true;
        }
    }
    return false;
}

function isCompactedOutgoingFinalAssistantMessage(message) {
    if (!message || message.role !== 'assistant') return false;
    if (message.emptyFinal === true) return true;
    return true;
}

function sessionMessagesAdvancedBeyondCompactedOutgoing(currentSanitized, compactedSanitized) {
    if (!Array.isArray(currentSanitized) || !Array.isArray(compactedSanitized)) return false;
    if (currentSanitized.length !== compactedSanitized.length + 1) return false;
    const prefix = currentSanitized.slice(0, compactedSanitized.length);
    if (sessionMessagesSnapshotChanged(compactedSanitized, prefix)) return false;
    return isCompactedOutgoingFinalAssistantMessage(currentSanitized[currentSanitized.length - 1]);
}

export const _sessionMessagesAdvancedBeyondCompactedOutgoing = sessionMessagesAdvancedBeyondCompactedOutgoing;

function applyCompactFailurePersistToSession(activeSession, {
    priorSanitized,
    sanitized,
    messagesAdvanced,
    error = null,
}) {
    if (!messagesAdvanced && !sessionMessagesSnapshotChanged(priorSanitized, sanitized)) return false;
    if (!messagesAdvanced) {
        activeSession.messages = sanitized;
        activeSession.providerState = undefined;
    }
    activeSession.updatedAt = Date.now();
    activeSession.lastUsedAt = Date.now();
    if (activeSession.compaction && typeof activeSession.compaction === 'object'
        && activeSession.compaction.lastStage === 'compacting') {
        activeSession.compaction = {
            ...activeSession.compaction,
            lastStage: error?.code === 'AGENT_CONTEXT_OVERFLOW' ? 'overflow_failed' : 'failed',
            lastCheckedAt: Date.now(),
        };
    }
    return true;
}

export const _applyCompactFailurePersistToSession = applyCompactFailurePersistToSession;

async function persistCompactedOutgoingAfterAskFailure({
    sessionId,
    activeSession,
    askGeneration,
    turnOutgoing,
    error = null,
}) {
    if (!activeSession || activeSession.closed === true) return;
    if (!Array.isArray(turnOutgoing) || turnOutgoing.length === 0) return;
    const currentRuntime = _runtimeState.get(sessionId);
    if (currentRuntime?.closed || currentRuntime?.generation !== askGeneration) return;
    const sanitized = sanitizeSessionMessagesForModel(turnOutgoing);
    const priorSanitized = sanitizeSessionMessagesForModel(
        Array.isArray(activeSession.messages) ? activeSession.messages : [],
    );
    const messagesAdvanced = sessionMessagesAdvancedBeyondCompactedOutgoing(priorSanitized, sanitized);
    const applied = applyCompactFailurePersistToSession(activeSession, {
        priorSanitized,
        sanitized,
        messagesAdvanced,
        error,
    });
    if (!applied) return;
    try {
        await saveSessionAsync(activeSession, { expectedGeneration: askGeneration });
    } catch { /* best-effort: preserve in-memory compaction even if disk is slow */ }
    if (currentRuntime) currentRuntime.session = activeSession;
}

export async function askSession(sessionId, prompt, context, onToolCall, cwdOverride, explicitPrefetch, askOpts = {}) {
    const _askStartedAt = Date.now();
    const _promptSrc = 'prompt';
    const _prefetchFiles = (explicitPrefetch?.files?.length) || 0;
    const _prefetchCallers = (explicitPrefetch?.callers?.length) || 0;
    const _prefetchRefs = (explicitPrefetch?.references?.length) || 0;
    if (process.env.MIXDOG_DEBUG_AGENT) {
        process.stderr.write(`[agent-trace] t0-ask-start sessionHash=${createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 8)} role=? iteration=0 promptSrc=${_promptSrc} prefetchFiles=${_prefetchFiles} callers=${_prefetchCallers} references=${_prefetchRefs}\n`);
    }
    const unlock = await acquireSessionLock(sessionId);
    const _lockWaitedMs = Date.now() - _askStartedAt;
    if (process.env.MIXDOG_DEBUG_AGENT) {
        process.stderr.write(`[agent-trace] lock-acquired waitedMs=${_lockWaitedMs}\n`);
    }
    // The mutex is held for the WHOLE askSession call, including any follow-up
    // turns drained from the pending-message queue below — the single outer
    // try/finally releases it exactly once. _result holds the last turn's
    // return value (the queued tail turns supersede the original prompt's
    // result, mirroring how a live chat returns the latest turn).
    let _result;
    // Local FIFO of follow-up prompts drained from the pending-message queue
    // after each turn — keeps queued `agent type=send` messages in order.
    const _pendingTail = [];
    // Hoisted so the outer finally (which runs once after the whole turn loop)
    // can compare against the last turn's generation.
    let askGeneration = 0;
    try {
      // Turn loop (pendingMessages pattern): run the current prompt, then drain
      // any `agent type=send` messages that were queued while this turn was in
      // flight and run them — in order — as the next user turn(s). Because the
      // queued send always lands AFTER the in-flight prompt here, ordering is
      // preserved and the spawn/connecting startup race disappears.
      for (;;) {
        let _pwstTurnDrained = null;
        // After the first turn, the next prompt comes from the drained queue.
        // (On the first iteration _pendingTail is empty and `prompt` is the
        // caller's original message.)
        if (_pendingTail.length > 0) {
            prompt = _pendingTail.shift();
            // Queued follow-ups are plain user turns — no caller context /
            // prefetch is re-applied (those belonged to the original ask).
            context = null;
            explicitPrefetch = null;
        }
        // ── Synchronous pre-await setup (must happen before any await so
        //    closeSession() can't interleave between load and registration) ──
        const preSession = loadSession(sessionId);
        if (!preSession) {
            throw new Error(`Session "${sessionId}" not found`);
        }
        if (preSession.closed === true) {
            throw new SessionClosedError(sessionId, 'session already closed');
        }
        askGeneration = typeof preSession.generation === 'number' ? preSession.generation : 0;
        const runtime = _touchRuntime(sessionId);
        // Fresh controller per ask — the previous ask's controller may have aborted.
        runtime.controller = createAbortController();
        runtime.generation = askGeneration;
        runtime.closed = false;
        runtime.session = preSession;
        markSessionAskStart(sessionId);
        // Preprocessing is inside try so provider-not-available / trim failures
        // fall into the catch and mark the session as errored rather than
        // leaving stage='connecting' forever.
        let activeSession = preSession;
        let cancelledUserTurnContent = '';
        let _turnOutgoing = null;
        try {
            const session = activeSession;
            const provider = getProvider(session.provider);
            // Register the live session object into runtime so closeSession()
            // can read allBashSessionIds that loop.mjs appends mid-turn.
            runtime.session = session;
            if (!provider)
                throw new Error(`Provider "${session.provider}" not available`);
            const contextMeta = resolveSessionContextMeta(provider, session.model, session);
            session.contextWindow = contextMeta.contextWindow;
            session.rawContextWindow = contextMeta.rawContextWindow;
            session.effectiveContextWindowPercent = contextMeta.effectiveContextWindowPercent;
            session.autoCompactTokenLimit = contextMeta.autoCompactTokenLimit;
            session.compactBoundaryTokens = contextMeta.compactBoundaryTokens;
            session.compaction = {
                ...(session.compaction || {}),
                auto: session.compaction?.auto !== false,
                semantic: session.compaction?.semantic ?? 'auto',
                type: normalizeCompactType(session.compaction?.type ?? session.compaction?.compactType ?? session.compaction?.compact_type, DEFAULT_COMPACT_TYPE),
                compactType: normalizeCompactType(session.compaction?.type ?? session.compaction?.compactType ?? session.compaction?.compact_type, DEFAULT_COMPACT_TYPE),
                boundaryTokens: contextMeta.compactBoundaryTokens,
                bufferTokens: positiveContextWindow(session.compaction?.bufferTokens ?? session.compaction?.buffer) || session.compaction?.bufferTokens || null,
                keepTokens: positiveContextWindow(session.compaction?.keepTokens ?? session.compaction?.keep?.tokens) || session.compaction?.keepTokens || null,
                contextWindow: contextMeta.contextWindow,
                rawContextWindow: contextMeta.rawContextWindow,
                effectiveContextWindowPercent: contextMeta.effectiveContextWindowPercent,
                autoCompactTokenLimit: contextMeta.autoCompactTokenLimit,
            };
            // Cap caller-supplied / prefetched context so an oversized
            // payload can't blow the session token budget before the
            // first model call. 32 KB ~ 8k tokens at the 4 B/tok
            // working average; longer is silently truncated with a
            // visible marker so the model still sees the prefix and
            // a hint about the cut.
            const _CTX_CHAR_CAP = 32 * 1024;
            const _capCtx = (text) => {
                if (typeof text !== 'string') return '';
                if (text.length <= _CTX_CHAR_CAP) return text;
                return `${text.slice(0, _CTX_CHAR_CAP)}\n\n... [context truncated; original ${text.length} chars]`;
            };
            // Inline context + prefetch INTO the prompt as a single user turn,
            // marked with explicit section headers. The previous design pushed
            // context as separate user messages with pre-injected assistant
            // "Noted." acks; that conversational pattern taught some models a
            // low-effort rhythm and they responded with "Noted." / empty tags
            // even to the real task. Single-turn structure with a labelled
            // `# Task` block forces the model to treat the brief as the work
            // unit, not as another piece of context to ack.
            const explicitPrefetchResult = await _tryBridgeExplicitPrefetch(session, explicitPrefetch);
            let _contextBlock = '';
            if (context) {
                _contextBlock += `# Additional context\n${_capCtx(context)}\n\n`;
            }
            if (explicitPrefetchResult) {
                _contextBlock += `# Prefetch\n${_capCtx(explicitPrefetchResult)}\n\n`;
            }
            const historyMessages = sanitizeSessionMessagesForModel(session.messages);
            const beforeCount = historyMessages.length + 1;
            const promptTextForMetrics = promptContentText(prompt);
            // Soft warning only; real size management (compaction primary,
            // byte-budget trim as safety net) lives in agentLoop. Selecting a
            // 25% pre-trim here would starve compaction's 50% threshold.
            const softBudget = Math.floor(session.contextWindow * 0.25);
            const promptTokenEstimate = promptTextForMetrics.length * 0.5; // conservative for CJK
            if (promptTokenEstimate > softBudget * 0.7) {
                process.stderr.write(`[session] Warning: prompt is very large (est. ${Math.round(promptTokenEstimate)} tokens vs ${softBudget} soft budget)\n`);
            }
            const effectiveCwd = cwdOverride || session.cwd;
            const shouldInjectSessionStart = session.sessionStartMetaInjected !== true
                && !hasUserConversationMessage(historyMessages);
            const _sessionStartBlock = shouldInjectSessionStart
                ? buildSessionStartBlock(session, effectiveCwd)
                : '';
            const _currentTimeBlock = buildCurrentTimeBlock(prompt);
            const _turnReminderBlock = _currentTimeBlock
                ? `<system-reminder>\n# Current Time\n${_currentTimeBlock}\n</system-reminder>`
                : '';
            const _turnPrefixBlock = [_sessionStartBlock, _turnReminderBlock].filter(Boolean).join('\n\n');
            const _baseUserTurnContent = prefixUserTurnContent(prompt, _contextBlock);
            const _userTurnContent = prefixSessionStartContent(_baseUserTurnContent, _turnPrefixBlock);
            if (shouldInjectSessionStart && _sessionStartBlock) {
                session.sessionStartMetaInjected = true;
            }
            cancelledUserTurnContent = _userTurnContent;
            const outgoing = [...historyMessages, { role: 'user', content: _userTurnContent }];
            _turnOutgoing = outgoing;
            // Per-turn injected-context trace row (complements kind:"usage").
            // Cheap byte-length accounting — no hashing, no payload bodies.
            // Honors the same MIXDOG_AGENT_TRACE_DISABLE gate as usage rows;
            // appendAgentTrace is a no-op when that env is set.
            try {
                const _ctxBytes = Buffer.byteLength(context || '', 'utf8');
                const _prefetchBytes = Buffer.byteLength(explicitPrefetchResult || '', 'utf8');
                const _promptBytes = promptContentBytes(prompt);
                const _userTurnBytes = promptContentBytes(_userTurnContent);
                const _messagesBytes = Buffer.byteLength(JSON.stringify(historyMessages || []), 'utf8');
                const _totalBytes = _userTurnBytes + _messagesBytes;
                appendAgentTrace({
                    kind: 'context',
                    sessionId,
                    model: session.model,
                    provider: session.provider,
                    totalBytes: _totalBytes,
                    breakdown: {
                        contextBytes: _ctxBytes,
                        prefetchBytes: _prefetchBytes,
                        promptBytes: _promptBytes,
                        userTurnBytes: _userTurnBytes,
                        messagesBytes: _messagesBytes,
                        messagesCount: historyMessages.length,
                    },
                });
            } catch { /* trace must never break the ask path */ }
            const agentLoop = await _getAgentLoop();
            const priorToolApprovalHook = session.toolApprovalHook;
            if (typeof askOpts?.onToolApproval === 'function') {
                session.toolApprovalHook = askOpts.onToolApproval;
            }
            let result;
            try {
            result = await _api_call_with_interrupt(sessionId, (signal) =>
                agentLoop(provider, outgoing, session.model, session.tools, onToolCall, effectiveCwd, {
                    effort: session.effort || null,
                    fast: session.fast === true,
                    sessionId,
                    onTextDelta: typeof askOpts?.onTextDelta === 'function' ? askOpts.onTextDelta : undefined,
                    onReasoningDelta: typeof askOpts?.onReasoningDelta === 'function' ? askOpts.onReasoningDelta : undefined,
                    onAssistantText: typeof askOpts?.onAssistantText === 'function' ? askOpts.onAssistantText : undefined,
                    onUsageDelta: (d) => {
                        persistIterationMetrics(d).catch(() => {});
                        try { askOpts?.onUsageDelta?.(d); } catch {}
                    },
                    onToolResult: typeof askOpts?.onToolResult === 'function' ? askOpts.onToolResult : undefined,
                    onToolApproval: typeof askOpts?.onToolApproval === 'function' ? askOpts.onToolApproval : undefined,
                    onCompactEvent: typeof askOpts?.onCompactEvent === 'function' ? askOpts.onCompactEvent : undefined,
                    // Mid-turn steering drain. agentLoop calls this at every
                    // tool-batch boundary (before the next provider.send) and
                    // injects any returned strings as user turns — so input
                    // (user typing, `agent type=send`) that arrives WHILE a
                    // long multi-tool turn is in flight is picked up on the
                    // model's very next iteration instead of waiting for the
                    // whole task to finish. The post-turn _pendingTail drain
                    // below still handles "followUp" input that lands after the
                    // agent would otherwise stop. Same queue, two drain points.
                    drainSteering: (sid) => {
                        const out = [];
                        if (typeof askOpts?.drainSteering === 'function') {
                            try {
                                const drained = askOpts.drainSteering(sid || sessionId);
                                if (Array.isArray(drained)) out.push(...drained);
                            } catch { /* best-effort steering drain */ }
                        }
                        try { out.push(...drainPendingMessages(sid || sessionId)); }
                        catch { /* best-effort pending drain */ }
                        return out;
                    },
                    onSteerMessage: typeof askOpts?.onSteerMessage === 'function' ? askOpts.onSteerMessage : undefined,
                    notifyFn: typeof askOpts?.notifyFn === 'function' ? askOpts.notifyFn : undefined,
                    promptCacheKey: session.promptCacheKey || sessionId,
                    // Provider-scoped cache key (mixdog-codex, mixdog-claude…).
                    // Distinct from sessionId — providers that pool sockets
                    // per-session (openai-oauth WS) use sessionId as the
                    // pool bucket and providerCacheKey as the server-side
                    // prompt-cache shard so parallel callers don't collide
                    // on a mid-turn socket while still sharing prefix cache.
                    providerCacheKey: session.promptCacheKey || null,
                    signal,
                    providerState: session.providerState ?? undefined,
                    session,
                    // Agent Runtime cache settings — merged last so session overrides
                    // don't get overridden by defaults. When session has no profile,
                    // providerCacheOpts is null and this spread is a no-op.
                    ...(session.providerCacheOpts || {}),
                    onStageChange: (stage) => {
                        updateSessionStage(sessionId, stage);
                        try { askOpts?.onStageChange?.(stage); } catch {}
                    },
                    onStreamDelta: () => {
                        markSessionStreamDelta(sessionId).catch(() => {});
                        try { askOpts?.onStreamDelta?.(); } catch {}
                    },
                }),
            );
            } finally {
                if (priorToolApprovalHook === undefined) {
                    delete session.toolApprovalHook;
                } else {
                    session.toolApprovalHook = priorToolApprovalHook;
                }
            }
            // Post-loop validation: if closeSession() landed while we were awaiting,
            // drop the save so the tombstone on disk isn't overwritten.
            const currentRuntime = _runtimeState.get(sessionId);
            if (currentRuntime?.closed || currentRuntime?.generation !== askGeneration) {
                const reason = currentRuntime?.closedReason;
                throw new SessionClosedError(sessionId, `closed during call (reason=${reason || 'unknown'})`, reason || null);
            }
            // Update and save. outgoing is mutated in place by agentLoop
            // (compaction + safety trim), so its length reflects post-loop state.
            const messagesDropped = Math.max(0, beforeCount - outgoing.length);
            session.messages = sanitizeSessionMessagesForModel(outgoing);
            if (result.content || result.reasoningContent) {
                session.messages.push({
                    role: 'assistant',
                    // Keep content as-is in memory (model-visible). Image bytes,
                    // if any, are swapped for a placeholder only at disk write
                    // time inside the session store (store.mjs _sessionForDisk).
                    content: result.content || '',
                    ...(typeof result.reasoningContent === 'string' && result.reasoningContent
                        ? { reasoningContent: result.reasoningContent }
                        : {}),
                });
            } else {
                // Empty terminal turn: still persist a forensic record so
                // post-mortem inspection can distinguish "work landed but
                // synthesis missing" from "session never ran". Stop reason,
                // usage, iterations, and tool-call totals survive even when
                // the assistant produced no content/reasoning.
                const _emptyStop = result?.stopReason ?? result?.stop_reason ?? null;
                const _emptyUsage = result?.usage ? {
                    inputTokens: result.usage.inputTokens || 0,
                    outputTokens: result.usage.outputTokens || 0,
                    cachedTokens: result.usage.cachedTokens || 0,
                    cacheWriteTokens: result.usage.cacheWriteTokens || 0,
                } : null;
                // Provider content-block classification — distinguishes a
                // thinking-only stall (model emitted reasoning blocks but no
                // text/tool_use) from a true silent empty turn. Anthropic
                // providers (anthropic.mjs, anthropic-oauth.mjs) set these
                // fields on the result; other providers may omit them.
                const _emptyHasThinking = typeof result?.hasThinkingContent === 'boolean'
                    ? result.hasThinkingContent
                    : null;
                const _emptyBlockTypes = Array.isArray(result?.contentBlockTypes)
                    ? result.contentBlockTypes.slice()
                    : null;
                session.messages.push({
                    role: 'assistant',
                    content: '',
                    emptyFinal: true,
                    stopReason: _emptyStop,
                    iterations: result?.iterations ?? null,
                    toolCallsTotal: result?.toolCallsTotal ?? null,
                    usage: _emptyUsage,
                    ...(_emptyHasThinking !== null ? { hasThinkingContent: _emptyHasThinking } : {}),
                    ...(_emptyBlockTypes !== null ? { contentBlockTypes: _emptyBlockTypes } : {}),
                    ts: Date.now(),
                });
                try {
                    const _blockTypesStr = _emptyBlockTypes ? _emptyBlockTypes.join(',') || 'none' : 'unknown';
                    const _thinkingStr = _emptyHasThinking === null ? 'unknown' : String(_emptyHasThinking);
                    process.stderr.write(`[session] empty-final persisted sessionId=${sessionId} stopReason=${_emptyStop ?? 'unknown'} iterations=${result?.iterations ?? 0} toolCallsTotal=${result?.toolCallsTotal ?? 0} outTokens=${_emptyUsage?.outputTokens ?? 0} hasThinking=${_thinkingStr} blockTypes=${_blockTypesStr}\n`);
                } catch {}
            }
            session.updatedAt = Date.now();
            session.lastUsedAt = Date.now();
            applyAskTerminalUsageTotals(session, result, {
                skipTotalsIfIncremental: runtime?.usageMetricsTurnIncremental === true,
            });
            // Agent Runtime cache stats — record hit/miss after every successful
            // ask so the registry reflects all agent traffic, not just
            // maintenance cycles. Guarded against any agent-runtime error so
            // metric recording never breaks the ask itself.
            let prefixHashForLog = null;
            if (session.profileId && result.usage && _agentRuntimeApi) {
                try {
                    const profile = _agentRuntimeApi.getProfile(session.profileId);
                    if (profile) {
                        // Collect every leading system-role message (BP1, BP2, ...)
                        // until the first non-system message so the registry hash
                        // captures the full ordered provider prefix, not just BP1.
                        const systemMsgs = [];
                        for (const m of session.messages) {
                            if (m?.role !== 'system') break;
                            systemMsgs.push(typeof m.content === 'string' ? m.content : '');
                        }
                        _agentRuntimeApi.recordCall(profile, session.provider, {
                            systemPrompt: systemMsgs,
                            tools: session.tools || [],
                            usage: result.usage,
                        });
                        const entry = _agentRuntimeApi.registry?.data?.profiles?.[session.profileId]?.[session.provider];
                        prefixHashForLog = entry?.prefixHash || null;
                    }
                } catch {}
            }
            // Append to the agent trace store with rich usage fields.
            if (result.usage) {
                const inputTokens = result.usage.inputTokens || 0;
                const outputTokens = result.usage.outputTokens || 0;
                const cacheReadTokens = result.usage.cachedTokens || 0;
                const cacheWriteTokens = result.usage.cacheWriteTokens || 0;
                // Unified total-prompt field. Anthropic = input+cache_read+cache_write
                // (additive); OpenAI OAuth/API/Gemini = input_tokens already includes the
                // cached portion (inclusive), so the fallback must not double-count.
                const { isInclusiveProvider, computeCostUsd } = await import('../../../shared/llm/cost.mjs');
                const inclusive = isInclusiveProvider(session.provider);
                const promptTokens = typeof result.usage.promptTokens === 'number'
                    ? result.usage.promptTokens
                    : (inclusive
                        ? Math.max(inputTokens, cacheReadTokens + cacheWriteTokens)
                        : inputTokens + cacheReadTokens + cacheWriteTokens);
                let costUsd = result.usage.costUsd || 0;
                if (!costUsd) {
                    try {
                        costUsd = computeCostUsd({
                            model: session.model,
                            provider: session.provider,
                            inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
                        });
                    } catch { /* best-effort */ }
                }
                logLlmCall({
                    ts: new Date().toISOString(),
                    sourceType: session.sourceType || 'lead',
                    sourceName: session.sourceName || session.role || null,
                    preset: session.presetName || null,
                    model: session.model,
                    provider: session.provider,
                    duration: Date.now() - _askStartedAt,
                    profileId: session.profileId || null,
                    sessionId: session.id,
                    inputTokens,
                    outputTokens,
                    cacheReadTokens,
                    cacheWriteTokens,
                    promptTokens,
                    prefixHash: prefixHashForLog,
                    costUsd,
                });
                recordStandaloneStatusTelemetry(session, result, Date.now() - _askStartedAt);
            }
            // Persist opaque providerState for future stateful providers.
            // No provider currently emits it (openai-oauth is stateless per
            // contract), so this branch is dormant — kept so a future
            // Responses-API provider with stable continuation can plug in
            // without reworking the session shape.
            if (result.providerState !== undefined) {
                session.providerState = result.providerState;
            }
            const terminalResultPreview = {
                ...result,
                trimmed: messagesDropped > 0,
                messagesDropped,
            };
            _pwstTurnDrained = drainPendingMessages(sessionId);
            if (_pwstTurnDrained.length === 0 && typeof askOpts?.onTerminalResult === 'function') {
                try {
                    askOpts.onTerminalResult(terminalResultPreview, {
                        sessionId,
                        beforeSave: true,
                        durationMs: Date.now() - _askStartedAt,
                    });
                } catch { /* best-effort early completion relay */ }
            }
            // Auto-compact runs at the start of the next
            // query/provider send (agentLoop pre-send), not after the previous
            // answer. This lets queued follow-up prompts resume immediately;
            // if they need compaction, their own spinner shows compacting first.
            // Bounded, best-effort terminal save. The result is already produced
            // and (for agent surfaces) relayed via onTerminalResult above. If the
            // disk write stalls, blocking the terminal unwind here would strand the
            // owning background task in `running` and suppress its completion
            // notification. Cap the wait; let a slow write finish in the
            // background instead of holding askSession() open indefinitely.
            {
                const savePromise = saveSessionAsync(session, { expectedGeneration: askGeneration });
                let saveTimer = null;
                const saveTimeout = new Promise((resolveTimeout) => {
                    saveTimer = setTimeout(() => resolveTimeout('__save_timeout__'), TERMINAL_SAVE_TIMEOUT_MS);
                    saveTimer.unref?.();
                });
                try {
                    const outcome = await Promise.race([
                        savePromise.then(() => '__save_ok__', (err) => { throw err; }),
                        saveTimeout,
                    ]);
                    if (outcome === '__save_timeout__') {
                        try { process.stderr.write(`[session] terminal save exceeded ${TERMINAL_SAVE_TIMEOUT_MS}ms; continuing best-effort (${sessionId})\n`); } catch {}
                        // Don't drop the write — let it settle in the background.
                        savePromise.catch((err) => {
                            try { process.stderr.write(`[session] deferred terminal save failed: ${err?.message || err}\n`); } catch {}
                        });
                    }
                } finally {
                    if (saveTimer) { try { clearTimeout(saveTimer); } catch {} }
                }
            }
            activeSession = session;
            runtime.session = session;
            // Tag empty-synthesis BEFORE markSessionDone so the watchdog
            // (which inspects entry.emptyFinal first) classifies the
            // terminal state correctly even if it ticks during unwind.
            const isEmptyFinal = !result.content && !result.reasoningContent;
            if (isEmptyFinal) {
                markSessionEmptyFinal(sessionId);
            }
            markSessionDone(sessionId, { empty: isEmptyFinal });
            _result = terminalResultPreview;
        } catch (err) {
            if (err instanceof SessionClosedError) {
                const currentRuntime = _runtimeState.get(sessionId);
                if (!currentRuntime?.closed) {
                    if (activeSession) {
                        const originalMessages = Array.isArray(activeSession.messages) ? activeSession.messages : [];
                        const cleanedMessages = sanitizeSessionMessagesForModel(originalMessages);
                        const nextMessages = cleanedMessages.slice();
                        // In-memory cancelled turn keeps its original content
                        // (images intact for the next model send); the store
                        // layer placeholders image bytes on disk serialization.
                        const cancelledStoredContent = cancelledUserTurnContent;
                        const shouldPreserveUserTurn = cancelledStoredContent && !isInternalRuntimeNotificationText(cancelledStoredContent);
                        const lastMessage = nextMessages[nextMessages.length - 1];
                        if (shouldPreserveUserTurn && !(lastMessage?.role === 'user' && promptContentText(lastMessage.content) === promptContentText(cancelledStoredContent))) {
                            nextMessages.push({ role: 'user', content: cancelledStoredContent });
                        }
                        const messagesChanged = nextMessages.length !== originalMessages.length
                            || nextMessages.some((message, index) => message !== originalMessages[index]);
                        if (messagesChanged) {
                            activeSession.messages = nextMessages;
                            activeSession.updatedAt = Date.now();
                            activeSession.lastUsedAt = Date.now();
                            try {
                                await saveSessionAsync(activeSession, { expectedGeneration: askGeneration });
                            } catch { /* cancellation cleanup is best-effort */ }
                        }
                    }
                    markSessionCancelled(sessionId);
                }
                // Cancellation is not an error; propagate silently so callers
                // can render it as "cancelled" rather than a red failure.
                throw err;
            }
            await persistCompactedOutgoingAfterAskFailure({
                sessionId,
                activeSession,
                askGeneration,
                turnOutgoing: _turnOutgoing,
                error: err,
            });
            markSessionError(sessionId, err && err.message ? err.message : String(err));
            throw err;
        }
        // ── Turn complete. Drain the pending-message queue: any `agent type=send` that arrived while this
        //    turn was in flight runs next, in order, as a follow-up user turn.
        //    The mutex is still held, so a send racing this drain either landed
        //    before (picked up here) or enqueues for the next loop. When the
        //    queue is empty we return the latest turn's result. ──
        const _drained = _pwstTurnDrained || drainPendingMessages(sessionId);
        if (_drained.length > 0) {
            // Same merge rule as the mid-turn steering drain (loop.mjs) and
            // the TUI engine.mjs drain(): a single drain batch is joined with
            // "\n" and delivered as ONE follow-up turn, not N isolated turns.
            // Keeps every steering/follow-up path on identical
            // merge-then-deliver semantics. Anything that arrives AFTER this
            // drain enqueues for the next loop pass and is merged there.
            const _mergedTail = _mergePendingMessageEntries(_drained);
            if (_mergedTail?.content) {
                _pendingTail.push(_mergedTail.content);
                const refreshed = loadSession(sessionId);
                if (refreshed && refreshed.closed !== true) {
                    activeSession = refreshed;
                    runtime.session = refreshed;
                }
                continue;
            }
        }
        _unlinkParentAbortListener(_runtimeState.get(sessionId));
        return _result;
      }
    } finally {
        // Clear the controller only if it's still ours (closeSession may have
        // swapped it). Leave the rest of the runtime entry intact so agent type=list
        // can still surface the final stage (done/error/cancelling).
        const entry = _runtimeState.get(sessionId);
        if (entry && entry.generation === askGeneration) {
            _unlinkParentAbortListener(entry);
            entry.controller = null;
            // Detach the live session reference; ask is over.
            entry.session = null;
        }
        unlock();
    }
}
// Session lookup by scopeKey — used by CLI agent to resume a pinned
// scope session when the caller passes --scope (agent/<name>).
export function findSessionByScopeKey(scopeKey) {
    if (!scopeKey) return null;
    const summaries = listStoredSessionSummaries();
    // Exclude tombstoned sessions (`closed === true`) so callers never receive
    // a session whose controller was aborted by closeSession(). The `closed`
    // bit is the authoritative tombstone flag; `status === 'error'` is not,
    // since transient-error sessions remain resumable.
    const summary = summaries.find(s => s.scopeKey === scopeKey && s.closed !== true) || null;
    return summary?.id ? loadSession(summary.id) : null;
}
// --- resume (reload tools for a stored session) ---
export async function resumeSession(sessionId, preset) {
    const session = loadSession(sessionId);
    if (!session)
        return null;
    // Resuming a closed session is a resurrection attempt — refuse. The guarded
    // save below would also block the write, but failing fast here is cleaner
    // than silently dropping the tool-refresh side effects.
    if (session.closed === true) return null;
    if (!session.owner) session.owner = 'user';
    // Refresh tools (MCP connections may have changed).
    // Re-resolve from profile.tools when the session stored a profileId —
    // otherwise fall back to preset.tools. Same resolution order as
    // createSession so resume and spawn produce identical BP_1 shapes.
    const oldTools = session.tools || [];
    const ownerIsAgent = isAgentOwner(session);
    const skills = ownerIsAgent ? [] : collectSkillsCached(session.cwd);
    let toolSpec = preset || session.preset || 'full';
    if (session.profileId && _agentRuntimeApi?.getProfile) {
        try {
            const profile = _agentRuntimeApi.getProfile(session.profileId);
            if (Array.isArray(profile?.tools)) toolSpec = profile.tools;
        } catch { /* ignore lookup failures, keep preset fallback */ }
    }
    session.tools = resolveSessionTools(toolSpec, skills, { ownerIsAgentSession: ownerIsAgent });
    const newTools = session.tools;
    const missing = oldTools.filter(t => !newTools.find(n => n.name === t.name));
    if (missing.length) {
        process.stderr.write(`[session] Warning: ${missing.length} tools no longer available: ${missing.map(t => t.name).join(', ')}\n`);
    }
    await saveSessionAsync(session, { expectedGeneration: session.generation });
    return session;
}
// --- CRUD ---
export function getSession(id) {
    return loadSession(id);
}
export function listSessions(opts = {}) {
    const includeClosed = opts.includeClosed === true;
    const sessions = listStoredSessionSummaries();
    const hiddenIds = new Set([..._runtimeState.entries()].filter(([, e]) => e.listHidden).map(([id]) => id));
    // Tombstoned sessions (closed===true) are excluded unless the caller opts in
    // (e.g. agent list includeClosed:true).
    return sessions.filter(s => !hiddenIds.has(s.id) && (includeClosed || s.closed !== true));
}
// --- Clear messages (keep system prompt + provider/model/cwd) ---
export async function clearSessionMessages(sessionId, options = {}) {
    const session = loadSession(sessionId);
    if (!session)
        return false;
    // Don't resurrect a closed session just to clear its messages.
    if (session.closed === true) return false;
    const clearOptions = options && typeof options === 'object' ? options : {};
    const requestedCompactType = clearOptions.compactType ?? clearOptions.compact_type ?? clearOptions.type;
    const compactBeforeClear = requestedCompactType != null && requestedCompactType !== false && String(requestedCompactType).trim() !== '';
    const keep = [];
    let messages = Array.isArray(session.messages) ? session.messages : [];
    const beforeMessageTokens = estimateMessagesTokens(messages);
    let clearCompactType = null;
    let clearCompactError = null;
    if (compactBeforeClear && messages.length >= 3) {
        clearCompactType = normalizeCompactType(requestedCompactType, DEFAULT_COMPACT_TYPE);
        session.compaction = {
            ...(session.compaction || {}),
            type: clearCompactType,
            compactType: clearCompactType,
        };
        try {
            const compactResult = await runSessionCompaction(session, { mode: 'manual', force: true, sessionId });
            if (compactResult?.error) {
                clearCompactError = new Error(compactResult.error);
            }
        } catch (err) {
            clearCompactError = err;
            try { process.stderr.write(`[session] auto-clear pre-compact failed (sess=${sessionId}): ${err?.message || err}\n`); } catch { /* best-effort */ }
        }
        messages = Array.isArray(session.messages) ? session.messages : [];
    }
    if (compactBeforeClear && clearOptions.requireCompactSuccess === true) {
        const hasRetainedSummary = messages.some((m) => (
            m?.role === 'user'
            && typeof m.content === 'string'
            && m.content.startsWith(SUMMARY_PREFIX)
        ));
        if (!hasRetainedSummary && !clearCompactError) {
            clearCompactError = new Error('compact produced no retained summary');
        }
    }
    if (clearCompactError && clearOptions.requireCompactSuccess === true) {
        const now = Date.now();
        session.compaction = {
            ...(session.compaction || {}),
            lastStage: 'auto_clear_failed',
            lastCheckedAt: now,
            lastChanged: false,
            lastClearAt: session.compaction?.lastClearAt || null,
            lastClearCompactType: clearCompactType || session.compaction?.compactType || null,
            lastClearCompactError: clearCompactError?.message || String(clearCompactError),
        };
        session.updatedAt = now;
        await saveSessionAsync(session, { expectedGeneration: session.generation });
        throw new Error(`auto-clear compact failed; conversation kept: ${session.compaction.lastClearCompactError}`);
    }
    const preserveCompactSummary = compactBeforeClear && clearOptions.keepCompactSummary !== false;
    for (let i = 0; i < messages.length; i += 1) {
        const m = messages[i];
        if (!m) continue;
        if (m.role === 'system') {
            // BP1/BP2/BP3 all ride `role:'system'` blocks now (BP3 sessionMarker
            // moved off the `<system-reminder>` user wrapper), so the stable
            // memory/meta layer is preserved here unconditionally — no sentinel
            // scan / dummy-assistant pairing needed anymore.
            keep.push(m);
            continue;
        }
        if (preserveCompactSummary
            && m.role === 'user'
            && typeof m.content === 'string'
            && m.content.startsWith(SUMMARY_PREFIX)) {
            keep.push(m);
        }
    }
    const afterMessageTokens = estimateMessagesTokens(keep);
    const reserveTokens = estimateRequestReserveTokens(session.tools || []);
    const beforeTokens = Math.max(beforeMessageTokens + reserveTokens, positiveContextWindow(session.lastContextTokens) || 0);
    const afterTokens = afterMessageTokens + reserveTokens;
    const now = Date.now();
    session.messages = keep;
    session.totalInputTokens = 0;
    session.totalOutputTokens = 0;
    session.totalCachedReadTokens = 0;
    session.totalCacheWriteTokens = 0;
    session.lastInputTokens = 0;
    session.lastOutputTokens = 0;
    session.lastCachedReadTokens = 0;
    session.lastCacheWriteTokens = 0;
    session.lastContextTokens = 0;
    session.lastContextTokensUpdatedAt = now;
    session.lastContextTokensStaleAfterCompact = false;
    session.providerState = undefined;
    session.compaction = {
        ...(session.compaction || {}),
        lastStage: 'auto_clear',
        lastBeforeTokens: beforeTokens,
        lastAfterTokens: afterTokens,
        lastBeforeMessageTokens: beforeMessageTokens,
        lastAfterMessageTokens: afterMessageTokens,
        lastPressureTokens: beforeTokens,
        lastCheckedAt: now,
        lastChanged: beforeTokens !== afterTokens,
        lastClearAt: now,
        lastClearBeforeTokens: beforeTokens,
        lastClearAfterTokens: afterTokens,
        lastClearBeforeMessageTokens: beforeMessageTokens,
        lastClearAfterMessageTokens: afterMessageTokens,
        lastClearCompactType: clearCompactType || session.compaction?.compactType || null,
        lastClearCompactError: clearCompactError?.message || null,
    };
    session.updatedAt = now;
    await saveSessionAsync(session, { expectedGeneration: session.generation });
    return session;
}
export async function compactSessionMessages(sessionId) {
    const session = loadSession(sessionId);
    if (!session) return null;
    if (session.closed === true) return null;
    if (isSessionCompactionBlocked(sessionId)) {
        return { changed: false, reason: 'compact skipped: turn in progress' };
    }
    const result = await runSessionCompaction(session, {
        mode: 'manual',
        force: true,
        provider: getProvider(session.provider),
        model: session.model,
        sessionId,
        signal: getSessionAbortSignal(sessionId),
    });
    if (!result) return null;
    const now = Date.now();
    if (!result.error) {
        session.lastInputTokens = 0;
        session.lastOutputTokens = 0;
        session.lastCachedReadTokens = 0;
        session.lastCacheWriteTokens = 0;
        session.lastContextTokens = 0;
        session.lastContextTokensUpdatedAt = now;
        session.lastContextTokensStaleAfterCompact = false;
    }
    session.updatedAt = Date.now();
    await saveSessionAsync(session, { expectedGeneration: session.generation });
    return result;
}
export async function updateSessionStatus(id, status) {
    const session = loadSession(id);
    if (!session) return false;
    // Respect tombstones — don't resurrect a closed session just to update a
    // status label (agent handler emits running→idle/error around askSession).
    if (session.closed === true) return false;
    session.status = status;
    session.updatedAt = Date.now();
    await saveSessionAsync(session, { expectedGeneration: session.generation });
    return true;
}
/**
 * Close a session. Plants a `closed=true` tombstone on disk with a bumped
 * generation (so any racing saveSession() drops its write), aborts the
 * in-flight controller if one exists, and clears the in-memory runtime entry.
 *
 * IMPORTANT: we deliberately do NOT unlink the session file here. The tombstone
 * on disk is the authoritative signal that blocks resurrection — a late
 * saveSession() re-reads disk via _shouldDrop() and will find the tombstone.
 * If we delete the file, a late save sees no file, decides nothing to drop,
 * and recreates the session in its pre-close state.
 *
 * Long-term cleanup: `sweepTombstones()` below unlinks tombstones older than
 * TOMBSTONE_MAX_AGE_MS (24h — vastly longer than any realistic in-flight race).
 */
export function closeSession(id, reason = 'manual') {
    if (!id) return false;
    _stopToolActivityHeartbeat(id);
    // Prefer in-memory runtime session — allBashSessionIds may not be persisted
    // yet for shells opened in the current turn (BL-bash-disk-sync).
    const inMemory = _runtimeState.get(id)?.session;
    const persisted = inMemory || loadSession(id);
    const bashSessionId = persisted?.implicitBashSessionId || null;
    // Collect all persistent bash shells created during this session.
    const allBashIds = Array.isArray(persisted?.allBashSessionIds)
        ? persisted.allBashSessionIds.filter(Boolean)
        : (bashSessionId ? [bashSessionId] : []);
    // Deduplicate: allBashIds already covers implicitBashSessionId, but guard
    // against old session records that only have implicitBashSessionId.
    if (bashSessionId && !allBashIds.includes(bashSessionId)) allBashIds.push(bashSessionId);
    // 1. Tombstone first — this wins the race against saveSession().
    const newGen = markSessionClosed(id, reason);
    // 2. Mark runtime as closed so post-await validation in askSession fires.
    const entry = _runtimeState.get(id);
    if (entry) {
        entry.closed = true;
        entry.closedReason = reason;
        if (typeof newGen === 'number') entry.generation = newGen;
        entry.stage = 'cancelling';
        entry.updatedAt = Date.now();
        // 3. Abort the in-flight controller. Providers that honour the signal
        //    unwind immediately; providers that don't will still be caught by
        //    the generation check after their await eventually returns.
        try { entry.controller?.abort(new SessionClosedError(id, `closeSession (reason=${reason})`, reason)); } catch { /* ignore */ }
    }
    // Diagnostic: one-line stderr so operators can distinguish the four close
    // pathways (request-abort / manual / idle-sweep / runner-crash). iterCount
    // is not currently tracked on runtime state; askStartedAt is — derive
    // duration from it when present.
    try {
        const askStartedAt = entry?.askStartedAt;
        const durationMs = (typeof askStartedAt === 'number') ? (Date.now() - askStartedAt) : null;
        const parts = [`session=${id}`, `reason=${reason}`];
        if (durationMs != null) parts.push(`duration=${durationMs}ms`);
        if (process.env.MIXDOG_DEBUG_SESSION_LOG) process.stderr.write(`[agent-close] ${parts.join(' ')}\n`);
    } catch { /* best-effort */ }
    for (const bsid of allBashIds) {
        try { _closeBashSessionLazy(bsid, `agent-close:${id}`); } catch { /* ignore */ }
    }
    // Drop session-scoped read dedup cache so the Map doesn't accumulate
    // entries across mcp-server lifetime.
    try { clearReadDedupSession(id); } catch { /* ignore */ }
    // Drop offload sidecars + module-level counter for this session so a
    // long-running mcp-server doesn't leak disk (tool-results/<id>/*.txt)
    // or Map entries across session lifetime. Fire-and-forget — close path
    // should not await disk IO; errors are swallowed inside.
    try { clearOffloadSession(id); } catch { /* ignore */ }
    // 4. Defer runtime map clear to next tick so any settling askSession can
    //    observe `closed=true` / bumped generation before we yank the entry.
    //    Disk tombstone remains — that's what blocks resurrection.
    setImmediate(() => {
        _clearSessionRuntime(id);
    });
    return true;
}
export function abortSessionTurn(id, reason = 'turn-abort') {
    if (!id) return false;
    _stopToolActivityHeartbeat(id);
    const entry = _runtimeState.get(id);
    if (!entry || entry.closed) return false;
    entry.stage = 'cancelling';
    entry.closedReason = reason;
    entry.updatedAt = Date.now();
    try {
        entry.controller?.abort(new SessionClosedError(id, `abortSessionTurn (reason=${reason})`, reason));
    } catch { /* ignore */ }
    return true;
}

// --- Periodic idle session cleanup ---
const CLEANUP_INTERVAL_MS = nonNegativeIntEnv('MIXDOG_SESSION_CLEANUP_INTERVAL_MS', 5 * 60 * 1000); // check every 5 minutes
const CLEANUP_INITIAL_DELAY_MS = nonNegativeIntEnv('MIXDOG_SESSION_CLEANUP_INITIAL_DELAY_MS', CLEANUP_INTERVAL_MS > 0 ? CLEANUP_INTERVAL_MS : 0);
const CLEANUP_SLOW_LOG_MS = nonNegativeIntEnv('MIXDOG_SESSION_CLEANUP_SLOW_LOG_MS', 250);
const TOMBSTONE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — far longer than any realistic ask race window
let _cleanupTimer = null;
let _cleanupInitialTimer = null;

function nonNegativeIntEnv(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function _previewIds(items, limit = 5) {
    const ids = (items || []).slice(0, limit).map((item) => item.id).filter(Boolean);
    if (ids.length === 0) return '';
    const more = items.length > limit ? `, +${items.length - limit} more` : '';
    return ` (${ids.join(', ')}${more})`;
}

function sweepIdleSessions({ includeTombstones = true } = {}) {
    const startedAt = Date.now();
    try {
        const result = sweepStaleSessions({
            tombstoneMaxAgeMs: includeTombstones ? TOMBSTONE_MAX_AGE_MS : 0,
        });
        const {
            cleaned,
            remaining,
            details,
            tombstonesCleaned = 0,
            tombstoneDetails = [],
            tombstoneErrors = [],
        } = result;
        if (cleaned > 0) {
            for (const d of details) {
                // Skip entries with an active in-flight controller — aborting
                // them via closeSession() is the safe path; clearing the runtime
                // without signalling the controller leaves orphan provider work.
                const rtEntry = _runtimeState.get(d.id);
                if (rtEntry && rtEntry.controller && !rtEntry.controller.signal?.aborted) {
                    try { closeSession(d.id, 'idle-sweep'); } catch { /* ignore */ }
                } else {
                    _clearSessionRuntime(d.id);
                    if (d.bashSessionId) {
                        try { _closeBashSessionLazy(d.bashSessionId, `idle-sweep:${d.id}`); } catch { /* ignore */ }
                    }
                }
                process.stderr.write(`[agent-session] idle cleanup: closed ${d.id} (idle ${d.idleMinutes}m, owner=${d.owner})\n`);
            }
            process.stderr.write(`[agent-session] idle sweep: cleaned ${cleaned} session(s), ${remaining} remaining\n`);
        }
        if (tombstonesCleaned > 0) {
            for (const d of tombstoneDetails) {
                if (d?.id) _clearSessionRuntime(d.id);
            }
            process.stderr.write(`[session-sweep] unlinked ${tombstonesCleaned} tombstone(s)${_previewIds(tombstoneDetails)}\n`);
        }
        if (tombstoneErrors.length > 0) {
            const first = tombstoneErrors[0];
            process.stderr.write(`[session-sweep] tombstone unlink failed for ${tombstoneErrors.length} session(s): ${first?.id || 'unknown'} ${first?.message || ''}\n`);
        }
        const elapsed = Date.now() - startedAt;
        if (elapsed >= CLEANUP_SLOW_LOG_MS) {
            process.stderr.write(`[session-sweep] cleanup took ${elapsed}ms (idle=${cleaned}, tombstones=${tombstonesCleaned}, remaining=${remaining})\n`);
        }
    } catch (e) {
        process.stderr.write(`[agent-session] idle sweep error: ${e && e.message || e}\n`);
    }
}

/**
 * Unlink tombstone session files (closed=true) older than TOMBSTONE_MAX_AGE_MS.
 *
 * Rationale: closeSession() leaves the tombstone on disk as the authoritative
 * resurrection-blocker for racing saveSession() calls. That race resolves in
 * microseconds (the window inside _doSave between temp write and rename), so
 * 24h is vastly safe. After the TTL expires we reclaim the disk slot.
 *
 * Uses `getStoredSessionsRaw()` rather than `listStoredSessions()` because the
 * latter's inline 30-min idle cleanup would race-unlink tombstones before we
 * get to log them — we want to own the unlink decision and stderr line here.
 */
export function sweepTombstones() {
    try {
        const { tombstonesCleaned = 0, tombstoneDetails = [], tombstoneErrors = [] } = sweepStaleSessions({
            sweepIdle: false,
            tombstoneMaxAgeMs: TOMBSTONE_MAX_AGE_MS,
        });
        for (const d of tombstoneDetails) {
            if (d?.id) _clearSessionRuntime(d.id);
        }
        if (tombstonesCleaned > 0) {
            process.stderr.write(`[session-sweep] unlinked ${tombstonesCleaned} tombstone(s)${_previewIds(tombstoneDetails)}\n`);
        }
        if (tombstoneErrors.length > 0) {
            const first = tombstoneErrors[0];
            process.stderr.write(`[session-sweep] tombstone unlink failed for ${tombstoneErrors.length} session(s): ${first?.id || 'unknown'} ${first?.message || ''}\n`);
        }
        return tombstonesCleaned;
    } catch (e) {
        process.stderr.write(`[session-sweep] tombstone sweep error: ${e && e.message || e}\n`);
        return 0;
    }
}

function hasActiveRuntimeWork() {
    for (const [, entry] of _runtimeState) {
        if (!entry || entry.closed === true) continue;
        if (entry.controller && !entry.controller.signal?.aborted) return true;
        if (['connecting', 'requesting', 'streaming', 'tool_running', 'cancelling'].includes(entry.stage)) return true;
    }
    return false;
}

function _runCleanupCycle() {
    if (hasActiveRuntimeWork()) return;
    sweepIdleSessions({ includeTombstones: true });
}

function _startCleanupInterval() {
    if (_cleanupTimer) return;
    if (CLEANUP_INTERVAL_MS <= 0) return;
    _cleanupTimer = setInterval(_runCleanupCycle, CLEANUP_INTERVAL_MS);
    if (_cleanupTimer.unref) _cleanupTimer.unref(); // don't block process exit
}

export function startIdleCleanup() {
    if (_cleanupTimer || _cleanupInitialTimer) return;
    if (CLEANUP_INITIAL_DELAY_MS <= 0) {
        _runCleanupCycle();
        _startCleanupInterval();
        return;
    }
    _cleanupInitialTimer = setTimeout(() => {
        _cleanupInitialTimer = null;
        _runCleanupCycle();
        _startCleanupInterval();
    }, CLEANUP_INITIAL_DELAY_MS);
    if (_cleanupInitialTimer.unref) _cleanupInitialTimer.unref();
}

export function stopIdleCleanup() {
    if (_cleanupInitialTimer) {
        clearTimeout(_cleanupInitialTimer);
        _cleanupInitialTimer = null;
    }
    if (_cleanupTimer) {
        clearInterval(_cleanupTimer);
        _cleanupTimer = null;
    }
}
