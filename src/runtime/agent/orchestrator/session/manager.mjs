import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { randomBytes, createHash } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';
import { getProvider, providerInputExcludesCache } from '../providers/registry.mjs';
import { agentLoop } from './loop.mjs';
import { compactActiveTurn, compactMessages } from './compact.mjs';
import { estimateMessagesTokens, estimateRequestReserveTokens } from './context-utils.mjs';
import { getMcpTools } from '../mcp/client.mjs';
import { getInternalTools, executeInternalTool } from '../internal-tools.mjs';
import { BUILTIN_TOOLS } from '../tools/builtin.mjs';
import { PATCH_TOOL_DEFS } from '../tools/patch-tool-defs.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../tools/code-graph-tool-defs.mjs';
import { executeCodeGraphTool } from '../tools/code-graph.mjs';
import { closeBashSession } from '../tools/bash-session.mjs';
import { collectSkillsCached, buildSkillToolDefs, loadAgentTemplate, loadRoleTemplate, composeSystemPrompt, collectProjectMd } from '../context/collect.mjs';
import { saveSession, saveSessionAsync, loadSession, deleteSession, listStoredSessions, getStoredSessionsRaw, sweepStaleSessions, markSessionClosed, publishHeartbeat, deleteHeartbeat, setLiveSession } from './store.mjs';
import { clearReadDedupSession, tryPrefetchCached, setPrefetchCached } from './read-dedup.mjs';
import { clearOffloadSession } from './tool-result-offload.mjs';
import { classifyResultKind } from './result-classification.mjs';
import { createAbortController } from '../../../shared/abort-controller.mjs';
import { logLlmCall } from '../../../shared/llm/usage-log.mjs';
import { resolvePluginData, DEFAULT_PLUGIN, DEFAULT_MARKETPLACE } from '../../../shared/plugin-paths.mjs';
import { updateJsonAtomicSync } from '../../../shared/atomic-file.mjs';
import { appendBridgeTrace } from '../bridge-trace.mjs';
import { maxMtimeRecursive } from '../cache-mtime.mjs';
import { getRoleInstructionDir } from '../internal-roles.mjs';
// Phase B: Pool B Tier 2 content builder (common rules only).
// Loaded once per process via createRequire so the CJS module reaches us.
const _require = createRequire(import.meta.url);
const _rulesBuilder = (() => {
    const candidates = [
        process.env.CLAUDE_PLUGIN_ROOT && join(process.env.CLAUDE_PLUGIN_ROOT, 'lib', 'rules-builder.cjs'),
    ].filter(Boolean);
    for (const p of candidates) {
        try { return _require(p); } catch { /* fall through */ }
    }
    // Fallback: walk up from this file's location to find lib/rules-builder.cjs.
    try { return _require('../../../../lib/rules-builder.cjs'); } catch { return null; }
})();

// bridgeRules is the bridge shared prefix (shared rules + bridge common rules +
// user agent configs). It's rebuilt from disk
// by rules-builder.cjs on every call; since createSession fires on every
// Pool B/C bridge turn, that's a lot of redundant readFileSync + concat.
// BP1/BP3 cache — invalidated by source file mtime, not a timer.
// Cheap: O(sentinel-count) stat calls on each bridge turn, no I/O otherwise.
// BP1 cache — single shared entry. buildBridgeInjectionContent is
// role-agnostic (true cross-role common), so every bridge role reuses the
// same prefix bytes.
let _bridgeRulesCache = null;
let _bridgeRulesMtime = 0;
function _buildBridgeRules() {
    if (!_rulesBuilder || typeof _rulesBuilder.buildBridgeInjectionContent !== 'function') return '';
    const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT
        || join(homedir(), '.claude', 'plugins', 'marketplaces', DEFAULT_MARKETPLACE, 'external_plugins', DEFAULT_PLUGIN);
    const DATA_DIR = resolvePluginData();
    const RULES_DIR = join(PLUGIN_ROOT, 'rules');
    const mtime = maxMtimeRecursive([
        join(RULES_DIR, 'shared'),
        join(RULES_DIR, 'bridge'),
        join(DATA_DIR, 'roles'),
        join(DATA_DIR, 'mixdog-config.json'),
    ]);
    if (_bridgeRulesCache !== null && mtime <= _bridgeRulesMtime) {
        return _bridgeRulesCache;
    }
    try {
        const built = _rulesBuilder.buildBridgeInjectionContent({ PLUGIN_ROOT, DATA_DIR });
        _bridgeRulesCache = built;
        _bridgeRulesMtime = mtime;
        return built;
    } catch (e) {
        throw new Error(`[session] bridge common rules build failed: ${e.message}`);
    }
}

let _leadRulesCache = null;
let _leadRulesMtime = 0;
function _buildLeadRules() {
    if (!_rulesBuilder || typeof _rulesBuilder.buildInjectionContent !== 'function') return '';
    const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT
        || join(homedir(), '.claude', 'plugins', 'marketplaces', DEFAULT_MARKETPLACE, 'external_plugins', DEFAULT_PLUGIN);
    const DATA_DIR = resolvePluginData();
    const RULES_DIR = join(PLUGIN_ROOT, 'rules');
    const mtime = maxMtimeRecursive([
        join(RULES_DIR, 'shared'),
        join(RULES_DIR, 'lead'),
        join(DATA_DIR, 'history'),
        join(DATA_DIR, 'mixdog-config.json'),
        join(DATA_DIR, 'user-workflow.json'),
        join(DATA_DIR, 'user-workflow.md'),
    ]);
    if (_leadRulesCache !== null && mtime <= _leadRulesMtime) {
        return _leadRulesCache;
    }
    try {
        const built = _rulesBuilder.buildInjectionContent({ PLUGIN_ROOT, DATA_DIR });
        _leadRulesCache = built;
        _leadRulesMtime = mtime;
        return built;
    } catch (e) {
        throw new Error(`[session] lead rules build failed: ${e.message}`);
    }
}

// BP3 role-specific cache — keyed by role. webhook / schedule / hidden
// retrieval roles each have their own scoped instruction set; other roles
// return ''.
const _roleSpecificCache = new Map(); // role → { value, mtime }
function _buildRoleSpecific(currentRole) {
    if (!_rulesBuilder || typeof _rulesBuilder.buildBridgeRoleSpecificContent !== 'function') return '';
    if (!currentRole) return '';
    const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT
        || join(homedir(), '.claude', 'plugins', 'marketplaces', DEFAULT_MARKETPLACE, 'external_plugins', DEFAULT_PLUGIN);
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
        const built = _rulesBuilder.buildBridgeRoleSpecificContent({ PLUGIN_ROOT, DATA_DIR, currentRole });
        _roleSpecificCache.set(currentRole, { mtime, value: built });
        return built;
    } catch (e) {
        throw new Error(`[session] role-specific rules build failed (role: ${currentRole}): ${e.message}`);
    }
}

// Smart Bridge is optional — injected via setSmartBridge() during plugin init
// so session creation never depends on a circular import. If never injected,
// createSession simply falls back to classic preset-only behavior.
let _smartBridgeApi = null;
let _smartBridgeWarned = false;

/**
 * Inject the Smart Bridge singleton. Called once by agent/index.mjs init()
 * after initSmartBridge(). Safe to call multiple times — later calls
 * replace the previous reference.
 */
export function setSmartBridge(api) {
    _smartBridgeApi = api || null;
}

function getSmartBridgeSync() {
    return _smartBridgeApi;
}

/**
 * Thrown when a session is closed while a call is in-flight. Callers (bridge
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

// Merge externally-connected MCP tools with the plugin's in-process tools
// (registered by agent's toolExecutor bridge). Internal tools are exposed
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
        // bridgeHidden can be read during deny filtering.
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
// with permission or role. Bridge sessions share the same schema so BP_1
// stays bit-identical and the provider-side cache shard is shared
// workspace-wide. Rare specialist roles may pass schemaAllowedTools from a
// declarative hidden-role toolSchemaProfile to keep their first-turn routing
// surface intentionally tiny; runtime permission guards in loop.mjs remain
// the fail-safe either way.

const SESSION_ROUTE_TOOL_ORDER = [
    'code_graph',
    'glob',
    'list',
    'grep',
    'read',
    'edit',
    'write',
    'apply_patch',
    'bash',
    'job_wait',
];
const SESSION_ROUTE_TOOL_RANK = new Map(SESSION_ROUTE_TOOL_ORDER.map((name, index) => [name, index]));
const FILESYSTEM_TOOL_NAMES = new Set([
    'code_graph',
    'glob',
    'list',
    'grep',
    'read',
    'edit',
    'write',
    'apply_patch',
]);
const READONLY_TOOL_NAMES = new Set([
    'code_graph',
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

function resolveSessionTools(toolSpec, skills, { ownerIsBridge = false } = {}) {
    const mcp = _getMcpTools();
    // Bridge sessions freeze the 3 skill meta-tools into the schema
    // unconditionally — concrete skill resolution is cwd-scoped at tool-call
    // time (loop.mjs), so the schema bytes stay bit-identical across roles /
    // cwds and the provider cache shard does not fragment.
    const skillTools = buildSkillToolDefs(skills, { ownerIsBridge });
    return _computeBaseTools(toolSpec, mcp, skillTools);
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

// Bridge visibility is declared per-tool via annotations.bridgeHidden.
// Tools with bridgeHidden:true are stripped from bridge sessions at schema
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
                case 'tools:bash':
                case 'tools:git':
                case 'tools:analysis':
                    // Three aliases for the same surface — `bash` is the only
                    // shell-class tool. `tools:git` / `tools:analysis` exist so
                    // profile authors can name the intent (git workflows / data
                    // analysis) without inventing new toolset ids.
                    addMany(ALL_BUILTIN_SESSION_TOOLS.filter(t => t.name === 'bash'));
                    break;
                case 'tools:mcp':
                    addMany(mcp);
                    break;
                case 'tools:search':
                    // Name-pattern match: picks up `search` and any future tool
                    // whose name contains `search`. `recall` and `explore` deliberately do NOT match
                    // — they need `tools:mcp` (full mcp surface) or their own
                    // toolset id if a role wants targeted retrieval. Public bridge
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
            || tags.has('tools:bash')
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
function boundedPercent(value, fallback = null) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0 && n <= 100) return n;
    return fallback;
}
function providerNameOf(provider) {
    return String(provider?.name || provider?.id || '').toLowerCase();
}
function defaultEffectiveContextWindowPercent(provider) {
    // Codex exposes both the raw catalog window and a smaller effective window
    // that reserves provider-side headroom. Mirror the gateway/statusline math
    // so bridge workers compact at the same boundary as the visible session.
    return providerNameOf(provider) === 'openai-oauth' ? 95 : null;
}
function resolveSessionContextMeta(provider, model, seed = {}) {
    const info = typeof provider?.getCachedModelInfo === 'function'
        ? provider.getCachedModelInfo(model)
        : null;
    const rawContextWindow = positiveContextWindow(info?.contextWindow)
        || positiveContextWindow(info?.maxContextWindow)
        || positiveContextWindow(info?.context_window)
        || positiveContextWindow(info?.max_context_window)
        || positiveContextWindow(seed.rawContextWindow)
        || positiveContextWindow(seed.raw_context_window)
        || positiveContextWindow(seed.contextWindow)
        || guessContextWindow(model);
    const effectiveContextWindowPercent = boundedPercent(
        seed.effectiveContextWindowPercent
            ?? seed.effective_context_window_percent
            ?? info?.effectiveContextWindowPercent
            ?? info?.effective_context_window_percent,
        defaultEffectiveContextWindowPercent(provider),
    );
    const pct = boundedPercent(effectiveContextWindowPercent, 100);
    const contextWindow = Math.max(1, Math.floor(rawContextWindow * pct / 100));
    const explicitCompactLimit = positiveContextWindow(
        seed.autoCompactTokenLimit
            ?? seed.auto_compact_token_limit
            ?? info?.autoCompactTokenLimit
            ?? info?.auto_compact_token_limit,
    );
    const derivedCompactLimit = providerNameOf(provider) === 'openai-oauth'
        ? Math.floor(rawContextWindow * 0.9)
        : null;
    const autoCompactTokenLimit = explicitCompactLimit && derivedCompactLimit
        ? Math.min(explicitCompactLimit, derivedCompactLimit)
        : (explicitCompactLimit || derivedCompactLimit);
    const compactBoundaryTokens = autoCompactTokenLimit
        ? Math.min(autoCompactTokenLimit, contextWindow)
        : contextWindow;
    return {
        contextWindow,
        rawContextWindow,
        effectiveContextWindowPercent,
        autoCompactTokenLimit: autoCompactTokenLimit || null,
        compactBoundaryTokens,
    };
}
// Provider-scoped unified cache key. Goal: all orchestrator-internal
// dispatches (bridge/maintenance/mcp/scheduler/webhook) targeting the
// same provider land in a single server-side cache shard, so the
// shared prefix (tools + system + pool system prompt) is reused
// regardless of role. Per-role / per-session differentiation lives in
// the message tail, which is naturally separated by content hashing.
const PROVIDER_ALIAS = {
    'openai-oauth': 'codex',      // ChatGPT subscription (Codex backend)
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
// Mirrors _checkWorkerPermission in loop.mjs for tool calls that originate
// in the prefetch path (outside the agent loop). Returns an error string if
// blocked, or null if allowed.
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
    // Same baseline as _checkWorkerPermission: when no explicit mode is
    // attached to the session, run the evaluator under 'default' so the
    // bypass-proof hard-deny patterns still apply during prefetch dispatch.
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
    if (session?.owner !== 'bridge') return null;
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
            process.stderr.write(`[bridge-prefetch] files read blocked: ${_pfGuard}\n`);
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
                    process.stderr.write(`[bridge-prefetch] file read failed (${f}): ${e && e.message || e}\n`);
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
        process.stderr.write(
            `[prefetch] files=${files.length} cached=${fileHits.length} miss=${fileMisses.length} failed=${failed.length}\n`
        );
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
                process.stderr.write(`[bridge-prefetch] callers(${symbol}) blocked: ${blocked}\n`);
                return Promise.resolve({ symbol, out: null, blocked: true });
            }
            return executeCodeGraphTool('code_graph', cgArgs, session?.cwd)
                .then(out => ({ symbol, out }))
                .catch(e => {
                    process.stderr.write(`[bridge-prefetch] callers(${symbol}) failed: ${e && e.message || e}\n`);
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
                process.stderr.write(`[bridge-prefetch] references(${symbol}) blocked: ${blocked}\n`);
                return Promise.resolve({ symbol, out: null, blocked: true });
            }
            return executeCodeGraphTool('code_graph', cgArgs, session?.cwd)
                .then(out => ({ symbol, out }))
                .catch(e => {
                    process.stderr.write(`[bridge-prefetch] references(${symbol}) failed: ${e && e.message || e}\n`);
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

// --- bridge spawn (createSession) ---
// opts can pass either a `preset` object (from config.presets) or raw provider/model.
// Preset shape: { name, provider, model, effort?, fast?, tools? }
//
// Smart Bridge integration:
//   opts.taskType / opts.role / opts.profileId — enables profile-aware routing.
//     Rule-based SmartRouter resolves these synchronously; the resolved
//     profile controls context filtering (skip.skills/memory/etc) and cache
//     strategy. If no rule matches, falls back to classic preset behavior.
//   opts.profile — pre-resolved profile (bypasses router; used by async
//     callers who already ran SmartBridge.resolve()).
//   opts.providerCacheOpts — pre-resolved cache options merged into ask() sendOpts.
export function createSession(opts) {
    const presetObj = opts.preset && typeof opts.preset === 'object' ? opts.preset : null;

    // --- Smart Bridge profile resolution (best-effort, sync) ---
    let profile = opts.profile || null;
    let providerCacheOpts = opts.providerCacheOpts || null;
    if (!profile && (opts.taskType || opts.role || opts.profileId)) {
        const smartBridge = getSmartBridgeSync();
        if (smartBridge) {
            try {
                const resolved = smartBridge.resolveSync({
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
                // Smart Bridge error — log once, fall back to classic behavior.
                if (!_smartBridgeWarned) {
                    _smartBridgeWarned = true;
                    process.stderr.write(`[session] smart bridge resolve failed: ${e.message}\n`);
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
    const agentTemplate = opts.agent ? loadAgentTemplate(opts.agent, opts.cwd) : null;
    const skills = opts.skipSkills ? [] : collectSkillsCached(opts.cwd);

    // Bridge shared prefix (bit-identical across roles). Hidden roles reuse the
    // same shared bridge rules so the cache shard stays stable across bridge
    // callers. User-defined data (DATA_DIR roles/schedules/webhooks) is baked
    // into BP1 as a single fixed-value monolithic block so every role shares
    // one cache shard. A user edit invalidates BP1 once and the new prefix
    // re-warms across all roles together.
    const bridgeRulesRole = opts.role || profile?.taskType || null;
    const injectedRules = opts.skipBridgeRules ? '' : (opts.owner === 'bridge' ? _buildBridgeRules() : _buildLeadRules());
    const roleSpecific = opts.owner === 'bridge' && !opts.skipBridgeRules ? _buildRoleSpecific(bridgeRulesRole) : '';
    // Project MD (cwd-based, Tier 3 slot).
    const projectContext = collectProjectMd(opts.cwd);

    // Role template (Phase B §4 — UI-managed). Reads <DATA_DIR>/roles/<role>.md
    // and parses frontmatter (description, permission). The template is
    // injected into the Tier 3 system-reminder so role differences never
    // touch the BP_2 cache prefix.
    const resolvedRole = opts.role || profile?.taskType || null;
    const dataDir = process.env.CLAUDE_PLUGIN_DATA;
    const roleTemplate = resolvedRole && dataDir
        ? loadRoleTemplate(resolvedRole, dataDir)
        : null;

    // Bridge sessions must not inherit role/profile/preset tool narrowing: Pool
    // B and Pool C share one bit-identical tool schema for BP_1/BP_2 cache
    // reuse, and permission differences are enforced only at call time. Raw
    // non-bridge callers keep the historical profile.tools / preset.tools
    // behaviour.
    const toolSpec = opts.owner === 'bridge'
        ? 'full'
        : (Array.isArray(profile?.tools) ? profile.tools : toolPreset);

    // Prompt permission is metadata only. Preset tool restrictions must NOT
    // enter the prompt, or they split the shared bridge cache tail; they map
    // to toolPermission below and are enforced only at call time.
    const permission = opts.permission
        || roleTemplate?.permission
        || null;
    const toolPermission = opts.permission
        || profile?.permission
        || roleTemplate?.permission
        || permissionFromToolSpec(toolPreset)
        || null;
    let toolsForRouting = resolveSessionTools(toolSpec, skills, { ownerIsBridge: opts.owner === 'bridge' });
    // Fail-closed permission intersection: when a role declares an explicit
    // permission (from user-workflow.json or the role template), intersect the
    // resolved tool list with the permission's allow/deny lists. If the
    // intersection produces an empty set the permission config is broken —
    // fail closed (zero tools) rather than silently falling back to the full
    // preset, which would grant the role more surface than declared.
    if (toolPermission && typeof toolPermission === 'object') {
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

    const { baseRules, roleCatalog, sessionMarker, volatileTail } = composeSystemPrompt({
        userPrompt: opts.systemPrompt,
        bridgeRules: injectedRules || undefined,
        roleSpecific: roleSpecific || undefined,
        skipRoleCatalog: opts.owner !== 'bridge',
        agentTemplate: agentTemplate || undefined,
        roleTemplate: roleTemplate || undefined,
        hasSkills: skills.length > 0,
        profile: profile || undefined,
        role: resolvedRole,
        skipRoleReminder: opts.skipRoleReminder || false,
        permission,
        taskBrief: opts.taskBrief || null,
        projectContext: projectContext || null,
        tools: toolsForRouting,
        bashIsPersistent: opts.owner === 'bridge' && toolsForRouting.some(t => t?.name === 'bash'),
        // Effective cwd rides in tier3Reminder so explore-like tools know
        // their search root without needing to shove "Override cwd:" into
        // the user message body (that used to fragment the shard prefix).
        cwd: opts.cwd || null,
        // BP2 catalog policy — explicit-cache providers see the unified
        // all-roles catalog; implicit-prefix-hash providers keep self-only.
        provider: providerName || null,
    });
    // 4-BP layout (see composeSystemPrompt docs):
    //   system block #1 = baseRules    — BP1 (1h) shared across ALL roles
    //   system block #2 = roleCatalog  — BP2 (1h) scoped role catalog + project
    //   first <system-reminder> user   = sessionMarker — BP3 (1h) role-specific task body
    //   second <system-reminder> user  = volatileTail  — rides near BP4 (5m)
    // Anthropic multi-block system pins each block with cache_control.
    // OpenAI gets a stable provider cache key/session prefix. Gemini relies
    // on implicit prompt caching only, so hits are observed, not treated as a
    // guaranteed warm shard.
    if (baseRules) {
        messages.push({ role: 'system', content: baseRules });
    }
    if (roleCatalog) {
        messages.push({ role: 'system', content: roleCatalog });
    }
    if (sessionMarker) {
        messages.push({ role: 'user', content: `<system-reminder>\n${sessionMarker}\n</system-reminder>` });
        messages.push({ role: 'assistant', content: '.' });
    }
    if (volatileTail) {
        messages.push({ role: 'user', content: `<system-reminder>\n${volatileTail}\n</system-reminder>` });
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
    //   - annotations.bridgeHidden : declarative per-tool flag (tools.json
    //     and internal tool defs). Pool A (Lead) still sees all tools.
    //
    const hasCallerAllow = Array.isArray(opts.schemaAllowedTools);
    const callerAllow = hasCallerAllow ? opts.schemaAllowedTools.map(n => String(n).toLowerCase()) : [];
    if (hasCallerAllow) {
        const allowSet = new Set(callerAllow);
        const before = tools.length;
        tools = tools.filter(t => allowSet.has(String(t?.name || '').toLowerCase()));
        if (tools.length !== before && !process.env.MIXDOG_QUIET_SESSION_LOG) {
            process.stderr.write(`[session] schemaAllowedTools=${callerAllow.join(',')} kept ${tools.length}/${before} tools\n`);
        }
    }
    const callerDeny = Array.isArray(opts.disallowedTools) ? opts.disallowedTools.map(n => String(n)) : [];
    if (callerDeny.length) {
        const denySet = new Set(callerDeny);
        const before = tools.length;
        tools = tools.filter(t => !denySet.has(String(t?.name || '').toLowerCase()));
        if (tools.length !== before && !process.env.MIXDOG_QUIET_SESSION_LOG) {
            process.stderr.write(`[session] disallowedTools=${callerDeny.join(',')} stripped ${before - tools.length} tools\n`);
        }
    }
    if (opts.owner === 'bridge') {
        const before = tools.length;
        tools = tools.filter(t => !t?.annotations?.bridgeHidden);
        if (tools.length !== before && !process.env.MIXDOG_QUIET_SESSION_LOG) {
            process.stderr.write(`[session] bridgeHidden stripped ${before - tools.length} tools\n`);
        }
    }

    // Bridge tool canonicalization: keep route-sensitive tools in policy order
    // while preserving deterministic MCP/skill order for BP1 shard stability.
    if (opts.owner === 'bridge') {
        tools = orderSessionTools(tools);
    }

    // Unified-shard policy — no broad role-specific schema filter. Keep
    // bridge schemas shared unless a hidden-role schema profile explicitly
    // passes schemaAllowedTools for a small specialist; broad role
    // whitelists would fragment the cache shard.
    if (resolvedRole && !process.env.MIXDOG_QUIET_SESSION_LOG) {
        process.stderr.write(`[session] role=${resolvedRole} permission=${permission || 'full'} toolPermission=${toolPermission || 'full'} tools=${tools.length}\n`);
    }
    const contextMeta = resolveSessionContextMeta(provider, modelName);
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
            model: opts.compaction?.model || null,
            timeoutMs: positiveContextWindow(opts.compaction?.timeoutMs),
            tailTurns: positiveContextWindow(opts.compaction?.tailTurns),
            bufferTokens: positiveContextWindow(opts.compaction?.bufferTokens ?? opts.compaction?.buffer),
            keepTokens: positiveContextWindow(opts.compaction?.keepTokens ?? opts.compaction?.keep?.tokens),
            preserveRecentTokens: positiveContextWindow(opts.compaction?.preserveRecentTokens),
            reservedTokens: positiveContextWindow(opts.compaction?.reservedTokens),
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
        lane: opts.lane || 'bridge',
        cwd: opts.cwd,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastHeartbeatAt: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        // Refreshed on each completed ask() — surfaced by bridge type=list for
        // debugging + consumed by store.mjs's idle-sweep to reclaim stalled
        // bridge sessions past RUNNING_STALL_MS.
        lastUsedAt: Date.now(),
        tokensCumulative: 0,
        role: opts.role || null,
        taskType: opts.taskType || null,
        maxLoopIterations: Number.isFinite(opts.maxLoopIterations) ? opts.maxLoopIterations : null,
        // Bridge tag (auto worker{n} on spawn) persisted so the forked status
        // process (statusline) + aggregator can read it from the session JSON.
        // In-process send/close still resolve via _tagSessionRegistry.
        bridgeTag: opts.bridgeTag || null,
        // Prompt permission is separate from runtime toolPermission so preset
        // restrictions do not fragment the bridge cache prefix.
        permission: permission || null,
        toolPermission: toolPermission || null,
        // Origin tag written into every bridge-trace usage row so analytics
        // can slice by (sourceType, sourceName) — e.g. maintenance/cycle1,
        // scheduler/daily-standup, webhook/github-push, lead/worker.
        sourceType: opts.sourceType || null,
        sourceName: opts.sourceName || null,
        // Provider-scoped unified cache key — one shard per provider,
        // shared across all roles / sources (bridge/maintenance/mcp/
        // scheduler/webhook). Role or source-specific context must be
        // injected into the message tail, not the shared prefix.
        promptCacheKey: providerCacheKey(presetObj?.provider || opts.provider, opts.cacheKeyOverride),
        // Bridge shell continuity: when a bridge session explicitly opts into
        // persistent shell state (`bash` with `persistent:true`, or direct
        // `bash_session`), the minted bash_session id is stored here so later
        // opted-in `bash` calls can reuse the same shell state.
        implicitBashSessionId: null,
        // Tracks every persistent bash session id minted during this
        // orchestrator session so closeSession can kill them all, not just
        // the most recently recorded one.
        allBashSessionIds: [],
        // Smart Bridge metadata — optional. Applied on every ask() to merge
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
// In-memory only. Tracks per-session stage + stream heartbeat so bridge type=list
// can surface whether a session is actually alive vs stuck. Never persisted —
// heartbeats would otherwise churn the session JSON on every SSE delta.
// Entry shape: {
//   stage, lastStreamDeltaAt, lastToolCall, lastError, updatedAt,
//   controller?: AbortController,  // set while an ask is in flight
//   generation?: number,            // snapshot taken at ask start
//   closed?: boolean,               // flipped by closeSession()
// }
const _runtimeState = new Map();
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
export function updateSessionStage(id, stage) {
    if (!id || !VALID_STAGES.has(stage)) return;
    const entry = _touchRuntime(id);
    const now = Date.now();
    entry.stage = stage;
    entry.lastProgressAt = now;
    entry.updatedAt = now;
}
/**
 * Reset heartbeat-visible fields for a new ask. Preserves controller/generation/
 * closed (lifecycle) but clears the previous run's streaming state so stale
 * lastToolCall / lastStreamDeltaAt from the previous ask don't leak into the
 * new one.
 */
export function markSessionAskStart(id) {
    if (!id) return;
    const entry = _touchRuntime(id);
    entry.stage = 'connecting';
    entry.lastStreamDeltaAt = null;
    entry.lastToolCall = null;
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
    entry.lastProgressAt = now;
    entry.updatedAt = now;
    // Publish heartbeat immediately so the status aggregator picks the
    // session up in the connecting / requesting window. Without this the
    // .hb file only landed on the first stream chunk — producing a 3–10s
    // (xhigh: 30s+) invisible gap where bridge sessions ran but the CC
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
    // Reuse the live in-memory session handle (registered into the runtime
    // entry by askSession before streaming begins, L1495). Falling back to a
    // synchronous loadSession() — a full readFileSync + JSON.parse of the
    // session JSON — on EVERY stream delta blocked the event loop and grew
    // with conversation length. The runtime handle is the same object
    // persistIterationMetrics mutates (L1242), so the heartbeat-throttle read
    // below stays consistent. Disk fallback only when no live handle exists.
    const session = entry.session ?? loadSession(id);
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
}
export function markSessionDone(id, { empty = false } = {}) {
    if (!id) return;
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
}
export function getSessionRuntime(id) {
    return id ? (_runtimeState.get(id) || null) : null;
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
// Per-session idempotency tracking: sessionId → Set of seen iterationIndex keys.
const _metricSeenIter = new Map();

/**
 * Persist incremental usage delta immediately after each provider.send iteration.
 * Idempotency key `sessionId:iterationIndex` ensures a retry of the same iteration
 * index overwrites instead of double-counting.
 */
export async function persistIterationMetrics(delta) {
    if (!delta || !delta.sessionId) return;
    const { sessionId, iterationIndex, deltaInput, deltaOutput, deltaCachedRead, deltaCacheWrite, ts } = delta;
    let seen = _metricSeenIter.get(sessionId);
    if (!seen) {
        seen = new Set();
        _metricSeenIter.set(sessionId, seen);
    }
    const ikey = `${sessionId}:${iterationIndex}`;
    const isReplay = seen.has(ikey);
    seen.add(ikey);
    const runtimeEntry = _runtimeState.get(sessionId);
    const session = runtimeEntry?.session ?? loadSession(sessionId);
    if (!session || session.closed) return;
    if (!isReplay) {
        session.totalInputTokens = (session.totalInputTokens || 0) + (deltaInput || 0);
        session.totalOutputTokens = (session.totalOutputTokens || 0) + (deltaOutput || 0);
        session.tokensCumulative = (session.tokensCumulative || 0) + (deltaInput || 0) + (deltaOutput || 0);
        // Cache totals — additive fields, default 0 on legacy sessions; both
        // are undefined-safe so the schema migrates lazily as new iterations
        // land. Keeps live + terminal aggregates in lock-step (loop.mjs already
        // includes cached_read / cache_write in its terminal usage rollup).
        session.totalCachedReadTokens = (session.totalCachedReadTokens || 0) + (deltaCachedRead || 0);
        session.totalCacheWriteTokens = (session.totalCacheWriteTokens || 0) + (deltaCacheWrite || 0);
        // Window snapshot updated per iteration so bridge type=list reflects the
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
    }
    session.lastIterationIndex = iterationIndex;
    session.updatedAt = ts || Date.now();
    await saveSessionAsync(session, { expectedGeneration: session.generation });
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
        entry.lastStreamDeltaAt || 0,
        entry.toolStartedAt || 0,
        entry.askStartedAt || 0,
    );
}

/**
 * Link a parent AbortSignal to a sub-session's controller so that aborting
 * the parent (fan-out deadline or caller ESC) tears down the bridge role's
 * provider call promptly. Safe to call after prepareBridgeSession but before
 * askSession completes. No-op if the session runtime isn't found.
 *
 * @param {string} sessionId — the sub-session to abort
 * @param {AbortSignal} parentSignal — upstream signal (from fan-out coordinator)
 */
export function linkParentSignalToSession(sessionId, parentSignal) {
    if (!(parentSignal instanceof AbortSignal)) return;
    const entry = _touchRuntime(sessionId);
    if (!entry.controller) entry.controller = createAbortController();
    if (parentSignal.aborted) {
        try { entry.controller.abort(new Error('parent signal aborted')); } catch { /* ignore */ }
        return;
    }
    parentSignal.addEventListener('abort', () => {
        try { entry.controller?.abort(new Error('parent signal aborted')); } catch { /* ignore */ }
    }, { once: true });
}
function _clearSessionRuntime(id) {
    if (id) {
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
    if (signal.aborted) throw new SessionClosedError(sessionId, 'aborted before call');
    const underlying = fn(signal);
    underlying.catch(() => {}); // prevent unhandled rejection if we race ahead
    let onAbort = null;
    const aborted = new Promise((_, reject) => {
        onAbort = () => reject(new SessionClosedError(sessionId, 'aborted during call'));
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
// Per-session pending-message queue (Claude Code `pendingMessages` pattern).
// A `bridge type=send` to a worker whose turn is still in flight ENQUEUES the
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
// Map<sessionId, string[]>. Shared with index.mjs's bridge send handler via
// the enqueue/drain accessors below — one queue contract, two call sites.
const _sessionPendingMessages = new Map();
const PENDING_MESSAGES_FILE = 'session-pending-messages.json';
const PENDING_MESSAGES_MODE = 0o600;

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

function persistPendingMessage(sessionId, message) {
    if (!isValidPendingSessionId(sessionId)) return 0;
    let depth = 0;
    try {
        updateJsonAtomicSync(pendingMessagesPath(), (raw) => {
            const next = normalizePendingStore(raw);
            const q = Array.isArray(next.sessions[sessionId]) ? next.sessions[sessionId] : [];
            q.push(message);
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
    if (!sessionId || typeof message !== 'string' || !message) return 0;
    let q = _sessionPendingMessages.get(sessionId);
    if (!q) { q = []; _sessionPendingMessages.set(sessionId, q); }
    q.push(message);
    const persistedDepth = persistPendingMessage(sessionId, message);
    return Math.max(q.length, persistedDepth || 0);
}
export function drainPendingMessages(sessionId) {
    const q = _sessionPendingMessages.get(sessionId);
    const memory = q && q.length > 0 ? q.slice() : [];
    _sessionPendingMessages.delete(sessionId);
    const persisted = drainPersistedPendingMessages(sessionId);
    if (memory.length === 0) return persisted;
    if (persisted.length === 0) return memory;
    const prefixMatches = memory.every((m, i) => persisted[i] === m);
    if (prefixMatches) return [...memory, ...persisted.slice(memory.length)];
    const out = persisted.slice();
    for (const m of memory) {
        if (!out.includes(m)) out.push(m);
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

export async function askSession(sessionId, prompt, context, onToolCall, cwdOverride, explicitPrefetch, askOpts = {}) {
    const _askStartedAt = Date.now();
    const _promptSrc = 'prompt';
    const _prefetchFiles = (explicitPrefetch?.files?.length) || 0;
    const _prefetchCallers = (explicitPrefetch?.callers?.length) || 0;
    const _prefetchRefs = (explicitPrefetch?.references?.length) || 0;
    if (process.env.MIXDOG_DEBUG_BRIDGE) {
        process.stderr.write(`[bridge-trace] t0-ask-start sessionHash=${createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 8)} role=? iteration=0 promptSrc=${_promptSrc} prefetchFiles=${_prefetchFiles} callers=${_prefetchCallers} references=${_prefetchRefs}\n`);
    }
    const unlock = await acquireSessionLock(sessionId);
    const _lockWaitedMs = Date.now() - _askStartedAt;
    if (process.env.MIXDOG_DEBUG_BRIDGE) {
        process.stderr.write(`[bridge-trace] lock-acquired waitedMs=${_lockWaitedMs}\n`);
    }
    // The mutex is held for the WHOLE askSession call, including any follow-up
    // turns drained from the pending-message queue below — the single outer
    // try/finally releases it exactly once. _result holds the last turn's
    // return value (the queued tail turns supersede the original prompt's
    // result, mirroring how a live chat returns the latest turn).
    let _result;
    // Local FIFO of follow-up prompts drained from the pending-message queue
    // after each turn — keeps queued `bridge type=send` messages in order.
    const _pendingTail = [];
    // Hoisted so the outer finally (which runs once after the whole turn loop)
    // can compare against the last turn's generation.
    let askGeneration = 0;
    try {
      // Turn loop (pendingMessages pattern): run the current prompt, then drain
      // any `bridge type=send` messages that were queued while this turn was in
      // flight and run them — in order — as the next user turn(s). Because the
      // queued send always lands AFTER the in-flight prompt here, ordering is
      // preserved and the spawn/connecting startup race disappears.
      for (;;) {
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
        markSessionAskStart(sessionId);
        // Preprocessing is inside try so provider-not-available / trim failures
        // fall into the catch and mark the session as errored rather than
        // leaving stage='connecting' forever.
        try {
            const session = preSession;
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
            const beforeCount = session.messages.length + 1;
            // Soft warning only; real size management (compaction primary,
            // byte-budget trim as safety net) lives in agentLoop. Selecting a
            // 25% pre-trim here would starve compaction's 50% threshold.
            const softBudget = Math.floor(session.contextWindow * 0.25);
            const promptTokenEstimate = prompt.length * 0.5; // conservative for CJK
            if (promptTokenEstimate > softBudget * 0.7) {
                process.stderr.write(`[session] Warning: prompt is very large (est. ${Math.round(promptTokenEstimate)} tokens vs ${softBudget} soft budget)\n`);
            }
            const effectiveCwd = cwdOverride || session.cwd;
            const _userTurnContent = _contextBlock
                ? `${_contextBlock}# Task\n${prompt}`
                : prompt;
            const outgoing = [...session.messages, { role: 'user', content: _userTurnContent }];
            // Per-turn injected-context trace row (complements kind:"usage").
            // Cheap byte-length accounting — no hashing, no payload bodies.
            // Honors the same MIXDOG_BRIDGE_TRACE_DISABLE gate as usage rows;
            // appendBridgeTrace is a no-op when that env is set.
            try {
                const _ctxBytes = Buffer.byteLength(context || '', 'utf8');
                const _prefetchBytes = Buffer.byteLength(explicitPrefetchResult || '', 'utf8');
                const _promptBytes = Buffer.byteLength(prompt || '', 'utf8');
                const _userTurnBytes = Buffer.byteLength(_userTurnContent, 'utf8');
                const _messagesBytes = Buffer.byteLength(JSON.stringify(session.messages || []), 'utf8');
                const _totalBytes = _userTurnBytes + _messagesBytes;
                appendBridgeTrace({
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
                        messagesCount: Array.isArray(session.messages) ? session.messages.length : 0,
                    },
                });
            } catch { /* trace must never break the ask path */ }
            const result = await _api_call_with_interrupt(sessionId, (signal) =>
                agentLoop(provider, outgoing, session.model, session.tools, onToolCall, effectiveCwd, {
                    effort: session.effort || null,
                    fast: session.fast === true,
                    sessionId,
                    onTextDelta: typeof askOpts?.onTextDelta === 'function' ? askOpts.onTextDelta : undefined,
                    onReasoningDelta: typeof askOpts?.onReasoningDelta === 'function' ? askOpts.onReasoningDelta : undefined,
                    onUsageDelta: (d) => {
                        persistIterationMetrics(d).catch(() => {});
                        try { askOpts?.onUsageDelta?.(d); } catch {}
                    },
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
                    // Smart Bridge cache settings — merged last so session overrides
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
            session.messages = outgoing;
            if (result.content || result.reasoningContent) {
                session.messages.push({
                    role: 'assistant',
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
            if (result.usage) {
                session.totalInputTokens += result.usage.inputTokens;
                session.totalOutputTokens += result.usage.outputTokens;
                session.tokensCumulative = (session.tokensCumulative || 0)
                    + (result.usage.inputTokens || 0)
                    + (result.usage.outputTokens || 0);
                // Cache totals — same `||0` undefined-safe accumulation pattern as
                // persistIterationMetrics so live + terminal paths stay in lock-step
                // and legacy sessions migrate lazily on first iteration.
                session.totalCachedReadTokens = (session.totalCachedReadTokens || 0) + (result.usage.cachedTokens || 0);
                session.totalCacheWriteTokens = (session.totalCacheWriteTokens || 0) + (result.usage.cacheWriteTokens || 0);
                // Window snapshot = the current context size, which is the LAST
                // single call — NOT result.usage (that is lastUsage, the per-turn
                // SUM accumulated with += across iterations in agentLoop). Use
                // lastTurnUsage (the final iteration's raw usage) so this reflects
                // "what's in the window now" rather than the lifetime sum.
                const _lastTurn = result.lastTurnUsage || result.usage || {};
                session.lastInputTokens = _lastTurn.inputTokens || 0;
                session.lastOutputTokens = _lastTurn.outputTokens || 0;
                session.lastCachedReadTokens = _lastTurn.cachedTokens || 0;
                session.lastCacheWriteTokens = _lastTurn.cacheWriteTokens || 0;
                // Provider-normalized footprint, identical formula to
                // persistIterationMetrics so both writers agree: Anthropic
                // input_tokens excludes cache (add it back), openai/grok/gemini
                // already include it.
                const _inputExcludesCache = providerInputExcludesCache(session.provider);
                session.lastContextTokens = _inputExcludesCache
                    ? (_lastTurn.inputTokens || 0) + (_lastTurn.cachedTokens || 0)
                    : (_lastTurn.inputTokens || 0);
            }
            // Smart Bridge cache stats — record hit/miss after every successful
            // ask so the registry reflects all bridge traffic, not just
            // maintenance cycles. Guarded against any smart-bridge error so
            // metric recording never breaks the ask itself.
            let prefixHashForLog = null;
            if (session.profileId && result.usage && _smartBridgeApi) {
                try {
                    const profile = _smartBridgeApi.getProfile(session.profileId);
                    if (profile) {
                        // Collect every leading system-role message (BP1, BP2, ...)
                        // until the first non-system message so the registry hash
                        // captures the full ordered provider prefix, not just BP1.
                        const systemMsgs = [];
                        for (const m of session.messages) {
                            if (m?.role !== 'system') break;
                            systemMsgs.push(typeof m.content === 'string' ? m.content : '');
                        }
                        _smartBridgeApi.recordCall(profile, session.provider, {
                            systemPrompt: systemMsgs,
                            tools: session.tools || [],
                            usage: result.usage,
                        });
                        const entry = _smartBridgeApi.registry?.data?.profiles?.[session.profileId]?.[session.provider];
                        prefixHashForLog = entry?.prefixHash || null;
                    }
                } catch {}
            }
            // Append to bridge-trace.jsonl with the rich bridge usage fields.
            if (result.usage) {
                const inputTokens = result.usage.inputTokens || 0;
                const outputTokens = result.usage.outputTokens || 0;
                const cacheReadTokens = result.usage.cachedTokens || 0;
                const cacheWriteTokens = result.usage.cacheWriteTokens || 0;
                // Unified total-prompt field. Anthropic = input+cache_read+cache_write
                // (additive); OpenAI/Codex/Gemini = input_tokens already includes the
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
            }
            // Persist opaque providerState for future stateful providers.
            // No provider currently emits it (Codex OAuth is stateless per
            // contract), so this branch is dormant — kept so a future
            // Responses-API provider with stable continuation can plug in
            // without reworking the session shape.
            if (result.providerState !== undefined) {
                session.providerState = result.providerState;
            }
            await saveSessionAsync(session, { expectedGeneration: askGeneration });
            // Tag empty-synthesis BEFORE markSessionDone so the watchdog
            // (which inspects entry.emptyFinal first) classifies the
            // terminal state correctly even if it ticks during unwind.
            const isEmptyFinal = !result.content && !result.reasoningContent;
            if (isEmptyFinal) {
                markSessionEmptyFinal(sessionId);
            }
            markSessionDone(sessionId, { empty: isEmptyFinal });
            _result = {
                ...result,
                trimmed: messagesDropped > 0,
                messagesDropped,
            };
        } catch (err) {
            if (err instanceof SessionClosedError) {
                // Cancellation is not an error; propagate silently so callers
                // can render it as "cancelled" rather than a red failure.
                throw err;
            }
            markSessionError(sessionId, err && err.message ? err.message : String(err));
            throw err;
        }
        // ── Turn complete. Drain the pending-message queue (Claude Code
        //    pendingMessages): any `bridge type=send` that arrived while this
        //    turn was in flight runs next, in order, as a follow-up user turn.
        //    The mutex is still held, so a send racing this drain either landed
        //    before (picked up here) or enqueues for the next loop. When the
        //    queue is empty we return the latest turn's result. ──
        const _drained = drainPendingMessages(sessionId);
        if (_drained.length > 0) {
            _pendingTail.push(..._drained);
            continue;
        }
        return _result;
      }
    } finally {
        // Clear the controller only if it's still ours (closeSession may have
        // swapped it). Leave the rest of the runtime entry intact so bridge type=list
        // can still surface the final stage (done/error/cancelling).
        const entry = _runtimeState.get(sessionId);
        if (entry && entry.generation === askGeneration) {
            entry.controller = null;
            // Detach the live session reference; ask is over.
            entry.session = null;
        }
        unlock();
    }
}
// Session lookup by scopeKey — used by CLI bridge to resume a pinned
// scope session when the caller passes --scope (agent/<name>).
export function findSessionByScopeKey(scopeKey) {
    if (!scopeKey) return null;
    const sessions = listStoredSessions();
    // Exclude tombstoned sessions (`closed === true`) so callers never receive
    // a session whose controller was aborted by closeSession(). The `closed`
    // bit is the authoritative tombstone flag; `status === 'error'` is not,
    // since transient-error sessions remain resumable.
    return sessions.find(s => s.scopeKey === scopeKey && s.closed !== true) || null;
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
    const skills = collectSkillsCached(session.cwd);
    let toolSpec = preset || session.preset || 'full';
    if (session.profileId && _smartBridgeApi?.getProfile) {
        try {
            const profile = _smartBridgeApi.getProfile(session.profileId);
            if (Array.isArray(profile?.tools)) toolSpec = profile.tools;
        } catch { /* ignore lookup failures, keep preset fallback */ }
    }
    session.tools = resolveSessionTools(toolSpec, skills, { ownerIsBridge: session.owner === 'bridge' });
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
    const sessions = listStoredSessions();
    const hiddenIds = new Set([..._runtimeState.entries()].filter(([, e]) => e.listHidden).map(([id]) => id));
    // Tombstoned sessions (closed===true) are excluded unless the caller opts in
    // (e.g. bridge list includeClosed:true).
    return sessions.filter(s => !hiddenIds.has(s.id) && (includeClosed || s.closed !== true));
}
// --- Clear messages (keep system prompt + provider/model/cwd) ---
export async function clearSessionMessages(sessionId) {
    const session = loadSession(sessionId);
    if (!session)
        return false;
    // Don't resurrect a closed session just to clear its messages.
    if (session.closed === true) return false;
    session.messages = (session.messages || []).filter(m => m && m.role === 'system');
    session.totalInputTokens = 0;
    session.totalOutputTokens = 0;
    session.updatedAt = Date.now();
    await saveSessionAsync(session, { expectedGeneration: session.generation });
    return true;
}
export async function compactSessionMessages(sessionId) {
    const session = loadSession(sessionId);
    if (!session) return null;
    if (session.closed === true) return null;
    const beforeMessages = Array.isArray(session.messages) ? session.messages : [];
    const beforeTokens = estimateMessagesTokens(beforeMessages);
    const nonSystem = beforeMessages.filter(m => m?.role !== 'system');
    let currentTurnStart = -1;
    for (let i = nonSystem.length - 1; i >= 0; i -= 1) {
        if (nonSystem[i]?.role === 'user') {
            currentTurnStart = i;
            break;
        }
    }
    const boundary = positiveContextWindow(session.compactBoundaryTokens)
        || positiveContextWindow(session.autoCompactTokenLimit)
        || positiveContextWindow(session.contextWindow);
    if (!boundary) {
        throw new Error('compact: no context window is available for this session');
    }
    const reserveTokens = estimateRequestReserveTokens(session.tools || []);
    if (currentTurnStart <= 0) {
        return {
            changed: false,
            reason: 'nothing to compact',
            beforeMessages: beforeMessages.length,
            afterMessages: beforeMessages.length,
            beforeTokens,
            afterTokens: beforeTokens,
            budgetTokens: boundary,
            reserveTokens,
        };
    }
    let beforeEncoded = '';
    try { beforeEncoded = JSON.stringify(beforeMessages); } catch { beforeEncoded = ''; }
    let compacted;
    try {
        compacted = compactMessages(beforeMessages, boundary, { reserveTokens, force: true });
    } catch (err) {
        try {
            process.stderr.write(`[session] manual compact fallback (sess=${sessionId}): ${err?.message || err}\n`);
        } catch { /* best-effort */ }
        compacted = compactActiveTurn(beforeMessages, boundary, { reserveTokens });
    }
    const afterTokens = estimateMessagesTokens(compacted);
    let afterEncoded = '';
    try { afterEncoded = JSON.stringify(compacted); } catch { afterEncoded = ''; }
    const changed = beforeEncoded && afterEncoded
        ? beforeEncoded !== afterEncoded
        : (compacted.length !== beforeMessages.length || afterTokens !== beforeTokens);
    session.messages = compacted;
    session.updatedAt = Date.now();
    await saveSessionAsync(session, { expectedGeneration: session.generation });
    return {
        changed,
        beforeMessages: beforeMessages.length,
        afterMessages: compacted.length,
        beforeTokens,
        afterTokens,
        budgetTokens: boundary,
        reserveTokens,
    };
}
export async function updateSessionStatus(id, status) {
    const session = loadSession(id);
    if (!session) return false;
    // Respect tombstones — don't resurrect a closed session just to update a
    // status label (bridge handler emits running→idle/error around askSession).
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
        if (!process.env.MIXDOG_QUIET_SESSION_LOG) process.stderr.write(`[bridge-close] ${parts.join(' ')}\n`);
    } catch { /* best-effort */ }
    for (const bsid of allBashIds) {
        try { closeBashSession(bsid, `bridge-close:${id}`); } catch { /* ignore */ }
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

// --- Periodic idle session cleanup ---
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes
const TOMBSTONE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — far longer than any realistic ask race window
let _cleanupTimer = null;

function sweepIdleSessions() {
    try {
        const { cleaned, remaining, details } = sweepStaleSessions();
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
                        try { closeBashSession(d.bashSessionId, `idle-sweep:${d.id}`); } catch { /* ignore */ }
                    }
                }
                process.stderr.write(`[bridge-session] idle cleanup: closed ${d.id} (idle ${d.idleMinutes}m, owner=${d.owner})\n`);
            }
            process.stderr.write(`[bridge-session] idle sweep: cleaned ${cleaned} session(s), ${remaining} remaining\n`);
        }
    } catch (e) {
        process.stderr.write(`[bridge-session] idle sweep error: ${e && e.message || e}\n`);
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
        const now = Date.now();
        const sessions = getStoredSessionsRaw();
        let cleaned = 0;
        for (const s of sessions) {
            if (!s.closed) continue;
            const updated = Number(s.updatedAt);
            if (!Number.isFinite(updated)) continue;
            const age = now - updated;
            if (age < TOMBSTONE_MAX_AGE_MS) continue;
            try {
                deleteSession(s.id);
                _clearSessionRuntime(s.id);
                cleaned++;
                process.stderr.write(`[session-sweep] unlinked tombstone ${s.id} (age=${Math.floor(age / 1000)}s)\n`);
            } catch (e) {
                process.stderr.write(`[session-sweep] unlink failed ${s.id}: ${e && e.message || e}\n`);
            }
        }
        return cleaned;
    } catch (e) {
        process.stderr.write(`[session-sweep] tombstone sweep error: ${e && e.message || e}\n`);
        return 0;
    }
}

function _runCleanupCycle() {
    sweepIdleSessions();
    sweepTombstones();
}

export function startIdleCleanup() {
    if (_cleanupTimer) return;
    _runCleanupCycle();
    _cleanupTimer = setInterval(_runCleanupCycle, CLEANUP_INTERVAL_MS);
    if (_cleanupTimer.unref) _cleanupTimer.unref(); // don't block process exit
}

export function stopIdleCleanup() {
    if (_cleanupTimer) {
        clearInterval(_cleanupTimer);
        _cleanupTimer = null;
    }
}
