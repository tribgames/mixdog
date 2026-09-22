// manager/session-lifecycle.mjs
// Session build/route/resume lifecycle.
// createSession (spawn), updateSessionRoute (provider/model reroute), and
// resumeSession (reload tools for a stored session) all share the same tool
// resolution + context-meta + agent-runtime resolution helpers.
import { getProvider } from '../../providers/registry.mjs';
import { saveSession, saveSessionAsync, saveSessionAsyncDeferred, loadSession, setLiveSession } from '../store.mjs';
import { _isActivelyOwnedElsewhere, _recoverTurnCheckpointDurably } from './session-owner-liveness.mjs';
import { isAgentOwner } from '../../agent-owner.mjs';
import { getHiddenAgent } from '../../internal-agents.mjs';
import { loadConfig } from '../../config.mjs';
import { buildProviderCacheOpts, cacheCapabilityForProvider } from '../../agent-runtime/cache-strategy.mjs';
import { normalizeAutoClearConfig, resolveAutoClearIdleMs } from '../../../../../session-runtime/config-helpers.mjs';
import { _buildBaseRules } from './rules-cache.mjs';
import { composeSessionSystem, seedSessionMessages } from './session-prompt-composition.mjs';
import { _prepareResumeTools, delegationDisabled, resolveSessionToolSurface } from './session-tool-surface.mjs';
import { _forgetPreparedResume, _preparedResumeMatches, _readPreparedResume } from './prepared-resume-cache.mjs';
import {
  filterModelEditToolNames,
  filterModelEditTools,
  unusedModelEditToolName,
} from '../../../../shared/edit-tool-dialect.mjs';
import { resolveSessionContextMeta } from './context-meta.mjs';
import { getAgentRuntimeSync, warnAgentRuntimeResolveFailureOnce } from './agent-runtime-singleton.mjs';
import { ensureCodexWireSessionId, mintSessionId } from './session-id.mjs';
import { providerCacheKey } from './provider-cache-key.mjs';
import { buildSessionRecord, normalizeDesktopSessionMetadata, sessionOriginFields } from './session-record.mjs';
import { refreshSessionBp3Environment } from './prompt-utils.mjs';

// Owner liveness (attach-on-resume guard) and the durable turn-checkpoint
// recovery it gates; re-exported so prior importers of this module stay
// unchanged.
export { isSessionOwnerGone, recoverSessionAfterProcessRestart } from './session-owner-liveness.mjs';
// Prepared-surface cache warmers (desktop hover prefetch, pane projection);
// re-exported so prior importers of this module stay unchanged.
export { prefetchSession, prepareSessionProjection } from './prepared-resume-cache.mjs';

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
  let modelParameters = {};
  if (opts.modelParameters && typeof opts.modelParameters === 'object') {
    modelParameters = { ...opts.modelParameters };
  } else if (presetObj?.modelParameters && typeof presetObj.modelParameters === 'object') {
    modelParameters = { ...presetObj.modelParameters };
  }
  const requestedContextPercent = Number(opts.contextPercent);
  const contextPercent =
    Number.isFinite(requestedContextPercent) && requestedContextPercent > 0
      ? Math.max(10, Math.min(100, Math.round(requestedContextPercent / 10) * 10))
      : null;
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
  return { providerName, modelName, provider, toolPreset, effort, fast, modelParameters, contextPercent, id };
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

export function createSession(opts) {
  const presetObj = opts.preset && typeof opts.preset === 'object' ? opts.preset : null;
  const resolved = resolveAgentRuntimeProfile(opts, presetObj);
  const { profile } = resolved;
  const route = resolveSessionRoute(opts, presetObj, profile);
  const { providerName, modelName, provider, toolPreset, id } = route;
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
  const providerCacheOpts = resolved.providerCacheOpts || buildSessionProviderCacheOpts(providerName, id, opts.agent);
  const surface = resolveSessionToolSurface(opts, { profile, toolPreset, modelName });
  const prompt = composeSessionSystem(opts, { profile, providerName, modelName, surface });
  const messages = seedSessionMessages(prompt, opts.files);
  logSessionSurface(surface);
  const contextMeta = resolveSessionContextMeta(provider, modelName, {
    selectedContextWindow: opts.selectedContextWindow,
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
  refreshSessionBp3Environment(session, opts.cwd);
  // In-process registry + async debounced save: same-process create → load
  // reads live memory; disk flush is for cross-process / restart durability.
  setLiveSession(session);
  saveSession(session);
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
  const allowTools = isAgentOwner(session) ? null : session?.schemaAllowedTools;
  const previousRules = _buildBaseRules({
    omitTools: [...deny, unusedModelEditToolName(previousModel)],
    allowTools,
    provider: previousProvider,
    model: previousModel,
  });
  const nextRules = _buildBaseRules({
    omitTools: [...deny, unusedModelEditToolName(session?.model)],
    allowTools,
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
  if (Object.hasOwn(route, 'effort')) session.effort = route.effort || null;
  ensureCodexWireSessionId(session);
  if (Object.hasOwn(route, 'modelParameters')) {
    session.modelParameters =
      route.modelParameters && typeof route.modelParameters === 'object' ? { ...route.modelParameters } : {};
  }
  if (Object.hasOwn(route, 'contextPercent')) {
    const requestedContextPercent = Number(route.contextPercent);
    session.contextPercent =
      Number.isFinite(requestedContextPercent) && requestedContextPercent > 0
        ? Math.max(10, Math.min(100, Math.round(requestedContextPercent / 10) * 10))
        : null;
  }
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
  session.providerCacheOpts = buildSessionProviderCacheOpts(session.provider, session.id, session.agent) || null;
  session.lastInputTokens = 0;
  session.lastOutputTokens = 0;
  session.lastCachedReadTokens = 0;
  session.lastCacheWriteTokens = 0;
  session.lastContextTokens = 0;
  session.lastContextTokensUpdatedAt = Date.now();
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
  for (const key of [
    'deferredSelectedTools',
    'deferredCallableTools',
    'deferredDefaultTools',
    'deferredDiscoveredTools',
  ]) {
    if (Array.isArray(session[key])) session[key] = filterModelEditToolNames(session[key], session.model);
  }
  _refreshSessionRuleVariantsForModel(session, previousModel, previousProvider);
  _forgetPreparedResume(id);
}

export function updateSessionRoute(id, route = {}) {
  if (!id) return null;
  const session = loadSession(id);
  if (!session || session.closed === true) return null;
  const previousProvider = session.provider || null;
  const previousModel = session.model || null;
  applyRouteFields(session, route);
  const routeChanged =
    (route.provider && route.provider !== previousProvider) || (route.model && route.model !== previousModel);
  applyRouteContextWindow(session, routeChanged, Object.hasOwn(route, 'selectedContextWindow'));
  if (routeChanged) resetSessionForRouteChange(id, session, previousModel, previousProvider);
  // Route fields feed the `# Session` prompt block (Model: … · EFFORT · FAST).
  // Rebuild it here: createSession stamped the block with the creation-time
  // route and set sessionStartMetaInjected, so the ask-time refresh guard
  // skips it and an empty-session route change would otherwise keep the old
  // model line in the system prompt (model self-identity confusion).
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
// Whether another live process is driving the session (and therefore whether
// this resume attaches as a viewer) is decided by session-owner-liveness.mjs;
// the prepared tool surface it consumes is cached in prepared-resume-cache.mjs.

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
  // newer execution Project. Task metadata always remains pathless.
  session.desktopSession =
    expectedDesktop.classification === 'project'
      ? normalizeDesktopSessionMetadata(
          {
            ...expectedDesktop,
            projectPath: session.cwd || expectedDesktop.projectPath,
          },
          session.cwd
        )
      : expectedDesktop;
  return true;
}

// ATTACH (viewer mode, zero ownership): hand back the live transcript
// under the SAME id, flagged remoteAttached. No tool refresh, no save,
// no generation claim — the session file remains exclusively the
// owner's. session-turn-api routes this surface's submits into the
// shared pending spool instead of running a local turn.
function _attachViewerSession(session, sessionId) {
  const attached = { ...session, remoteAttached: true };
  delete attached.liveTurnMessages;
  delete attached.toolApprovalHook;
  if (process.env.MIXDOG_DEBUG_SESSION_LOG) {
    try {
      process.stderr.write(`[session] attach-on-resume: ${sessionId} is live elsewhere → viewer attach\n`);
    } catch {
      /* best-effort */
    }
  }
  return attached;
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
  const missing = oldTools.filter((t) => !session.tools.find((n) => n.name === t.name));
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
  if (Object.hasOwn(options, 'mcpScopeId')) {
    session.mcpScopeId = String(options.mcpScopeId || '').trim() || null;
  }
  if (_isActivelyOwnedElsewhere(session, sessionId)) return _attachViewerSession(session, sessionId);
  _recoverTurnCheckpointDurably(session, sessionId);
  _refreshResumedTools(session, sessionId, preset);
  // The live session already owns the refreshed tools and desktop scope.
  // Defer the structured clone + worker round-trip so opening a conversation
  // is not blocked on persisting the same in-memory state back to disk.
  void saveSessionAsyncDeferred(session, { expectedGeneration: session.generation }).catch((err) => {
    try {
      process.stderr.write(`[session] resume save failed: ${err?.message || err}\n`);
    } catch {}
  });
  return session;
}
