// createCurrentSession: provider session construction with MCP wiring and
// reset handling, as a sequence of steps over the shared runtime record (rt).
import { normalizeCompactionConfig } from './config-helpers.mjs';
import { hasOwn } from './session-text.mjs';
import { deferredSurfaceModeForLead, toolSpecForMode } from './effort.mjs';
import { filterMcpToolsForSession } from './extension-scopes.mjs';
import { bootProfile } from './boot-profile.mjs';
import { STANDALONE_DATA_DIR } from './runtime-paths.mjs';
import { LEAD_DISALLOWED_TOOLS } from './tool-defs.mjs';
import { attachSessionHooks } from './session-hooks.mjs';
import { applyDeferredToolSurface } from './tool-catalog.mjs';
import { writeStatuslineRoute } from './statusline-route.mjs';
import { runAbortable, throwIfAborted } from '../runtime/shared/abort-race.mjs';

// Ownership and permission fields an agent-owned session inherits from its profile.
function agentOwnedSessionFields(sessionProfile) {
  return {
    parentSessionId: sessionProfile?.parentSessionId || null,
    ownerSessionId: sessionProfile?.ownerSessionId || sessionProfile?.parentSessionId || null,
    visibility: 'agent-only',
    agentTag: sessionProfile?.agentTag || null,
    taskType: sessionProfile?.taskType || null,
    permission: sessionProfile?.permission || undefined,
    permissionMode: sessionProfile?.permissionMode || undefined,
    schemaAllowedTools: Array.isArray(sessionProfile?.schemaAllowedTools)
      ? sessionProfile.schemaAllowedTools
      : undefined,
  };
}

function sessionStartSource(reason) {
  const reasonText = String(reason || '');
  if (/resume/i.test(reasonText)) return 'resume';
  if (/clear/i.test(reasonText)) return 'clear';
  return 'startup';
}

export function createSessionCreator(deps, routes) {
  const {
    rt,
    adoptSession,
    mgr,
    loadCoreMemoryContext,
    awaitKeychainPrewarm,
    prepareNewSessionConfig,
    ensureConfigForRouteProvider,
    reg,
    cfgMod,
    activeWorkflowContext,
    hooks,
    hookCommonPayload,
    mcpClient,
    modelStandaloneTools,
    schemaAllowedTools = null,
    featureDisallowedTools,
    applyPreSessionToolSelection,
    statusRoutes,
    agentTool,
  } = deps;
  const { resolveMissingRouteModelForFirstTurn, refreshRouteEffort, requireModelRoute } = routes;
  const elapsed = (startedAt) => (performance.now() - startedAt).toFixed(1);

  /** A still-open live session short-circuits creation. */
  function liveSession() {
    if (!rt.session?.id) return null;
    const live = mgr.getSession(rt.session.id);
    if (live && live.closed !== true && live.status !== 'closed') {
      rt.session = live;
      return live;
    }
    rt.session = null;
    return null;
  }

  /** Config, memory snapshot, route model/effort and provider readiness. */
  async function prepareRoute(signal, startedAt) {
    await runAbortable(signal, () => awaitKeychainPrewarm());
    // Persistence and reload precede EVERY config consumer, including memory,
    // workflow, tools and the disk-backed prompt builders. The live-session
    // return deliberately bypasses this boundary.
    await runAbortable(signal, () => prepareNewSessionConfig());
    // The memory snapshot uses the freshly adopted feature policy and still
    // overlaps the remaining provider/model preparation.
    const coreMemoryContextPromise = Promise.resolve(loadCoreMemoryContext());
    coreMemoryContextPromise.catch(() => {});
    ensureConfigForRouteProvider();
    await resolveMissingRouteModelForFirstTurn(signal);
    requireModelRoute();
    bootProfile('session:create:route-ready', { ms: elapsed(startedAt) });
    // Route effort waits on provider readiness while the already-started
    // memory load continues independently.
    const expectedRoute = rt.route;
    const [, coreMemoryContext] = await runAbortable(signal, () =>
      Promise.all([refreshRouteEffort(null, expectedRoute, signal), coreMemoryContextPromise])
    );
    throwIfAborted(signal);
    bootProfile('session:create:effort-ready', { ms: elapsed(startedAt) });
    const providerImpl = reg.getProvider(rt.route.provider);
    if (!providerImpl) {
      throw new Error(`Provider "${rt.route.provider}" is not configured.`);
    }
    bootProfile('session:create:provider-ready', { ms: elapsed(startedAt) });
    if (rt.closeRequested) throw new Error('runtime is closing');
    throwIfAborted(signal);
    return { coreMemoryContext, providerImpl };
  }

  function sessionOptions(coreMemoryContext) {
    const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
    // Load the active WORKFLOW.md pack once for both summary + context block.
    const { summary: workflow, context: workflowContext, orchestrationMode } = activeWorkflowContext(rt.config, dataDir);
    const sessionProfile = rt.sessionProfile && typeof rt.sessionProfile === 'object' ? rt.sessionProfile : null;
    const agentOwned = sessionProfile?.owner === 'agent' || sessionProfile?.visibility === 'agent-only';
    const sessionOpts = {
      ...(rt.reservedSessionId ? { id: rt.reservedSessionId } : {}),
      provider: rt.route.provider,
      model: rt.route.model,
      preset: rt.route.preset || undefined,
      tools: toolSpecForMode(rt.mode),
      ...(Array.isArray(schemaAllowedTools) ? { schemaAllowedTools } : {}),
      owner: agentOwned ? 'agent' : 'cli',
      agent: agentOwned ? sessionProfile?.agent || 'worker' : 'lead',
      lane: agentOwned ? 'agent' : 'cli',
      sourceType: agentOwned ? sessionProfile?.sourceType || 'agent' : 'lead',
      sourceName: agentOwned ? sessionProfile?.sourceName || sessionProfile?.agent || 'agent' : 'main',
      ...(rt.approvalMode ? { approvalMode: rt.approvalMode } : {}),
      clientHostPid: sessionProfile?.clientHostPid || process.pid,
      mcpScopeId: rt.mcpScopeId,
      disallowedTools: [
        ...(agentOwned ? [] : LEAD_DISALLOWED_TOOLS),
        ...(!agentOwned && rt.disallowDelegation ? ['agent'] : []),
        ...featureDisallowedTools(),
      ],
      cwd: rt.currentCwd,
      ...(rt.desktopSession && typeof rt.desktopSession === 'object' ? { desktopSession: rt.desktopSession } : {}),
      coreMemoryContext,
      workflow,
      workflowContext,
      orchestrationMode,
      fast: rt.route.fast === true,
      modelParameters: rt.route.modelParameters || {},
      contextPercent: rt.route.contextPercent,
      selectedContextWindow: rt.route.selectedContextWindow || null,
      compaction:
        rt.config.compaction && typeof rt.config.compaction === 'object'
          ? normalizeCompactionConfig(rt.config.compaction)
          : undefined,
      ...(agentOwned ? agentOwnedSessionFields(sessionProfile) : {}),
    };
    if (hasOwn(rt.route, 'effort') || rt.route.effectiveEffort) {
      sessionOpts.effort = rt.route.effectiveEffort || null;
    }
    return sessionOpts;
  }

  /** Every-create MCP fold (NO blocking): seed the INITIAL provider-visible
   *  surface (and native BP2 manifest) from MCP servers connected at create
   *  time. A boot connect still mid-handshake is caught on the first user
   *  turn by refreshInitialDeferredMcpSurface (session-turn-api), which
   *  re-folds the live registry before the prompt renders. */
  function seedToolSurface(reason) {
    let connectedMcpTools = [];
    try {
      connectedMcpTools = filterMcpToolsForSession(
        mcpClient.getMcpTools?.(rt.mcpScopeId) || [],
        rt.currentCwd,
        rt.config
      );
    } catch {
      connectedMcpTools = [];
    }
    applyDeferredToolSurface(
      rt.session,
      deferredSurfaceModeForLead(rt.mode),
      connectedMcpTools.length ? [...modelStandaloneTools(), ...connectedMcpTools] : modelStandaloneTools(),
      { provider: rt.route.provider }
    );
    // Session-local one-shot: mark this FRESH session eligible for the
    // first-turn deferred-surface refresh (session-turn-api). A resumed
    // session (prior transcript) is NEVER marked, so its already-baked BP2 is
    // never rebuilt or re-announced — the gate is per-session, not the
    // process-wide firstTurnCompleted.
    rt.session.deferredInitialRefreshPending = !/resume/i.test(String(reason || ''));
    applyPreSessionToolSelection();
  }

  /** Adopt the provider session and publish it to hooks, statusline and the
   *  lead pool. */
  function materializeSession(reason, coreMemoryContext) {
    adoptSession(mgr.createSession(sessionOptions(coreMemoryContext)));
    rt.reservedSessionId = null;
    attachSessionHooks(rt.session, { hooks, hookCommonPayload, getCwd: () => rt.currentCwd });
    seedToolSurface(reason);
    writeStatuslineRoute(statusRoutes, rt.session, rt.route);
    try {
      agentTool?.upsertLeadSession?.(rt.session, { status: 'idle', stage: 'idle' });
    } catch {
      /* lead pool must never break session create */
    }
    hooks.emit('session:create', {
      sessionId: rt.session.id,
      provider: rt.route.provider,
      model: rt.route.model,
      toolMode: rt.mode,
      cwd: rt.currentCwd,
    });
  }

  /** SessionStart: bridge to the standard project hook bus. Best-effort; a
   *  hook error must never break session creation. additionalContext is
   *  injected before the first user turn as a system-reminder context pair. */
  async function dispatchSessionStart(reason, signal) {
    try {
      const startDispatch = await runAbortable(signal, () =>
        hooks.dispatch(
          'SessionStart',
          hookCommonPayload({ session_id: rt.session.id, source: sessionStartSource(reason), model: rt.route.model })
        )
      );
      const startContext = Array.isArray(startDispatch?.additionalContext)
        ? startDispatch.additionalContext.join('\n\n')
        : String(startDispatch?.additionalContext || '');
      if (startContext.trim()) {
        rt.session.messages.push({
          role: 'user',
          content: `<system-reminder>\n# SessionStart Hook Context\n${startContext.trim()}\n</system-reminder>`,
        });
        rt.session.messages.push({ role: 'assistant', content: '.' });
        rt.session.updatedAt = Date.now();
      }
    } catch {
      throwIfAborted(signal);
      // best-effort: ordinary hook failure never breaks session create
    }
  }

  function prewarmWsTransport(providerImpl) {
    if (
      rt.session.provider === 'openai-oauth' &&
      Number(rt.session.totalInputTokens || 0) === 0 &&
      !rt.session.providerState &&
      typeof providerImpl.prewarmWsTransportForSession === 'function'
    ) {
      void Promise.resolve(
        providerImpl.prewarmWsTransportForSession({ sessionId: rt.session.id, session: rt.session })
      ).catch(() => {});
    }
  }

  async function buildSession(reason, signal, startedAt) {
    const { coreMemoryContext, providerImpl } = await prepareRoute(signal, startedAt);
    materializeSession(reason, coreMemoryContext);
    await dispatchSessionStart(reason, signal);
    prewarmWsTransport(providerImpl);
    throwIfAborted(signal);
    bootProfile('session:create:ready', {
      ms: elapsed(startedAt),
      reason,
      tools: Array.isArray(rt.session.tools) ? rt.session.tools.length : 0,
      catalog: Array.isArray(rt.session.deferredToolCatalog) ? rt.session.deferredToolCatalog.length : 0,
    });
    return rt.session;
  }

  return async function createCurrentSession(reason = 'demand', options = {}) {
    const signal = options?.signal || null;
    throwIfAborted(signal);
    if (rt.sessionCreatePromise) {
      return await runAbortable(signal, () => rt.sessionCreatePromise, 'Session creation aborted');
    }
    const live = liveSession();
    if (live) return live;

    const startedAt = performance.now();
    bootProfile('session:create:start', { mode: rt.mode, reason });
    // A daemon reservation is deliberate user-think-time prewarm. Start the
    // one-time agent-loop module load now so the first real prompt does not pay
    // its ~100ms dynamic-import graph immediately before provider.send.
    if (reason === 'reservation' && typeof mgr.prewarmAgentLoop === 'function') {
      void mgr.prewarmAgentLoop().catch((error) => {
        bootProfile('agent-loop:prewarm-failed', { error: error?.message || String(error) });
      });
    }
    const promise = buildSession(reason, signal, startedAt);
    rt.sessionCreatePromise = promise;
    try {
      return await promise;
    } finally {
      if (rt.sessionCreatePromise === promise) rt.sessionCreatePromise = null;
    }
  };
}
