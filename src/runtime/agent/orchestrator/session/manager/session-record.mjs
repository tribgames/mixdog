// manager/session-record.mjs
// What a persisted session row contains and where each field comes from: the
// compaction budget, the origin/permission/cache metadata analytics slice on,
// the desktop classification, and the record assembled from them. Everything
// here is field derivation — no ownership, no prompt text; the only read is the
// parent's record a delegated session takes its root from.
import { toSessionWorkflowMeta } from '../../runtime-core/workflow.mjs';
import { delegationForNewSession, runForNewSession } from '../human-gate/delegation.mjs';
import { sessionOrchestrationMode } from '../../../../shared/orchestration.mjs';
import { preserveBufferConfigFields } from './context-meta.mjs';
import { positiveInt } from '../../../../shared/numbers.mjs';
import { mintUuidV7 } from './session-id.mjs';
import { providerCacheKey } from './provider-cache-key.mjs';
import { IMPLICIT_APPROVAL_MODE } from '../approval-mode.mjs';

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

function initialCompactionConfig(compaction = {}, contextMeta = {}) {
  return {
    auto: compaction?.auto !== false,
    model: compaction?.model || null,
    summaryModel: compaction?.summaryModel || compaction?.semanticModel || null,
    timeoutMs: positiveInt(compaction?.timeoutMs),
    memoryTimeoutMs: positiveInt(compaction?.memoryTimeoutMs ?? compaction?.recallMemoryTimeoutMs),
    bufferTokens: positiveInt(compaction?.bufferTokens ?? compaction?.buffer),
    mainBufferTokens: positiveInt(compaction?.mainBufferTokens ?? compaction?.mainBuffer),
    // Preserve percent/ratio-named config so the shared policy can honor
    // agent and main/user buffer settings.
    ...preserveBufferConfigFields(compaction),
    reservedTokens: positiveInt(compaction?.reservedTokens),
    boundaryTokens: contextMeta.compactBoundaryTokens,
  };
}

// Origin, permission and cache metadata persisted on the session record.
export function sessionOriginFields(opts, { profile, presetObj, providerCacheOpts, surface }) {
  const { toolPermission, hasCallerAllow } = surface;
  return {
    taskType: opts.taskType || null,
    // Agent tag (auto worker{n} on spawn) persisted so the forked status
    // process (statusline) + aggregator can read it from the session JSON.
    // In-process send/close still resolve via _tagSessionRegistry.
    agentTag: opts.agentTag || null,
    // Prompt permission is separate from runtime toolPermission so preset
    // restrictions do not fragment the agent cache prefix.
    permission: toolPermission || null,
    toolPermission: toolPermission || null,
    schemaAllowedTools: hasCallerAllow ? opts.schemaAllowedTools.map((n) => String(n)) : null,
    // Origin tag written into every agent-trace usage row so analytics
    // can slice by (sourceType, sourceName) — e.g. maintenance/cycle1,
    // scheduler/daily-standup, webhook/github-push, lead/worker.
    sourceType: opts.sourceType || null,
    sourceName: opts.sourceName || null,
    // The agent a schedule/webhook run acts for: whose memory it may write
    // (session-runtime/services/memory-access.mjs). Absent on other sessions.
    ...(opts.ownerAgentId ? { ownerAgentId: String(opts.ownerAgentId) } : {}),
    // A coding task session an agent created (session create): who asked, from
    // which thread, the request, and the title it was given.
    ...(opts.taskOrigin
      ? {
          taskOrigin: opts.taskOrigin,
          title: opts.taskOrigin.title,
          titleLocked: true,
          titleSource: 'ai',
          titleUpdatedAt: Date.now(),
        }
      : {}),
    // Provider-scoped unified cache key — one shard per provider,
    // shared across all roles / sources (agent/maintenance/mcp/
    // scheduler/webhook). Role or source-specific context must be
    // injected into the message tail, not the shared prefix.
    promptCacheKey: providerCacheKey(presetObj?.provider || opts.provider, opts.cacheKeyOverride),
    // Agent Runtime metadata — optional. Applied on every ask() to merge
    // profile-driven cache settings into provider sendOpts.
    profileId: profile?.id || null,
    // A profile skipping `claudemd` keeps instruction files out of later
    // empty-session prompt rebuilds too (tool-policy-refresh.mjs).
    skipInstructionFiles: profile?.skip?.claudemd === true,
    permissionMode: opts.permissionMode ?? null,
    providerCacheOpts: providerCacheOpts || null,
    parentSessionId: opts.parentSessionId || null,
    ownerSessionId: opts.ownerSessionId || null,
    visibility: opts.visibility || null,
    clientHostPid: opts.clientHostPid || null,
    // A sub-agent's root and the run (if any) that started a sub-agent or a
    // bot-created task session, derived from its creator — the one read here —
    // never taken from the options (human-gate/delegation.mjs).
    ...delegationFields(opts),
  };
}

function delegationFields(opts) {
  const delegation = delegationForNewSession(opts);
  // Work a schedule/webhook run started (a sub-agent, a task session) stays the run's.
  const run = runForNewSession(opts);
  return { ...(delegation ? { delegation } : {}), ...(run ? { run } : {}) };
}

// The persisted session record.
export function buildSessionRecord({ opts, route, presetObj, surface, prompt, messages, contextMeta, origin }) {
  const {
    providerName,
    modelName,
    toolPreset,
    effort,
    fast,
    autoEffort,
    modelParameters,
    contextPercent,
    contextTokens,
    id,
  } = route;
  return {
    id,
    codexWireSessionId: providerName === 'openai-oauth' ? mintUuidV7() : null,
    provider: providerName,
    model: modelName,
    // Resolved and pinned before the first request (wire-route.mjs). null —
    // not absent — marks a session created under the per-model wire table.
    wireRoute: null,
    messages,
    contextWindow: contextMeta.contextWindow,
    rawContextWindow: contextMeta.rawContextWindow,
    effectiveContextWindowPercent: contextMeta.effectiveContextWindowPercent,
    autoCompactTokenLimit: contextMeta.autoCompactTokenLimit,
    compactBoundaryTokens: contextMeta.compactBoundaryTokens,
    compaction: initialCompactionConfig(opts.compaction, contextMeta),
    tools: surface.tools,
    preset: toolPreset,
    // Persisted so the deferred call-through gate (deferred-call-through.mjs
    // resolveDeferredSelectMode) can resolve the session's tool mode; without
    // this every session read `undefined` and write-capable deferred tools
    // (e.g. MCP) were permanently denied auto-promotion.
    toolSpec: surface.toolSpec,
    presetName: presetObj?.name || null,
    effort,
    fast,
    // Absent means Auto effort is on; only the off state is persisted.
    ...(autoEffort === false ? { autoEffort: false } : {}),
    modelParameters,
    contextPercent,
    ...(contextTokens ? { contextTokens } : {}),
    selectedContextWindow: opts.selectedContextWindow || null,
    agent: opts.agent,
    owner: opts.owner || 'user',
    // 'agent' | 'coding' (session/agent-mode.mjs), resolved at creation.
    sessionMode: opts.sessionMode,
    bp3CoreContext: prompt.sessionMarkerCore,
    promptIdentity: prompt.promptIdentity,
    callerDisallowedTools: [...(opts.callerDisallowedTools ?? opts.disallowedTools ?? [])],
    bp3EnvironmentContext: prompt.environmentTailContext,
    // BP3 core and the volatile environment live in SEPARATE system
    // blocks (cacheTier 'tier3' vs 'env'). Legacy persisted sessions
    // without this flag keep the combined-BP3 refresh path.
    bp3EnvSplit: true,
    sessionStartMetaInjected: false,
    ...(opts.approvalMode === IMPLICIT_APPROVAL_MODE ? { approvalMode: IMPLICIT_APPROVAL_MODE } : {}),
    mcpPid: process.pid,
    mcpScopeId: opts.mcpScopeId || null,
    scopeKey: opts.scopeKey || null,
    lane: opts.lane || 'agent',
    cwd: opts.cwd,
    // Optional desktop-only origin metadata. CLI/TUI callers omit it, so
    // their persisted shape and classification behavior remain unchanged.
    desktopSession: normalizeDesktopSessionMetadata(opts.desktopSession, opts.cwd),
    workflow: toSessionWorkflowMeta(opts.workflow),
    orchestrationMode: sessionOrchestrationMode(opts),
    disallowedTools: surface.sessionDeny.map((name) => String(name)),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastHeartbeatAt: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalToolCalls: 0,
    // Refreshed on each completed ask() — surfaced by agent type=list.
    lastUsedAt: Date.now(),
    tokensCumulative: 0,
    ...origin,
  };
}
