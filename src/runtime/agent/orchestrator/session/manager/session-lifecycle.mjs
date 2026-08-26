// manager/session-lifecycle.mjs
// Session build/route/resume lifecycle extracted verbatim from manager.mjs.
// createSession (spawn), updateSessionRoute (provider/model reroute), and
// resumeSession (reload tools for a stored session) all share the same tool
// resolution + context-meta + agent-runtime resolution helpers.
import { getProvider } from '../../providers/registry.mjs';
import { normalizeCompactType, DEFAULT_COMPACT_TYPE } from '../compact.mjs';
import { collectPromptSkillsCached, buildSkillManifest, composeSystemPrompt } from '../../context/collect.mjs';
import { saveSession, saveSessionAsync, saveSessionAsyncDeferred, loadSession, setLiveSession, readSessionHeartbeatMtime, readSessionPresenceMtime, isSessionPresenceOwnerDead, deleteSessionPresence, isSessionHeartbeatOwnerDead, readSessionHeartbeatOwnerPid, deleteHeartbeat, isProcessAlive } from '../store.mjs';
import { _getRuntimeEntry } from './runtime-liveness.mjs';
import { isAgentOwner } from '../../agent-owner.mjs';
import { getHiddenAgent } from '../../internal-agents.mjs';
import { loadConfig } from '../../config.mjs';
import { buildProviderCacheOpts, cacheCapabilityForProvider } from '../../agent-runtime/cache-strategy.mjs';
import { normalizeAutoClearConfig, resolveAutoClearIdleMs } from '../../../../../session-runtime/config-helpers.mjs';
import { toSessionWorkflowMeta, workflowDisallowsAgentTool } from '../../../../../session-runtime/workflow.mjs';
import {
    _buildSharedRules,
    _buildAgentRules,
    _buildLeadRules,
    _buildLeadMetaContext,
} from './rules-cache.mjs';
import {
    applyToolPermissionNarrowing,
    finalizeSessionToolList,
    resolveSessionTools,
    permissionFromToolSpec,
} from './tool-resolution.mjs';
import {
    filterModelEditToolNames,
    filterModelEditTools,
    unusedModelEditToolName,
} from '../../../../shared/edit-tool-dialect.mjs';
import {
    positiveContextWindow,
    preserveBufferConfigFields,
    resolveSessionContextMeta,
} from './context-meta.mjs';
import { getAgentRuntimeSync, warnAgentRuntimeResolveFailureOnce } from './agent-runtime-singleton.mjs';
import { ensureCodexWireSessionId, mintSessionId, mintUuidV7 } from './session-id.mjs';
import { providerCacheKey } from './provider-cache-key.mjs';
import { clearTurnCheckpoint, recoverTurnCheckpoint } from './turn-checkpoint.mjs';
import { IMPLICIT_APPROVAL_MODE } from '../approval-mode.mjs';
import { describeGitStartupState } from '../../tools/builtin/runtime-capabilities.mjs';
import { captureOriginalUserCwd } from '../../../../shared/user-cwd.mjs';
import { refreshSessionBp3Environment } from './prompt-utils.mjs';

function buildSessionProviderCacheOpts(providerName, sessionId, agent = null) {
    // Keep this in sync with createSession's provider-cache policy: only
    // explicit-breakpoint providers get BP cache opts here; OpenAI/key-prefix
    // providers use promptCacheKey and request-time strategy instead.
    if (cacheCapabilityForProvider(providerName) !== 'explicit-breakpoint') return null;
    try {
        let autoClear = null;
        if (!agent || agent === 'lead') {
            const loadedConfig = loadConfig({ secrets: false });
            const normalizedAutoClear = normalizeAutoClearConfig(loadedConfig?.autoClear);
            autoClear = {
                ...normalizedAutoClear,
                idleMs: resolveAutoClearIdleMs(loadedConfig, providerName),
            };
        }
        return buildProviderCacheOpts(providerName, sessionId, agent, { autoClear });
    } catch {
        return null;
    }
}

export function normalizeDesktopSessionMetadata(value, cwd = null) {
    if (!value || typeof value !== 'object') return null;
    if (value.classification === 'task') {
        return { classification: 'task', projectPath: null };
    }
    if (value.classification === 'project') {
        const cleanPath = (path) => {
            if (typeof path !== 'string') return null;
            const trimmed = path.trim();
            return trimmed && !trimmed.includes('\0') ? trimmed : null;
        };
        // Older bridge rows may omit projectPath and rely on the session cwd.
        // Do not, however, stringify arbitrary persisted values into paths.
        const projectPath = cleanPath(value.projectPath) || cleanPath(cwd);
        if (!projectPath) return null;
        return {
            classification: 'project',
            projectPath,
        };
    }
    return null;
}

// --- agent spawn (createSession) ---
// opts can pass either a `preset` object (from config.presets) or raw provider/model.
// Preset shape: { name, provider, model, effort?, fast?, tools? }
//
// Agent Runtime integration:
//   opts.taskType / opts.agent / opts.profileId — enables profile-aware routing.
//     Rule-based SmartRouter resolves these synchronously; the resolved
//     profile controls context filtering (skip.skills/memory/etc) and cache
//     strategy. If no rule matches, falls back to classic preset behavior.
//   opts.profile — pre-resolved profile (bypasses router; used by async
//     callers who already ran AgentRuntime.resolve()).
//   opts.providerCacheOpts — pre-resolved cache options merged into ask() sendOpts.
export function initialCompactionConfig(compaction = {}, contextMeta = {}) {
    return {
        auto: compaction?.auto !== false,
        prune: compaction?.prune === true,
        semantic: compaction?.semantic ?? 'auto',
        type: normalizeCompactType(compaction?.type ?? compaction?.compactType ?? compaction?.compact_type, DEFAULT_COMPACT_TYPE),
        compactType: normalizeCompactType(compaction?.type ?? compaction?.compactType ?? compaction?.compact_type, DEFAULT_COMPACT_TYPE),
        model: compaction?.model || null,
        timeoutMs: positiveContextWindow(compaction?.timeoutMs),
        tailTurns: positiveContextWindow(compaction?.tailTurns),
        bufferTokens: positiveContextWindow(compaction?.bufferTokens ?? compaction?.buffer),
        mainBufferTokens: positiveContextWindow(compaction?.mainBufferTokens ?? compaction?.mainBuffer),
        // Preserve percent/ratio-named config so the shared policy can honor
        // both agent semantic and main/user recall-fasttrack buffer settings.
        ...preserveBufferConfigFields(compaction),
        keepTokens: positiveContextWindow(compaction?.keepTokens ?? compaction?.keep?.tokens),
        preserveRecentTokens: positiveContextWindow(compaction?.preserveRecentTokens),
        reservedTokens: positiveContextWindow(compaction?.reservedTokens),
        recallIngestLimit: positiveContextWindow(compaction?.recallIngestLimit),
        recallChunkLimit: positiveContextWindow(compaction?.recallChunkLimit ?? compaction?.recallLimit),
        recallCycle1BatchSize: positiveContextWindow(compaction?.recallCycle1BatchSize),
        recallRowsPerSession: positiveContextWindow(compaction?.recallRowsPerSession),
        recallWindowSize: positiveContextWindow(compaction?.recallWindowSize),
        recallConcurrency: positiveContextWindow(compaction?.recallConcurrency),
        recallCycle1DeadlineMs: positiveContextWindow(compaction?.recallCycle1DeadlineMs),
        boundaryTokens: contextMeta.compactBoundaryTokens,
    };
}

export function createSession(opts) {
    const presetObj = opts.preset && typeof opts.preset === 'object' ? opts.preset : null;

    // --- Agent Runtime profile resolution (best-effort, sync) ---
    let profile = opts.profile || null;
    let providerCacheOpts = opts.providerCacheOpts || null;
    if (!profile && (opts.taskType || opts.agent || opts.profileId)) {
        const agentRuntime = getAgentRuntimeSync();
        if (agentRuntime) {
            try {
                const resolved = agentRuntime.resolveSync({
                    taskType: opts.taskType,
                    agent: opts.agent,
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
                warnAgentRuntimeResolveFailureOnce(e.message);
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
    const modelParameters = opts.modelParameters && typeof opts.modelParameters === 'object'
        ? { ...opts.modelParameters }
        : (presetObj?.modelParameters && typeof presetObj.modelParameters === 'object'
            ? { ...presetObj.modelParameters }
            : {});
    const requestedContextPercent = Number(opts.contextPercent);
    const contextPercent = Number.isFinite(requestedContextPercent) && requestedContextPercent > 0
        ? Math.max(10, Math.min(100, Math.round(requestedContextPercent / 10) * 10))
        : null;
    if (!providerName)
        throw new Error('createSession: provider is required');
    if (!modelName)
        throw new Error('createSession: model is required');
    const provider = getProvider(providerName);
    if (!provider)
        throw new Error(`Provider "${providerName}" not found or not enabled`);
    const requestedId = String(opts.id || '').trim();
    if (requestedId && !/^[A-Za-z0-9_-]+$/.test(requestedId)) {
        throw new Error('createSession: id is invalid');
    }
    // The daemon may reserve the durable address before provider/session
    // materialization. Supplying that reservation here keeps the address
    // stable across intake -> queued turn -> provider execution.
    const id = requestedId || mintSessionId();
    // Provider cache strategy — agentRuntime.resolveSync() above is a
    // best-effort injection point (setAgentRuntime() has no live caller
    // today, so that branch never fires); build it directly here so every
    // session still gets a cache strategy. Lead sessions (opts.agent ===
    // 'lead', or no agent at all — raw/CLI callers) get their BP4 message
    // tail TTL linked to the user's autoClear idle-sweep config; hidden and
    // public agents keep the flat 5m default (see cache-strategy.mjs docs).
    // Scoped to explicit-breakpoint (Anthropic-family) providers only — the
    // non-Anthropic branches of buildProviderCacheOpts (e.g. the 'openai'
    // cacheRetention:'24h' shape) were never exercised by createSession
    // before this change, and are left untouched to avoid altering live
    // OpenAI/other-provider request shape as a side effect of this fix.
    if (!providerCacheOpts) providerCacheOpts = buildSessionProviderCacheOpts(providerName, id, opts.agent);
    const messages = [];
    const ownerIsAgent = isAgentOwner(opts.owner);
    const resolvedAgent = opts.agent || opts.role || profile?.taskType || null;
    const hiddenAgent = getHiddenAgent(resolvedAgent);
    const isRetrievalAgent = hiddenAgent?.kind === 'retrieval';
    // Skill schema is fixed for public agent sessions, but hidden retrieval /
    // maintenance roles are deliberately narrowed away from the Skill tool.
    // Do not leak a Skill manifest into those hidden prompts when no Skill()
    // loader is available.
    const skills = (opts.skipSkills || hiddenAgent) ? [] : collectPromptSkillsCached(opts.cwd);

    // BP1 is shared tool policy. BP2 holds persistent profile/tool catalogs;
    // BP3 holds workflow/role and session/project environment.
    const agentRulesProfile = isRetrievalAgent ? 'retrieval' : 'full';
    const skipAgentRules = opts.skipAgentRules === true;
    // BP1 shared tool policy ships to EVERY role (Lead, workers, retrieval,
    // maintenance): its anti-spiral clauses (one anchor is enough, never
    // repeat equivalent patterns/scopes, plausible hit → stop) are exactly
    // what narrow retrieval roles need. Role docs
    // override role-inapplicable entries.
    const sessionDeny = [
        ...(Array.isArray(opts.disallowedTools) ? opts.disallowedTools : []),
        ...(hiddenAgent ? ['Skill'] : []),
        ...(!ownerIsAgent && workflowDisallowsAgentTool(opts.workflow) ? ['agent'] : []),
    ];
    // The edit dialect this model never receives is omitted from the rules as
    // well, so a session never reads placement guidance for a tool it cannot
    // call.
    const ruleOmitTools = [...sessionDeny, unusedModelEditToolName(modelName)];
    const injectedRules = skipAgentRules ? '' : _buildSharedRules({ omitTools: ruleOmitTools });
    const delegationFree = !ownerIsAgent && workflowDisallowsAgentTool(opts.workflow);
    const roleRules = skipAgentRules
        ? ''
        : (ownerIsAgent
            ? _buildAgentRules(agentRulesProfile)
            : _buildLeadRules({ includeLeadBrief: !delegationFree }));
    const metaContext = skipAgentRules ? '' : (ownerIsAgent ? '' : _buildLeadMetaContext());
    // Prompt permission is metadata for the write bundle, but a read-only role
    // is stamped BEFORE the toolSpec decision so its schema ships the narrowed
    // bundle. Resolve toolPermission (with profile/preset fallbacks) first, and
    // let the stored/logged `permission` reflect that resolved value — not just
    // opts.permission — so diagnostics show the effective read/write class.
    const toolPermission = opts.permission
        || profile?.permission
        || permissionFromToolSpec(toolPreset)
        || null;
    const permission = toolPermission;

    // Agent sessions do not inherit arbitrary role/profile/preset tool
    // narrowing — that would shatter provider prefix reuse into one shard per
    // role. Instead they collapse onto exactly TWO stable, bit-identical
    // bundles, one cache group each:
    //   - read-only roles (reviewer / hidden retrieval, i.e. any
    //     session resolving to permission 'read') -> 'readonly' bundle:
    //     read builtins (code_graph/find/glob/list/grep/read) + retrieval
        // (web_search/web_fetch/Skill) + shell/task for self-verification
    //     (agent-owned readonly bundle only), no apply_patch, no MCP-write.
    //     applyToolPermissionNarrowing('read') below trims the
    //     bundle to AGENT_STRING_PERMISSION_READ_ALLOW so the final surface is
    //     bit-identical across these roles regardless of MCP registry state.
    //   - write roles (worker / heavy-worker / maintainer / …) -> 'full'
    //     bundle: the historical full schema.
    // Call-time permission enforcement below is UNCHANGED (defense in depth):
    // applyToolPermissionNarrowing still runs so the bundle choice never
    // widens effective access.
    const isReadOnlyAgentBundle = ownerIsAgent && toolPermission === 'read';
    const toolSpec = ownerIsAgent
        ? (isReadOnlyAgentBundle ? 'readonly' : 'full')
        : (Array.isArray(profile?.tools) ? profile.tools : toolPreset);
    let toolsForRouting = resolveSessionTools(toolSpec, skills, {
        ownerIsAgentSession: ownerIsAgent,
        mcpScopeId: opts.mcpScopeId || null,
        modelName,
    });
    // Fail-closed permission intersection: when a session declares an explicit
    // object-form permission, intersect the
    // resolved tool list with the permission's allow/deny lists. If the
    // intersection produces an empty set the permission config is broken —
    // fail closed (zero tools) rather than silently falling back to the full
    // preset, which would grant the role more surface than declared.
    if (ownerIsAgent) {
        // Pass the RESOLVED agent (opts.agent || opts.role): narrowing keys
        // retrieval/locator roles off this name to strip
        // shell/task; verifying read roles (reviewer) keep them.
        toolsForRouting = applyToolPermissionNarrowing(toolsForRouting, toolPermission, resolvedAgent);
    }

    const workflowMeta = toSessionWorkflowMeta(opts.workflow);
    const hasCallerAllow = Array.isArray(opts.schemaAllowedTools);
    const tools = finalizeSessionToolList(toolsForRouting, {
        schemaAllowedTools: hasCallerAllow ? opts.schemaAllowedTools : null,
        disallowedTools: sessionDeny,
        ownerIsAgent,
        resolvedAgent,
    });
    // Preserve the exact pre-layout environment payload: Lead carried the
    // shell preference in Profile Preferences, while any routing surface with
    // shell carried the startup capability line in BP1.
    // opts.cwd is the session's explicit Project root. Raw callers that omit
    // it still get a location line via captureOriginalUserCwd(), which
    // resolves explicit session signals first and never leaks the daemon's
    // install root (user-cwd.mjs safe fallback chain).
    const sessionCwdLine = opts.cwd || captureOriginalUserCwd();
    const wantsGitStartupLine = toolsForRouting.some((tool) => tool?.name === 'git');
    const shellEnvironmentContext = [
        sessionCwdLine
            ? `- Cwd: ${sessionCwdLine} — the active Project root; relative paths and shell commands resolve here.`
            : '',
        `- Shell: ${process.platform === 'win32' ? 'PowerShell' : 'Bash'}. Use ${process.platform === 'win32' ? 'PowerShell' : 'Bash'} syntax unless the user specifies otherwise.`,
        // A startup inventory of PATH binaries used to sit here; see
        // runtime-capabilities.mjs for why it cannot be stated truthfully
        // before a command has run. Whether the cwd is inside a repository is
        // different: it is a property of this directory, true at startup and
        // observable without spawning anything, and the git tool cannot infer
        // it. Without it a session spends a call discovering `exited 128`, and
        // repeats it per candidate path.
        wantsGitStartupLine
            ? describeGitStartupState(sessionCwdLine ? { cwd: sessionCwdLine } : {})
            : '',
    ].filter(Boolean).join('\n');
    const { baseRules, stableSystemContext, sessionMarkerCore, sessionEnvironment } = composeSystemPrompt({
        userPrompt: opts.systemPrompt,
        agentRules: injectedRules || undefined,
        roleRules: roleRules || undefined,
        metaContext: metaContext || undefined,
        skipRoleCatalog: !ownerIsAgent,
        profile: profile || undefined,
        agent: resolvedAgent,
        workflowContext: opts.workflowContext || null,
        coreMemoryContext: opts.coreMemoryContext || null,
        skillManifest: buildSkillManifest(skills),
        environmentContext: shellEnvironmentContext,
        provider: providerName || null,
    });
    // 4-BP layout (see composeSystemPrompt docs):
    //   system block #1 = baseRules — BP1 (1h) shared tool policy
    //   system block #2 = stableSystemContext — BP2 (1h) profile + skills +
    //     deferred/MCP catalog
    //   system block #3 = sessionMarkerCore — BP3 (1h) workflow/role + memory
    //   system block #4 = sessionEnvironment — UNMARKED volatile session/
    //     project environment (cacheTier:'env'); covered by the messages-tail
    //     BP so an environment change (e.g. a different Cwd) can never
    //     invalidate the BP3 core write.
    //   later normal messages        = BP4/tail (task, role data, tool history)
    // Anthropic multi-block system pins each marked block with cache_control
    // (BP3 is the 3rd system block, tagged cacheTier:'tier3'; the env block
    // stays unmarked). OpenAI/xAI get stable provider cache keys/session
    // prefixes. Gemini manages explicit cachedContents inside its provider.
    if (baseRules) {
        messages.push({ role: 'system', content: baseRules });
    }
    if (stableSystemContext) {
        messages.push({ role: 'system', content: stableSystemContext });
    }
    if (sessionMarkerCore) {
        // cacheTier:'tier3' tells the Anthropic providers to pin THIS system
        // block with the tier3 1h cache_control (BP3) — distinct from the
        // BP1/BP2 system TTL. Harmless on non-Anthropic providers (they ignore
        // the field and serialize content as a normal system instruction).
        messages.push({ role: 'system', content: sessionMarkerCore, cacheTier: 'tier3' });
    }
    if (sessionEnvironment) {
        // cacheTier:'env' → Anthropic providers leave this block UNMARKED so
        // the volatile environment rides the messages-tail breakpoint instead
        // of invalidating the stable BP3 core prefix.
        messages.push({ role: 'system', content: sessionEnvironment, cacheTier: 'env' });
    }
    if (opts.files?.length) {
        const fileContext = opts.files
            .map(f => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
            .join('\n\n');
        messages.push({ role: 'user', content: `Reference files:\n\n${fileContext}` });
        messages.push({ role: 'assistant', content: '.' });
    }
    // Unified-shard policy — no broad role-specific schema filter. Keep
    // agent schemas shared unless a hidden-role schema profile explicitly
    // passes schemaAllowedTools for a small specialist; broad role
    // whitelists would fragment the cache shard.
    if (resolvedAgent && process.env.MIXDOG_DEBUG_SESSION_LOG) {
        process.stderr.write(`[session] agent=${resolvedAgent} permission=${permission || 'full'} toolPermission=${toolPermission || 'full'} tools=${tools.length}\n`);
    }
    const contextMeta = resolveSessionContextMeta(provider, modelName, {
        selectedContextWindow: opts.selectedContextWindow,
    });
    const session = {
        id,
        codexWireSessionId: providerName === 'openai-oauth' ? mintUuidV7() : null,
        provider: providerName,
        model: modelName,
        messages,
        contextWindow: contextMeta.contextWindow,
        rawContextWindow: contextMeta.rawContextWindow,
        effectiveContextWindowPercent: contextMeta.effectiveContextWindowPercent,
        autoCompactTokenLimit: contextMeta.autoCompactTokenLimit,
        compactBoundaryTokens: contextMeta.compactBoundaryTokens,
        compaction: initialCompactionConfig(opts.compaction, contextMeta),
        tools,
        preset: toolPreset,
        // Persisted so the deferred call-through gate (deferred-call-through.mjs
        // resolveDeferredSelectMode) can resolve the session's tool mode; without
        // this every session read `undefined` and write-capable deferred tools
        // (e.g. MCP) were permanently denied auto-promotion.
        toolSpec,
        presetName: presetObj?.name || null,
        effort,
        fast,
        modelParameters,
        contextPercent,
        selectedContextWindow: opts.selectedContextWindow || null,
        agent: opts.agent,
        owner: opts.owner || 'user',
        bp3CoreContext: sessionMarkerCore,
        bp3EnvironmentContext: shellEnvironmentContext,
        // BP3 core and the volatile environment live in SEPARATE system
        // blocks (cacheTier 'tier3' vs 'env'). Legacy persisted sessions
        // without this flag keep the combined-BP3 refresh path.
        bp3EnvSplit: true,
        sessionStartMetaInjected: false,
        ...(opts.approvalMode === IMPLICIT_APPROVAL_MODE
            ? { approvalMode: IMPLICIT_APPROVAL_MODE }
            : {}),
        mcpPid: process.pid,
        mcpScopeId: opts.mcpScopeId || null,
        scopeKey: opts.scopeKey || null,
        lane: opts.lane || 'agent',
        cwd: opts.cwd,
        // Optional desktop-only origin metadata. CLI/TUI callers omit it, so
        // their persisted shape and classification behavior remain unchanged.
        desktopSession: normalizeDesktopSessionMetadata(opts.desktopSession, opts.cwd),
        workflow: workflowMeta,
        disallowedTools: sessionDeny.map((name) => String(name)),
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
        schemaAllowedTools: hasCallerAllow ? opts.schemaAllowedTools.map((n) => String(n)) : null,
        // Origin tag written into every agent-trace usage row so analytics
        // can slice by (sourceType, sourceName) — e.g. maintenance/cycle1,
        // scheduler/daily-standup, webhook/github-push, lead/worker.
        sourceType: opts.sourceType || null,
        sourceName: opts.sourceName || null,
        // Automation delivery mode ('app' | 'channel' | 'both'): the desktop
        // sidebar hides channel-only runner sessions from Automations.
        sourceDelivery: opts.sourceDelivery || null,
        // Provider-scoped unified cache key — one shard per provider,
        // shared across all roles / sources (agent/maintenance/mcp/
        // scheduler/webhook). Role or source-specific context must be
        // injected into the message tail, not the shared prefix.
        promptCacheKey: providerCacheKey(presetObj?.provider || opts.provider, opts.cacheKeyOverride),
        // Agent Runtime metadata — optional. Applied on every ask() to merge
        // profile-driven cache settings into provider sendOpts.
        profileId: profile?.id || null,
        permissionMode: opts.permissionMode ?? null,
        providerCacheOpts: providerCacheOpts || null,
        ownerSessionId: opts.ownerSessionId || null,
        clientHostPid: opts.clientHostPid || null,
    };
    refreshSessionBp3Environment(session, opts.cwd);
    // In-process registry + async debounced save: same-process create → load
    // reads live memory; disk flush is for cross-process / restart durability.
    setLiveSession(session);
    saveSession(session);
    return session;
}

export function contextSeedForRouteUpdate(session, routeChanged, selectedContextWindowProvided = false) {
    if (!routeChanged) return session;
    return selectedContextWindowProvided
        ? { selectedContextWindow: session?.selectedContextWindow || null }
        : {};
}

// The shared-rules block (BP1) renders tool-conditional variants against the
// edit dialect the model actually receives (edit vs apply_patch). An
// empty-session route change swaps the tool surface, so this block must
// re-render too — otherwise a session created on a GPT default route and
// switched to Claude keeps apply_patch placement guidance for a tool it can
// no longer call (and vice versa). The block is identified by EXACT previous
// content: the old variant is rebuilt from the same inputs and matched, so
// only the true BP1 block is ever replaced; custom-prompt or agent layouts
// without that block are left untouched, and a same-dialect switch is a no-op.
export function _refreshSessionRuleVariantsForModel(session, previousModel) {
    const deny = [
        ...(Array.isArray(session?.disallowedTools) ? session.disallowedTools : []),
        ...(getHiddenAgent(session?.agent || null) ? ['Skill'] : []),
        ...(!isAgentOwner(session) && workflowDisallowsAgentTool(session?.workflow) ? ['agent'] : []),
    ];
    const previousRules = _buildSharedRules({ omitTools: [...deny, unusedModelEditToolName(previousModel)] });
    const nextRules = _buildSharedRules({ omitTools: [...deny, unusedModelEditToolName(session?.model)] });
    if (!previousRules || previousRules === nextRules) return false;
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const index = messages.findIndex((message) => (
        message?.role === 'system' && !message.cacheTier && message.content === previousRules
    ));
    if (index < 0) return false;
    // Replace, never mutate: session-store delta saves treat stable message
    // references as an append-only prefix, so a fresh object forces the full
    // snapshot that keeps the persisted transcript in sync.
    messages[index] = { ...messages[index], content: nextRules };
    return true;
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
    ensureCodexWireSessionId(session);
    if (Object.prototype.hasOwnProperty.call(route, 'modelParameters')) {
        session.modelParameters = route.modelParameters && typeof route.modelParameters === 'object'
            ? { ...route.modelParameters }
            : {};
    }
    if (Object.prototype.hasOwnProperty.call(route, 'contextPercent')) {
        const requestedContextPercent = Number(route.contextPercent);
        session.contextPercent = Number.isFinite(requestedContextPercent) && requestedContextPercent > 0
            ? Math.max(10, Math.min(100, Math.round(requestedContextPercent / 10) * 10))
            : null;
    }
    const selectedContextWindowProvided = Object.prototype.hasOwnProperty.call(route, 'selectedContextWindow');
    if (selectedContextWindowProvided) {
        session.selectedContextWindow = Number(route.selectedContextWindow) || null;
    }
    const routeChanged = (route.provider && route.provider !== previousProvider)
        || (route.model && route.model !== previousModel);
    const provider = session.provider ? getProvider(session.provider) : null;
    if (provider && session.model) {
        // Provider/model windows are derived metadata. Never seed a new route
        // with the old route's persisted boundary (for example GPT 272k
        // leaking into Cursor Gemini after an empty-session model switch).
        const contextSeed = contextSeedForRouteUpdate(
            session,
            routeChanged,
            selectedContextWindowProvided,
        );
        const contextMeta = resolveSessionContextMeta(provider, session.model, contextSeed);
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
    if (routeChanged) {
        const now = Date.now();
        session.promptCacheKey = providerCacheKey(session.provider);
        session.providerCacheOpts = buildSessionProviderCacheOpts(session.provider, session.id, session.agent) || null;
        session.lastInputTokens = 0;
        session.lastOutputTokens = 0;
        session.lastCachedReadTokens = 0;
        session.lastCacheWriteTokens = 0;
        session.lastContextTokens = 0;
        session.lastContextTokensUpdatedAt = now;
        session.lastContextTokensStaleAfterCompact = false;
        session.providerState = undefined;
        const prepared = _prepareResumeTools(session, session.preset || 'full');
        session.tools = prepared.tools;
        session.toolSpec = prepared.toolSpec;
        if (Array.isArray(session.deferredToolCatalog)) {
            session.deferredToolCatalog = filterModelEditTools(session.deferredToolCatalog, session.model);
        }
        if (Array.isArray(session.deferredLateToolCatalog)) {
            session.deferredLateToolCatalog = filterModelEditTools(session.deferredLateToolCatalog, session.model);
        }
        for (const key of ['deferredSelectedTools', 'deferredCallableTools', 'deferredDefaultTools', 'deferredDiscoveredTools']) {
            if (Array.isArray(session[key])) session[key] = filterModelEditToolNames(session[key], session.model);
        }
        _refreshSessionRuleVariantsForModel(session, previousModel);
        _preparedResumes.delete(id);
    }
    // Route fields feed the `# Session` prompt block (Model: … · EFFORT · FAST).
    // Rebuild it here: createSession stamped the block with the creation-time
    // route and set sessionStartMetaInjected, so the ask-time refresh guard
    // skips it and an empty-session route change would otherwise keep the old
    // model line in the system prompt (model self-identity confusion).
    refreshSessionBp3Environment(session, session.cwd);
    session.updatedAt = Date.now();
    setLiveSession(session);
    void saveSessionAsync(session, { expectedGeneration: session.generation })
        .catch((err) => {
            try { process.stderr.write(`[session] route update save failed: ${err?.message || err}\n`); } catch {}
        });
    return session;
}

// --- resume (reload tools for a stored session) ---
// Attach-on-resume guard: resuming a session that another live process is
// ACTIVELY driving right now must not create a second writer on the same
// file — that split-brain silently freezes one side's transcript (generation
// ownership drops the loser's saves). Such a resume ATTACHES instead: the
// caller gets the live transcript flagged remoteAttached, its submits are
// persisted into the shared pending spool (the owner's injection poller runs
// them as normal user turns), and its view refreshes from disk. ONE writer,
// ONE transcript, every surface talking into the same conversation. Idle
// sessions keep the normal single-identity handoff.
const ACTIVE_OWNER_HB_FRESH_MS = 2 * 60 * 1000; // heartbeat freshness window
const PREPARED_RESUME_LIMIT = 8;
const _preparedResumes = new Map();

function _prepareResumeTools(session, preset) {
    const ownerIsAgent = isAgentOwner(session);
    const skills = ownerIsAgent ? [] : collectPromptSkillsCached(session.cwd);
    let toolSpec = ownerIsAgent ? 'full' : (preset || session.preset || 'full');
    const agentRuntime = getAgentRuntimeSync();
    if (session.profileId && agentRuntime?.getProfile) {
        try {
            const profile = agentRuntime.getProfile(session.profileId);
            if (!ownerIsAgent && Array.isArray(profile?.tools)) toolSpec = profile.tools;
        } catch { /* ignore lookup failures, keep preset fallback */ }
    }
    let toolsForRouting = resolveSessionTools(toolSpec, skills, {
        ownerIsAgentSession: ownerIsAgent,
        mcpScopeId: session.mcpScopeId || null,
        modelName: session.model,
    });
    if (ownerIsAgent) {
        toolsForRouting = applyToolPermissionNarrowing(toolsForRouting, session.toolPermission, session.agent || null);
    }
    return {
        session,
        preset,
        toolSpec,
        ownerIsAgent,
        tools: finalizeSessionToolList(toolsForRouting, {
            schemaAllowedTools: Array.isArray(session.schemaAllowedTools) ? session.schemaAllowedTools : null,
            disallowedTools: [
                ...(Array.isArray(session.disallowedTools) ? session.disallowedTools : []),
                ...(getHiddenAgent(session.agent || null) ? ['Skill'] : []),
                ...(!isAgentOwner(session) && workflowDisallowsAgentTool(session.workflow) ? ['agent'] : []),
            ],
            ownerIsAgent,
            resolvedAgent: session.agent || null,
        }),
    };
}

function _rememberPreparedResume(sessionId, prepared) {
    _preparedResumes.delete(sessionId);
    _preparedResumes.set(sessionId, prepared);
    while (_preparedResumes.size > PREPARED_RESUME_LIMIT) {
        const oldest = _preparedResumes.keys().next().value;
        if (oldest === undefined) break;
        _preparedResumes.delete(oldest);
    }
}

function _preparedResumeForSession(session, preset) {
    const cached = _preparedResumes.get(session.id);
    if (cached?.session === session && cached?.preset === preset
        && cached?.mcpScopeId === (session.mcpScopeId || null)) return cached;
    const prepared = _prepareResumeTools(session, preset);
    prepared.mcpScopeId = session.mcpScopeId || null;
    _rememberPreparedResume(session.id, prepared);
    return prepared;
}

// Desktop session-row hover/idle prefetch. loadSession validates the atomic
// file signature before reusing its parsed object, so a later external write
// naturally misses this preparation and rebuilds from the new session object.
export function prefetchSession(sessionId, preset = 'full') {
    const session = loadSession(sessionId);
    if (!session || session.closed === true) return false;
    _preparedResumeForSession(session, preset);
    return true;
}

// Read-only desktop-pane projection. It shares the exact prepared tool surface
// that resumeSession will consume, but clones the session instead of claiming
// ownership or persisting refreshed metadata. This lets every visible pane run
// the live context-pressure calculation before it is ever focused.
export function prepareSessionProjection(session, preset = 'full') {
    if (!session?.id) return null;
    const prepared = _preparedResumeForSession(session, preset);
    let contextMeta = null;
    try {
        const provider = session.provider ? getProvider(session.provider) : null;
        if (provider && session.model) {
            contextMeta = resolveSessionContextMeta(provider, session.model, session);
        }
    } catch {
        // A cold metadata/provider failure must not make the transcript vanish.
    }
    return {
        ...session,
        toolSpec: prepared.toolSpec,
        tools: prepared.tools,
        ...(contextMeta ? {
            contextWindow: contextMeta.contextWindow,
            rawContextWindow: contextMeta.rawContextWindow,
            effectiveContextWindowPercent: contextMeta.effectiveContextWindowPercent,
            autoCompactTokenLimit: contextMeta.autoCompactTokenLimit,
            compactBoundaryTokens: contextMeta.compactBoundaryTokens,
            compaction: {
                ...(session.compaction || {}),
                boundaryTokens: contextMeta.compactBoundaryTokens,
                contextWindow: contextMeta.contextWindow,
                rawContextWindow: contextMeta.rawContextWindow,
                effectiveContextWindowPercent: contextMeta.effectiveContextWindowPercent,
                autoCompactTokenLimit: contextMeta.autoCompactTokenLimit,
            },
        } : {}),
    };
}

// Owner-pid hint for liveness signals that carry NO pid of their own:
// `session.lastHeartbeatAt` is persisted in the session file and therefore
// survives its writer forever, and pre-pid `.hb` sidecars only hold a
// timestamp. The recorded client host is the process that created/claimed the
// runtime for this session; the session-id prefix is the legacy fallback.
function _recordedOwnerPid(session, sessionId) {
    const recorded = Number(session?.clientHostPid) || 0;
    if (recorded > 0) return recorded;
    const match = /^sess_(\d+)_/.exec(String(sessionId || ''));
    return Number(match?.[1]) || 0;
}

function _isActivelyOwnedElsewhere(session, sessionId) {
    // This process already owns the runtime for the id — switching back to
    // one of our own sessions (desktop tab switch, TUI /resume) never attaches.
    const entry = _getRuntimeEntry(sessionId);
    if (entry && entry.closed !== true) return false;
    // A FORCE-KILLED owner leaves its `.own` sidecar behind looking fresh.
    // The recorded pid is authoritative: when it no longer exists, the owner
    // is gone — clear the stale sidecar and resume with normal ownership
    // instead of viewer-attaching into a spool nobody drains.
    if (isSessionPresenceOwnerDead(sessionId)) {
        deleteSessionPresence(sessionId);
        return false;
    }
    const now = Date.now();
    // Presence (`.own`, pid-verified just above) covers the idle gaps between
    // turns: a live interactive surface keeps refreshing it (~20s) for its
    // CURRENT session, so cross-opening an idle-but-open session still
    // attaches as a viewer instead of splitting ownership into two writers
    // that clobber each other's saves.
    const presenceAt = Number(readSessionPresenceMtime(sessionId)) || 0;
    if (presenceAt > 0 && now - presenceAt <= ACTIVE_OWNER_HB_FRESH_MS) return true;
    // Heartbeats publish only while a turn is running (≤5s cadence) and the
    // sidecar is deleted on detach/close, so freshness here means another
    // process is mid-conversation on this session right now — PROVIDED that
    // process still exists. Without the pid check a force-killed owner (app
    // upgrade restart, crash) kept looking live for the whole freshness
    // window, so every cross-open attached as a viewer and the user's
    // messages spooled to a queue nobody drains (silently dropped 30m later).
    if (isSessionHeartbeatOwnerDead(sessionId)) {
        void deleteHeartbeat(sessionId);
        return false;
    }
    const sidecarAt = Number(readSessionHeartbeatMtime(sessionId)) || 0;
    if (sidecarAt > 0 && now - sidecarAt <= ACTIVE_OWNER_HB_FRESH_MS
        && readSessionHeartbeatOwnerPid(sessionId) > 0) {
        // Fresh sidecar whose recorded pid is alive: a real owner is driving
        // this session right now, whatever the session file remembers.
        return true;
    }
    const heartbeatAt = Math.max(sidecarAt, Number(session.lastHeartbeatAt) || 0);
    if (!(heartbeatAt > 0 && now - heartbeatAt <= ACTIVE_OWNER_HB_FRESH_MS)) return false;
    // Pid-less evidence only (persisted field / legacy sidecar): fall back to
    // the recorded client-host pid. A dead host means no owner; an unknown pid
    // keeps the conservative attach.
    const ownerPid = _recordedOwnerPid(session, sessionId);
    if (ownerPid > 0 && !isProcessAlive(ownerPid)) return false;
    return true;
}

// Viewer self-heal probe: true when a re-resume of this session would NO
// LONGER attach (owner dead or every liveness signal stale). Attached
// surfaces poll this so a dead owner promotes the viewer instead of leaving
// it spooling messages to nobody. Single source of truth: the same guard
// the resume path uses.
export function isSessionOwnerGone(sessionId) {
    const session = loadSession(sessionId);
    if (!session) return false;
    return !_isActivelyOwnedElsewhere(session, sessionId);
}

function _recoverTurnCheckpointDurably(session, sessionId) {
    const recovery = recoverTurnCheckpoint(session);
    if (!recovery.changed) return recovery;
    // Recovery is a durable reconnect boundary, not a renderer-only view.
    // Persist before removing the checkpoint so a second crash leaves at
    // least one complete copy of the interrupted turn.
    saveSession(session, {
        sync: true,
        expectedGeneration: session.generation,
    });
    if (recovery.turnToken) {
        clearTurnCheckpoint(sessionId, recovery.turnToken);
    }
    // A force-killed owner cannot clear its activity/presence sidecars. Once
    // its checkpoint is committed as interrupted, neither sidecar may keep a
    // restored pane busy or make a new prompt queue behind a dead process.
    deleteSessionPresence(sessionId);
    void deleteHeartbeat(sessionId);
    return recovery;
}

// Reconnect-safe historical read used by desktop pane peeks. Unlike a normal
// read-only load, it resolves a dead owner's durable turn checkpoint before
// returning the transcript. A genuinely live foreign owner remains untouched.
export function recoverSessionAfterProcessRestart(sessionId) {
    const session = loadSession(sessionId);
    if (!session || session.closed === true) return session || null;
    if (_isActivelyOwnedElsewhere(session, sessionId)) return session;
    _recoverTurnCheckpointDurably(session, sessionId);
    return session;
}

export async function resumeSession(sessionId, preset, options = {}) {
    let session = loadSession(sessionId);
    if (!session)
        return null;
    // Resuming a closed session is a resurrection attempt — refuse. The guarded
    // save below would also block the write, but failing fast here is cleaner
    // than silently dropping the tool-refresh side effects.
    if (session.closed === true) return null;
    ensureCodexWireSessionId(session);
    // Desktop callers pass their selected durable classification as a
    // capability check. Refuse a stale/tampered cross-class resume before any
    // tool refresh or save. CLI/TUI callers omit this option and retain the
    // historical unrestricted resume behavior.
    if (Object.prototype.hasOwnProperty.call(options, 'desktopSession')) {
        const expectedDesktop = normalizeDesktopSessionMetadata(options.desktopSession, session.cwd);
        const storedDesktop = normalizeDesktopSessionMetadata(session.desktopSession, session.cwd);
        if (!expectedDesktop || !storedDesktop
            || expectedDesktop.classification !== storedDesktop.classification) {
            return null;
        }
        // Adopt the host-canonical project path selected from the authoritative
        // summary. Task metadata always remains pathless.
        session.desktopSession = expectedDesktop;
    }
    if (!session.owner) session.owner = 'user';
    if (Object.prototype.hasOwnProperty.call(options, 'mcpScopeId')) {
        session.mcpScopeId = String(options.mcpScopeId || '').trim() || null;
    }
    if (_isActivelyOwnedElsewhere(session, sessionId)) {
        // ATTACH (viewer mode, zero ownership): hand back the live transcript
        // under the SAME id, flagged remoteAttached. No tool refresh, no save,
        // no generation claim — the session file remains exclusively the
        // owner's. session-turn-api routes this surface's submits into the
        // shared pending spool instead of running a local turn.
        const attached = { ...session, remoteAttached: true };
        delete attached.liveTurnMessages;
        delete attached.toolApprovalHook;
        if (process.env.MIXDOG_DEBUG_SESSION_LOG) {
            try { process.stderr.write(`[session] attach-on-resume: ${sessionId} is live elsewhere → viewer attach\n`); } catch { /* best-effort */ }
        }
        return attached;
    }
    _recoverTurnCheckpointDurably(session, sessionId);
    const oldTools = session.tools || [];
    const cached = _preparedResumes.get(sessionId);
    _preparedResumes.delete(sessionId);
    const prepared = cached?.session === session && cached?.preset === preset
        && cached?.mcpScopeId === (session.mcpScopeId || null)
        ? cached
        : _prepareResumeTools(session, preset);
    // Keep the persisted tool mode in sync on resume (see createSession note).
    session.toolSpec = prepared.toolSpec;
    session.tools = prepared.tools;
    const newTools = session.tools;
    const missing = oldTools.filter(t => !newTools.find(n => n.name === t.name));
    if (missing.length) {
        process.stderr.write(`[session] Warning: ${missing.length} tools no longer available: ${missing.map(t => t.name).join(', ')}\n`);
    }
    // The live session already owns the refreshed tools and desktop scope.
    // Defer the structured clone + worker round-trip so opening a conversation
    // is not blocked on persisting the same in-memory state back to disk.
    void saveSessionAsyncDeferred(session, { expectedGeneration: session.generation })
        .catch((err) => {
            try { process.stderr.write(`[session] resume save failed: ${err?.message || err}\n`); } catch {}
        });
    return session;
}
