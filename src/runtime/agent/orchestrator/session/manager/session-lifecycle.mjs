// manager/session-lifecycle.mjs
// Session build/route/resume lifecycle extracted verbatim from manager.mjs.
// createSession (spawn), updateSessionRoute (provider/model reroute), and
// resumeSession (reload tools for a stored session) all share the same tool
// resolution + context-meta + agent-runtime resolution helpers.
import { getProvider } from '../../providers/registry.mjs';
import { normalizeCompactType, DEFAULT_COMPACT_TYPE } from '../compact.mjs';
import { collectPromptSkillsCached, buildSkillManifest, composeSystemPrompt } from '../../context/collect.mjs';
import { saveSession, saveSessionAsync, loadSession, setLiveSession } from '../store.mjs';
import { isAgentOwner } from '../../agent-owner.mjs';
import { getHiddenAgent } from '../../internal-agents.mjs';
import { loadConfig } from '../../config.mjs';
import { buildProviderCacheOpts, cacheCapabilityForProvider } from '../../agent-runtime/cache-strategy.mjs';
import { normalizeAutoClearConfig, resolveAutoClearIdleMs } from '../../../../../session-runtime/config-helpers.mjs';
import {
    _buildSharedRules,
    _buildAgentRules,
    _buildLeadRules,
    _buildLeadMetaContext,
    _buildAgentSpecific,
} from './rules-cache.mjs';
import {
    applyToolPermissionNarrowing,
    finalizeSessionToolList,
    resolveSessionTools,
    permissionFromToolSpec,
} from './tool-resolution.mjs';
import {
    positiveContextWindow,
    preserveBufferConfigFields,
    resolveSessionContextMeta,
} from './context-meta.mjs';
import { getAgentRuntimeSync, warnAgentRuntimeResolveFailureOnce } from './agent-runtime-singleton.mjs';
import { mintSessionId } from './session-id.mjs';
import { providerCacheKey } from './provider-cache-key.mjs';

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
    if (!providerName)
        throw new Error('createSession: provider is required');
    if (!modelName)
        throw new Error('createSession: model is required');
    const provider = getProvider(providerName);
    if (!provider)
        throw new Error(`Provider "${providerName}" not found or not enabled`);
    const id = mintSessionId();
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
    if (!providerCacheOpts && cacheCapabilityForProvider(providerName) === 'explicit-breakpoint') {
        try {
            let autoClear = null;
            if (!opts.agent || opts.agent === 'lead') {
                const loadedConfig = loadConfig({ secrets: false });
                const normalizedAutoClear = normalizeAutoClearConfig(loadedConfig?.autoClear);
                autoClear = {
                    ...normalizedAutoClear,
                    idleMs: resolveAutoClearIdleMs(loadedConfig, providerName),
                };
            }
            providerCacheOpts = buildProviderCacheOpts(providerName, id, opts.agent, { autoClear });
        } catch {
            providerCacheOpts = null;
        }
    }
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

    // BP1 is shared tool policy (+ compact skill manifest in compose). BP2 is
    // role/system rules. User-defined schedules/webhooks ride as normal user
    // context below so event data does not rewrite BP3 memory/meta.
    const agentRulesAgent = opts.agent || opts.role || profile?.taskType || null;
    const agentRulesProfile = isRetrievalAgent ? 'retrieval' : 'full';
    const skipAgentRules = opts.skipAgentRules === true;
    // BP1 shared tool policy ships to EVERY role (Lead, workers, retrieval,
    // maintenance): its anti-spiral clauses (one anchor is enough, never
    // repeat equivalent patterns/scopes, plausible hit → stop) are exactly
    // what narrow retrieval roles need. Role docs (e.g. 30-explorer.md)
    // override role-inapplicable entries such as the explore routing row.
    const injectedRules = skipAgentRules ? '' : _buildSharedRules();
    const roleRules = skipAgentRules ? '' : (ownerIsAgent ? _buildAgentRules(agentRulesProfile) : _buildLeadRules());
    const metaContext = skipAgentRules ? '' : (ownerIsAgent ? '' : _buildLeadMetaContext());
    const roleSpecific = ownerIsAgent && !skipAgentRules ? _buildAgentSpecific(agentRulesAgent) : '';
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
    //   - read-only roles (reviewer / debugger / hidden retrieval, i.e. any
    //     session resolving to permission 'read') -> 'readonly' bundle:
    //     read builtins (code_graph/find/glob/list/grep/read) + retrieval
    //     (explore/search/web_fetch/Skill), no apply_patch/shell/task, no
    //     MCP-write. applyToolPermissionNarrowing('read') below trims the
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
    let toolsForRouting = resolveSessionTools(toolSpec, skills, { ownerIsAgentSession: ownerIsAgent });
    // Fail-closed permission intersection: when a session declares an explicit
    // object-form permission, intersect the
    // resolved tool list with the permission's allow/deny lists. If the
    // intersection produces an empty set the permission config is broken —
    // fail closed (zero tools) rather than silently falling back to the full
    // preset, which would grant the role more surface than declared.
    if (ownerIsAgent) {
        toolsForRouting = applyToolPermissionNarrowing(toolsForRouting, toolPermission, opts.agent || null);
    }

    const { baseRules, stableSystemContext, sessionMarker, volatileTail } = composeSystemPrompt({
        userPrompt: opts.systemPrompt,
        agentRules: injectedRules || undefined,
        roleRules: roleRules || undefined,
        metaContext: metaContext || undefined,
        skipRoleCatalog: !ownerIsAgent,
        profile: profile || undefined,
        agent: resolvedAgent,
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
    const hasCallerAllow = Array.isArray(opts.schemaAllowedTools);
    const tools = finalizeSessionToolList(toolsForRouting, {
        schemaAllowedTools: hasCallerAllow ? opts.schemaAllowedTools : null,
        disallowedTools: hiddenAgent ? [...(Array.isArray(opts.disallowedTools) ? opts.disallowedTools : []), 'Skill'] : opts.disallowedTools,
        ownerIsAgent,
        resolvedAgent,
    });

    // Unified-shard policy — no broad role-specific schema filter. Keep
    // agent schemas shared unless a hidden-role schema profile explicitly
    // passes schemaAllowedTools for a small specialist; broad role
    // whitelists would fragment the cache shard.
    if (resolvedAgent && process.env.MIXDOG_DEBUG_SESSION_LOG) {
        process.stderr.write(`[session] agent=${resolvedAgent} permission=${permission || 'full'} toolPermission=${toolPermission || 'full'} tools=${tools.length}\n`);
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
            // Preserve percent/ratio-named buffer config so the manager/loop/
            // contextStatus parsers (which read bufferPercent/bufferPct/
            // bufferRatio/bufferFraction) can honor it. createSession previously
            // only stored bufferTokens, silently dropping a configured percent.
            ...preserveBufferConfigFields(opts.compaction),
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
        // Persisted so the deferred call-through gate (deferred-call-through.mjs
        // resolveDeferredSelectMode) can resolve the session's tool mode; without
        // this every session read `undefined` and write-capable deferred tools
        // (e.g. MCP) were permanently denied auto-promotion.
        toolSpec,
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
    const oldTools = session.tools || [];
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
    let toolsForRouting = resolveSessionTools(toolSpec, skills, { ownerIsAgentSession: ownerIsAgent });
    if (ownerIsAgent) {
        toolsForRouting = applyToolPermissionNarrowing(toolsForRouting, session.toolPermission, session.agent || null);
    }
    // Keep the persisted tool mode in sync on resume (see createSession note).
    session.toolSpec = toolSpec;
    session.tools = finalizeSessionToolList(toolsForRouting, {
        schemaAllowedTools: Array.isArray(session.schemaAllowedTools) ? session.schemaAllowedTools : null,
        disallowedTools: getHiddenAgent(session.agent || null) ? ['Skill'] : null,
        ownerIsAgent,
        resolvedAgent: session.agent || null,
    });
    const newTools = session.tools;
    const missing = oldTools.filter(t => !newTools.find(n => n.name === t.name));
    if (missing.length) {
        process.stderr.write(`[session] Warning: ${missing.length} tools no longer available: ${missing.map(t => t.name).join(', ')}\n`);
    }
    await saveSessionAsync(session, { expectedGeneration: session.generation });
    return session;
}
