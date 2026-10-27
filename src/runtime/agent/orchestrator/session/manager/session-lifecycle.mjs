// manager/session-lifecycle.mjs
// Session build/route/resume lifecycle.
// createSession (spawn), updateSessionRoute (provider/model reroute), and
// resumeSession (reload tools for a stored session) all share the same tool
// resolution + context-meta + agent-runtime resolution helpers.
import { getProvider } from '../../providers/registry.mjs';
import { invalidateContextUsageSnapshot, invalidateProviderContextBaseline } from '../loop/compact-policy.mjs';
import { saveSession, saveSessionAsync, saveSessionAsyncDeferred, loadSession, setLiveSession } from '../store.mjs';
import { _liveSessions } from '../store/live-state.mjs';
import { _recoverTurnCheckpointDurably } from './turn-checkpoint-recovery.mjs';
import { isAgentOwner } from '../../agent-owner.mjs';
import { AGENT_MODE, resolveSessionMode, sessionModeOf } from '../agent-mode.mjs';
import { getHiddenAgent } from '../../internal-agents.mjs';
import { loadConfig } from '../../config.mjs';
import {
  buildProviderCacheOpts,
  cacheCapabilityForProvider,
  isLeadCacheClass,
  roleProviderCacheOpts,
} from '../../agent-runtime/cache-strategy.mjs';
import { normalizeAutoClearConfig, resolveAutoClearIdleMs } from '../../runtime-core/config-helpers.mjs';
import { _buildBaseRules, promptRulesRevision } from './rules-cache.mjs';
import { stripProviderReplayMessages } from './provider-replay.mjs';
import { composeSessionSystem, seedSessionMessages } from './session-prompt-composition.mjs';
import { agentProfileRevision, leadRosterRevision } from '../../context/role-instructions.mjs';
import {
  _prepareResumeTools,
  delegationDisabled,
  honoredSchemaAllowlist,
  resolveSessionToolSurface,
} from './session-tool-surface.mjs';
import { _forgetPreparedResume, _preparedResumeMatches, _readPreparedResume } from './prepared-resume-cache.mjs';
import {
  filterModelEditToolNames,
  filterModelEditTools,
  unusedModelEditToolName,
} from '../../../../shared/edit-tool-dialect.mjs';
import { resolveSessionContextMeta } from './context-meta.mjs';
import { normalizeContextTokens } from '../../../../shared/llm/default-context-window.mjs';
import { getAgentRuntimeSync, warnAgentRuntimeResolveFailureOnce } from './agent-runtime-singleton.mjs';
import { ensureCodexWireSessionId, mintSessionId } from './session-id.mjs';
import { providerCacheKey } from './provider-cache-key.mjs';
import { buildSessionRecord, normalizeDesktopSessionMetadata, sessionOriginFields } from './session-record.mjs';
import { normalizeWorkflowRoute } from '../../runtime-core/workflow.mjs';
import { executionFallbacks } from '../../../../shared/model-route-chain.mjs';
import { ownerRouteFallbacks } from './owner-route-fallbacks.mjs';
import { applyPendingWorkspaceReroot, refreshSessionBp3Environment } from './prompt-utils.mjs';
import { isWorktreeBound } from '../../../../shared/worktrees/contract.mjs';
import { applyAgentToolExposure } from '../loop/tool-exposure-migration.mjs';
import { prewarmSessionAutoEffort } from './ask-turn-auto-effort.mjs';
import { cancelCacheWarm } from '../cache-warm.mjs';

// Durable turn-checkpoint recovery; re-exported so prior importers of this
// module stay unchanged.
export { recoverSessionAfterProcessRestart } from './turn-checkpoint-recovery.mjs';
// Prepared-surface cache warmers (desktop hover prefetch, pane projection);
// re-exported so prior importers of this module stay unchanged.
export { prefetchSession, prepareSessionProjection } from './prepared-resume-cache.mjs';

// `session` is the record or create options; it classifies agent-mode Leads
// (bot home threads, routine runs) into the Lead cache class.
function buildSessionProviderCacheOpts(providerName, sessionId, agent = null, config = null, session = null) {
  // Keep this in sync with createSession's provider-cache policy: only
  // explicit-breakpoint providers get BP cache opts here; key-prefix
  // providers use promptCacheKey and request-time strategy instead (plus the
  // OpenAI API's Lead-class 12h prefix TTL and a one-shot role's shared
  // prompt-cache scope).
  if (cacheCapabilityForProvider(providerName) !== 'explicit-breakpoint') {
    return roleProviderCacheOpts(providerName, agent, { session });
  }
  try {
    let autoClear = null;
    if (isLeadCacheClass(agent, session)) {
      const loadedConfig = config || loadConfig({ secrets: false });
      const normalizedAutoClear = normalizeAutoClearConfig(loadedConfig?.autoClear);
      autoClear = {
        ...normalizedAutoClear,
        idleMs: resolveAutoClearIdleMs(loadedConfig, providerName),
      };
    }
    return buildProviderCacheOpts(providerName, sessionId, agent, { autoClear, session });
  } catch {
    return null;
  }
}

// Re-derive a Lead-class session's builder-made cache policy (Anthropic
// messages TTL follows the auto-clear idle window; the OpenAI API prefix TTL
// follows the cache class). Explicit caller/profile policies, sub-agents and
// other providers are left untouched.
export function refreshSessionProviderCacheOpts(session, config = null) {
  if (!session || session.providerCacheOptsOverride === true) return false;
  if (!isLeadCacheClass(session.agent, session)) return false;
  if (cacheCapabilityForProvider(session.provider) !== 'explicit-breakpoint' && session.provider !== 'openai') {
    return false;
  }
  const next = buildSessionProviderCacheOpts(session.provider, session.id, session.agent, config, session);
  if (!next) return false;
  session.providerCacheOpts = next;
  return true;
}

// An auto-clear settings change reaches every Lead session held in this
// process, not only the one on screen; persisted ones refresh on resume.
export function refreshLiveSessionsProviderCacheOpts(config = null) {
  let refreshed = 0;
  for (const session of _liveSessions.values()) {
    if (refreshSessionProviderCacheOpts(session, config)) refreshed += 1;
  }
  return refreshed;
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
// Agent Runtime profile resolution (best-effort, sync).
function resolveAgentRuntimeProfile(opts, presetObj) {
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
  return { profile, providerCacheOpts };
}

// A requested context share, snapped to 10% steps within 10..100; null when unset.
function normalizeContextPercent(value) {
  const requested = Number(value);
  return Number.isFinite(requested) && requested > 0
    ? Math.max(10, Math.min(100, Math.round(requested / 10) * 10))
    : null;
}

// Provider, model, tool preset, model parameters and the durable session id.
function resolveSessionRoute(opts, presetObj, profile) {
  const providerName = opts.provider || presetObj?.provider || profile?.preferredProviders?.[0];
  const modelName = opts.model || presetObj?.model;
  // opts.tools (caller-supplied) wins over presetObj.tools — caller
  // intent ('tools:readonly' from Pool C, etc.) must override the
  // preset's default 'full'. Previous priority let HAIKU's tools='full'
  // shadow Pool C's explicit readonly request, leaking write tools and
  // bash into a read-only agent.
  const toolPreset = opts.tools || presetObj?.tools || (typeof opts.preset === 'string' ? opts.preset : null) || 'full';
  const effort = Object.hasOwn(opts, 'effort') ? opts.effort || null : presetObj?.effort || null;
  const fast = presetObj?.fast === true || opts.fast === true;
  // Absent means on: an explicit request wins, else the preset's own flag.
  const autoEffort = opts.autoEffort !== undefined ? opts.autoEffort !== false : presetObj?.autoEffort !== false;
  let modelParameters = {};
  if (opts.modelParameters && typeof opts.modelParameters === 'object') {
    modelParameters = { ...opts.modelParameters };
  } else if (presetObj?.modelParameters && typeof presetObj.modelParameters === 'object') {
    modelParameters = { ...presetObj.modelParameters };
  }
  const contextPercent = normalizeContextPercent(opts.contextPercent);
  const contextTokens = normalizeContextTokens(opts.contextTokens) || null;
  if (!providerName) throw new Error('createSession: provider is required');
  if (!modelName) throw new Error('createSession: model is required');
  const provider = getProvider(providerName);
  if (!provider) throw new Error(`Provider "${providerName}" not found or not enabled`);
  const requestedId = String(opts.id || '').trim();
  if (requestedId && !/^[A-Za-z0-9_-]+$/.test(requestedId)) {
    throw new Error('createSession: id is invalid');
  }
  // The daemon may reserve the durable address before provider/session
  // materialization. Supplying that reservation here keeps the address
  // stable across intake -> queued turn -> provider execution.
  const id = requestedId || mintSessionId();
  return {
    providerName,
    modelName,
    provider,
    toolPreset,
    effort,
    fast,
    autoEffort,
    modelParameters,
    contextPercent,
    contextTokens,
    id,
  };
}

// Unified-shard policy — no broad role-specific schema filter. Keep
// agent schemas shared unless a hidden-role schema profile explicitly
// passes schemaAllowedTools for a small specialist; broad role
// whitelists would fragment the cache shard.
function logSessionSurface({ resolvedAgent, toolPermission, tools }) {
  if (resolvedAgent && process.env.MIXDOG_DEBUG_SESSION_LOG) {
    process.stderr.write(
      `[session] agent=${resolvedAgent} permission=${toolPermission || 'full'} toolPermission=${toolPermission || 'full'} tools=${tools.length}\n`
    );
  }
}

export function createSession(createOpts) {
  const presetObj = createOpts.preset && typeof createOpts.preset === 'object' ? createOpts.preset : null;
  const resolved = resolveAgentRuntimeProfile(createOpts, presetObj);
  const { profile } = resolved;
  const route = resolveSessionRoute(createOpts, presetObj, profile);
  const { providerName, modelName, provider, toolPreset, id } = route;
  // Agent or coding mode (agent-mode.mjs), resolved once and persisted. An
  // agent-mode Lead acts as its agent: a schedule/webhook run that names only
  // its `ownerAgentId` gets that agent's role, persona and connector policy
  // (all keyed by `session.agent`), as its home thread does.
  const sessionMode = sessionModeOf({ ...createOpts, id });
  const actingAgent = resolveSessionMode({ session: { ...createOpts, id } }).agentId;
  const opts =
    sessionMode === AGENT_MODE && !createOpts.agent && actingAgent
      ? { ...createOpts, agent: actingAgent, sessionMode }
      : { ...createOpts, sessionMode };
  // A Lead-class session (actingAgent set) takes its owner's chain while it
  // runs on the owner's primary model; an agent keeps its preset's.
  const routeFallbacks = actingAgent
    ? Object.hasOwn(opts, 'routeFallbacks')
      ? opts.routeFallbacks
      : ownerRouteFallbacks({ sessionMode, agentId: actingAgent, provider: providerName, model: modelName })
    : executionFallbacks(
        normalizeWorkflowRoute({
          provider: providerName,
          model: modelName,
          fallbacks: Object.hasOwn(opts, 'routeFallbacks') ? opts.routeFallbacks : presetObj?.fallbacks,
        })
      );
  // Provider cache strategy — agentRuntime.resolveSync() above is a
  // best-effort injection point (setAgentRuntime() has no live caller
  // today, so that branch never fires); build it directly here so every
  // session still gets a cache strategy. Lead-class sessions (the Lead, raw
  // callers, bot home threads and other agent-mode Leads) get their BP4
  // message tail TTL linked to the user's autoClear idle-sweep config and,
  // on the OpenAI API, the 12h stable-prefix TTL; sub-agents and hidden roles
  // keep the agent defaults (see cache-strategy.mjs docs).
  const providerCacheOpts =
    resolved.providerCacheOpts || buildSessionProviderCacheOpts(providerName, id, opts.agent, null, { ...opts, id });
  const surface = resolveSessionToolSurface(opts, { profile, toolPreset, modelName });
  // The agent profile the prompt is composed from, read first: an edit landing
  // during composition leaves the stamp behind, never ahead (refreshAgentProfile).
  const agentProfile = surface.ownerIsAgent
    ? ''
    : agentProfileRevision(surface.resolvedAgent, { mixy: sessionMode === AGENT_MODE });
  // A bot thread lives on across releases: the rules it was built from.
  const rulesRevision = agentProfile && sessionMode === AGENT_MODE ? promptRulesRevision() : '';
  const prompt = composeSessionSystem(opts, { profile, providerName, modelName, surface, sessionMode, sessionId: id });
  const messages = seedSessionMessages(prompt, opts.files);
  logSessionSurface(surface);
  const contextMeta = resolveSessionContextMeta(provider, modelName, {
    selectedContextWindow: opts.selectedContextWindow,
    contextPercent: route.contextPercent,
    contextTokens: route.contextTokens,
  });
  const session = buildSessionRecord({
    opts,
    route,
    presetObj,
    surface,
    prompt,
    messages,
    contextMeta,
    origin: sessionOriginFields(opts, { profile, presetObj, providerCacheOpts, surface }),
  });
  session.providerCacheOptsOverride = Boolean(resolved.providerCacheOpts);
  if (agentProfile) {
    session.agentProfileRevision = agentProfile;
    // The bot roster its prompt lists (a Lead's catalog slices).
    session.agentRosterRevision = leadRosterRevision(opts.leadWorkflowParts);
    if (rulesRevision) session.rulesRevision = rulesRevision;
  }
  if (routeFallbacks?.length) session.routeFallbacks = routeFallbacks;
  // Where an agent's chain is read from at each hop (route-fallback-chain.mjs).
  const fallbackSource = Object.hasOwn(opts, 'routeFallbackSource')
    ? opts.routeFallbackSource
    : presetObj?.fallbackSource;
  if (!actingAgent && fallbackSource && typeof fallbackSource === 'object') {
    session.routeFallbackSource = { ...fallbackSource };
  }
  // A non-native agent sends core + bridge, built from its filtered tools.
  applyAgentToolExposure(session);
  refreshSessionBp3Environment(session, opts.cwd);
  // In-process registry + async debounced save: same-process create → load
  // reads live memory; disk flush is for cross-process / restart durability.
  setLiveSession(session);
  saveSession(session);
  prewarmSessionAutoEffort(session, provider);
  return session;
}

export function contextSeedForRouteUpdate(session, routeChanged, selectedContextWindowProvided = false) {
  if (!routeChanged) return session;
  return selectedContextWindowProvided ? { selectedContextWindow: session?.selectedContextWindow || null } : {};
}

// The base-rules block (BP1) renders tool-conditional variants against the
// edit dialect the model actually receives (edit vs apply_patch) plus the
// route rules bound to the provider/model. An empty-session route change
// swaps the tool surface, so this block must re-render too — otherwise a
// session created on a GPT default route and switched to Claude keeps
// apply_patch placement guidance for a tool it can no longer call (and vice
// versa). The block is identified by EXACT previous content: the old variant
// is rebuilt from the same inputs and matched, so only the true BP1 block is
// ever replaced; custom-prompt or agent layouts without that block are left
// untouched, and a same-variant switch is a no-op.
export function _refreshSessionRuleVariantsForModel(session, previousModel, previousProvider = session?.provider) {
  const deny = [
    ...(Array.isArray(session?.disallowedTools) ? session.disallowedTools : []),
    ...(getHiddenAgent(session?.agent || null) ? ['Skill'] : []),
    ...(delegationDisabled(session, isAgentOwner(session)) ? ['agent'] : []),
  ];
  const allowTools = honoredSchemaAllowlist(session?.schemaAllowedTools, {
    ownerIsAgent: isAgentOwner(session),
    agent: session?.agent || null,
  });
  const previousRules = _buildBaseRules({
    omitTools: [...deny, unusedModelEditToolName(previousModel)],
    allowTools,
    ownerIsAgent: isAgentOwner(session),
    provider: previousProvider,
    model: previousModel,
  });
  const nextRules = _buildBaseRules({
    omitTools: [...deny, unusedModelEditToolName(session?.model)],
    allowTools,
    ownerIsAgent: isAgentOwner(session),
    provider: session?.provider,
    model: session?.model,
  });
  if (!previousRules || previousRules === nextRules) return false;
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const index = messages.findIndex(
    (message) => message?.role === 'system' && !message.cacheTier && message.content === previousRules
  );
  if (index < 0) return false;
  // Replace, never mutate: session-store delta saves treat stable message
  // references as an append-only prefix, so a fresh object forces the full
  // snapshot that keeps the persisted transcript in sync.
  messages[index] = { ...messages[index], content: nextRules };
  return true;
}

function applyRouteFields(session, route) {
  if (route.provider) session.provider = route.provider;
  if (route.model) session.model = route.model;
  if (Object.hasOwn(route, 'fast')) session.fast = route.fast === true;
  if (Object.hasOwn(route, 'autoEffort')) {
    if (route.autoEffort === false) session.autoEffort = false;
    else delete session.autoEffort;
  }
  if (Object.hasOwn(route, 'effort')) session.effort = route.effort || null;
  // A deliberate route choice restarts the chain (a fallback hop never passes this).
  if (Object.hasOwn(route, 'routeFallbacks')) {
    if (route.routeFallbacks?.length) session.routeFallbacks = route.routeFallbacks;
    else delete session.routeFallbacks;
    delete session.routeFallbackIndex;
    delete session.routeFallbackFailures;
    delete session.routeFallbackPrimary;
  }
  ensureCodexWireSessionId(session);
  if (Object.hasOwn(route, 'modelParameters')) {
    session.modelParameters =
      route.modelParameters && typeof route.modelParameters === 'object' ? { ...route.modelParameters } : {};
  }
  if (Object.hasOwn(route, 'contextPercent')) session.contextPercent = normalizeContextPercent(route.contextPercent);
  if (Object.hasOwn(route, 'contextTokens'))
    session.contextTokens = normalizeContextTokens(route.contextTokens) || null;
  if (Object.hasOwn(route, 'selectedContextWindow')) {
    session.selectedContextWindow = Number(route.selectedContextWindow) || null;
  }
}

// Provider/model windows are derived metadata. Never seed a new route with
// the old route's persisted boundary (for example GPT 272k leaking into
// Cursor Gemini after an empty-session model switch).
function applyRouteContextWindow(session, routeChanged, selectedContextWindowProvided) {
  const provider = session.provider ? getProvider(session.provider) : null;
  if (!provider || !session.model) {
    delete session.contextWindow;
    delete session.rawContextWindow;
    delete session.effectiveContextWindowPercent;
    delete session.autoCompactTokenLimit;
    delete session.compactBoundaryTokens;
    return;
  }
  const contextSeed = contextSeedForRouteUpdate(session, routeChanged, selectedContextWindowProvided);
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
}

// A new provider/model starts a fresh cache chain, usage baseline and tool
// surface: the previous route's readings and prepared tools no longer apply.
function resetSessionForRouteChange(id, session, previousModel, previousProvider) {
  session.promptCacheKey = providerCacheKey(session.provider);
  session.providerCacheOpts =
    buildSessionProviderCacheOpts(session.provider, session.id, session.agent, null, session) || null;
  session.providerCacheOptsOverride = false;
  session.lastInputTokens = 0;
  session.lastOutputTokens = 0;
  session.lastCachedReadTokens = 0;
  session.lastCacheWriteTokens = 0;
  session.lastContextTokens = 0;
  session.lastContextTokensUpdatedAt = Date.now();
  session.lastContextTokensStaleAfterCompact = false;
  session.providerState = undefined;
  // The previous route's prefix snapshot measured another prompt (model line,
  // stripped replay); the new chain baselines on its first send.
  delete session._providerPrefixGuardState;
  // The new route resolves its own wire before its first request.
  session.wireRoute = null;
  // A warm chain replays the previous route's request: stop it. Its recorded
  // warm use names that route, so it never counts as fresh cache for the new
  // one (compact-policy.mjs shouldCompactForExpiredAgentCache).
  cancelCacheWarm(id);
  const prepared = _prepareResumeTools(session, session.preset || 'full');
  session.tools = prepared.tools;
  session.toolSpec = prepared.toolSpec;
  if (Array.isArray(session.deferredToolCatalog)) {
    session.deferredToolCatalog = filterModelEditTools(session.deferredToolCatalog, session.model);
  }
  if (Array.isArray(session.deferredLateToolCatalog)) {
    session.deferredLateToolCatalog = filterModelEditTools(session.deferredLateToolCatalog, session.model);
  }
  for (const key of [
    'deferredSelectedTools',
    'deferredCallableTools',
    'deferredDefaultTools',
    'deferredDiscoveredTools',
  ]) {
    if (Array.isArray(session[key])) session[key] = filterModelEditToolNames(session[key], session.model);
  }
  applyAgentToolExposure(session, { existing: true });
  _refreshSessionRuleVariantsForModel(session, previousModel, previousProvider);
  _forgetPreparedResume(id);
}

// Provider-native replay (reasoning items, thinking blocks, signatures)
// belongs to the provider that produced it (see provider-replay.mjs).
function stripProviderReplay(session) {
  if (!Array.isArray(session.messages)) return;
  session.messages = stripProviderReplayMessages(session.messages);
}

// `options.crossProvider` is the explicit in-place continuation of an
// established session on another model: the previous provider's replay state
// and context readings are dropped so the next turn re-measures (and
// auto-compacts) against the new model's window.
export function updateSessionRoute(id, route = {}, options = {}) {
  if (!id) return null;
  // options.session: the live object of a running turn, changed in place; the id's
  // stored copy (a disk reload after another process took the generation) is not.
  const session = options.session?.id === id ? options.session : loadSession(id);
  if (!session || session.closed === true) return null;
  const previousProvider = session.provider || null;
  const previousModel = session.model || null;
  applyRouteFields(session, route);
  const routeChanged =
    (route.provider && route.provider !== previousProvider) || (route.model && route.model !== previousModel);
  applyRouteContextWindow(session, routeChanged, Object.hasOwn(route, 'selectedContextWindow'));
  if (routeChanged) resetSessionForRouteChange(id, session, previousModel, previousProvider);
  if (routeChanged && options.crossProvider === true) {
    stripProviderReplay(session);
    invalidateContextUsageSnapshot(session);
    invalidateProviderContextBaseline(session);
  }
  // The model feeds the `# Session` prompt block (`Model: …`).
  // Rebuild it here: createSession stamped the block with the creation-time
  // route and set sessionStartMetaInjected, so the ask-time refresh guard
  // skips it and an empty-session route change would otherwise keep the old
  // model line in the system prompt (model self-identity confusion).
  // A new route starts a cold cache: a staged working-folder change re-roots
  // the prompt now instead of riding a notice.
  if (routeChanged) applyPendingWorkspaceReroot(session);
  refreshSessionBp3Environment(session, session.cwd);
  session.updatedAt = Date.now();
  setLiveSession(session);
  void saveSessionAsync(session, { expectedGeneration: session.generation }).catch((err) => {
    try {
      process.stderr.write(`[session] route update save failed: ${err?.message || err}\n`);
    } catch {}
  });
  return session;
}

// --- resume (reload tools for a stored session) ---
// Interrupted-turn recovery lives in turn-checkpoint-recovery.mjs; the
// prepared tool surface it consumes is cached in prepared-resume-cache.mjs.

// Desktop callers pass their selected durable classification as a
// capability check. Refuse a stale/tampered cross-class resume before any
// tool refresh or save. CLI/TUI callers omit this option and retain the
// historical unrestricted resume behavior. Answers false when refused.
function _applyDesktopResumeScope(session, options) {
  if (!Object.hasOwn(options, 'desktopSession')) return true;
  const expectedDesktop = normalizeDesktopSessionMetadata(options.desktopSession, session.cwd);
  const storedDesktop = normalizeDesktopSessionMetadata(session.desktopSession, session.cwd);
  if (!expectedDesktop || !storedDesktop || expectedDesktop.classification !== storedDesktop.classification) {
    return false;
  }
  // The host's summary may predate a cwd change. It supplies the
  // classification check, not permission to overwrite the session's
  // newer execution Project. Task metadata always remains pathless. A Lead
  // in its worktree executes outside the Project: its registered Project
  // stays the workspace record's projectPath, never the worktree cwd.
  const workspace = session.workspace;
  const executionProject =
    isWorktreeBound(workspace) && typeof workspace.projectPath === 'string' ? workspace.projectPath : session.cwd;
  session.desktopSession =
    expectedDesktop.classification === 'project'
      ? normalizeDesktopSessionMetadata(
          {
            ...expectedDesktop,
            projectPath: executionProject || expectedDesktop.projectPath,
          },
          session.cwd
        )
      : expectedDesktop;
  return true;
}

// Refreshes the session's tool surface from the prepared resume when it still
// matches, warning about tools the preset no longer offers.
function _refreshResumedTools(session, sessionId, preset) {
  const oldTools = session.tools || [];
  const cached = _readPreparedResume(sessionId);
  _forgetPreparedResume(sessionId);
  const prepared = _preparedResumeMatches(cached, session, preset) ? cached : _prepareResumeTools(session, preset);
  // Keep the persisted tool mode in sync on resume (see createSession note).
  session.toolSpec = prepared.toolSpec;
  session.tools = prepared.tools;
  applyAgentToolExposure(session, { existing: true });
  // A bridge surface keeps the rest of its tools in the catalog.
  const available = new Set(
    [...session.tools, ...(session.deferredToolCatalog || [])].map((tool) => tool?.name).filter(Boolean)
  );
  const missing = oldTools.filter((t) => !available.has(t.name));
  if (missing.length) {
    process.stderr.write(
      `[session] Warning: ${missing.length} tools no longer available: ${missing.map((t) => t.name).join(', ')}\n`
    );
  }
}

export async function resumeSession(sessionId, preset, options = {}) {
  const session = loadSession(sessionId);
  if (!session) return null;
  // Resuming a closed session is a resurrection attempt — refuse. The guarded
  // save below would also block the write, but failing fast here is cleaner
  // than silently dropping the tool-refresh side effects.
  if (session.closed === true) return null;
  ensureCodexWireSessionId(session);
  if (!_applyDesktopResumeScope(session, options)) return null;
  if (!session.owner) session.owner = 'user';
  // Records from before the mode existed get it resolved and stamped.
  session.sessionMode = sessionModeOf(session);
  if (Object.hasOwn(options, 'mcpScopeId')) {
    session.mcpScopeId = String(options.mcpScopeId || '').trim() || null;
  }
  _recoverTurnCheckpointDurably(session, sessionId);
  _refreshResumedTools(session, sessionId, preset);
  refreshSessionProviderCacheOpts(session);
  // The live session already owns the refreshed tools and desktop scope.
  // Defer the structured clone + worker round-trip so opening a conversation
  // is not blocked on persisting the same in-memory state back to disk.
  void saveSessionAsyncDeferred(session, { expectedGeneration: session.generation }).catch((err) => {
    try {
      process.stderr.write(`[session] resume save failed: ${err?.message || err}\n`);
    } catch {}
  });
  prewarmSessionAutoEffort(session, session.provider ? getProvider(session.provider) : null);
  return session;
}
