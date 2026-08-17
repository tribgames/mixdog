// Session lifecycle, extracted from runtime-core.mjs: first-turn route
// resolution, route-effort refresh, and createCurrentSession (provider
// session construction with MCP wiring and reset handling). Shared mutable
// runtime state flows through the rt bag.
import { ensureProviderEnabled, modelMetaLooksResolved, normalizeCompactionConfig } from './config-helpers.mjs';
import { clean, hasOwn } from './session-text.mjs';
import { coerceEffortFor, deferredSurfaceModeForLead, effortItemsFor, toolSpecForMode } from './effort.mjs';
import { fastCapableFor } from './model-capabilities.mjs';
import { bootProfile } from './boot-profile.mjs';
import { STANDALONE_DATA_DIR } from './runtime-paths.mjs';
import { LEAD_DISALLOWED_TOOLS } from './tool-defs.mjs';
import { attachSessionHooks } from './session-hooks.mjs';
import { applyDeferredToolSurface } from './tool-catalog.mjs';
import { prepareAgentSession } from '../runtime/agent/orchestrator/agent-runtime/session-builder.mjs';
import { writeStatuslineRoute } from './statusline-route.mjs';
import { createWarmupSchedulers } from './warmup-schedulers.mjs';
import { warmCatalogsInBackground } from '../runtime/agent/orchestrator/providers/model-catalog.mjs';
import { envFlag } from './env.mjs';
import { createPrewarmSchedulers } from './prewarm.mjs';
import { hasActiveAutomation } from '../standalone/channel-admin.mjs';
import { createRemoteTranscript } from './remote-transcript.mjs';
import { runAbortable, throwIfAborted } from '../runtime/shared/abort-race.mjs';

export function resolveRouteEffortState(targetRoute = {}, modelMeta = null) {
  const requested = hasOwn(targetRoute, 'effort')
    ? targetRoute.effort
    : (targetRoute.preset?.effort || null);
  const metadataResolved = modelMetaLooksResolved(modelMeta);
  // A cold runtime initially has only `{ id, provider }`. Treating that
  // placeholder as authoritative erased a persisted effort and disabled a
  // persisted Fast route before the provider catalog finished warming.
  // Preserve the already-validated route until real capability metadata is
  // available; the provider still validates the exact variant before send.
  const effectiveEffort = metadataResolved
    ? coerceEffortFor(targetRoute.provider, modelMeta, requested)
    : (requested || null);
  const fastCapable = metadataResolved
    ? fastCapableFor(
      targetRoute.provider,
      modelMeta,
      effectiveEffort,
      targetRoute.modelParameters,
    )
    : targetRoute.fast === true;
  return { effectiveEffort, fastCapable, metadataResolved };
}

export function resolveRouteContextState(targetRoute = {}, modelMeta = null) {
  const defaultWindow = Math.max(0, Number(modelMeta?.contextWindow) || 0);
  const maxWindow = Math.max(defaultWindow, Number(modelMeta?.maxContextWindow) || 0);
  if (!maxWindow) {
    return { contextPercent: undefined, contextDefaultPercent: undefined, selectedContextWindow: undefined };
  }
  const contextDefaultPercent = Math.max(
    10,
    Math.min(100, Math.round((defaultWindow / maxWindow) * 10) * 10),
  );
  const requested = Number(targetRoute?.contextPercent);
  const contextPercent = Number.isFinite(requested) && requested > 0
    ? Math.max(10, Math.min(100, Math.round(requested / 10) * 10))
    : contextDefaultPercent;
  const selectedContextWindow = contextPercent === contextDefaultPercent
    ? defaultWindow
    : Math.max(1, Math.floor(maxWindow * contextPercent / 100));
  return { contextPercent, contextDefaultPercent, selectedContextWindow };
}

export function createSessionLifecycle({
  rt,
  collectProviderModels,
  ensureProvidersReady,
  lookupModelMeta,
  mgr,
  loadCoreMemoryContext,
  awaitKeychainPrewarm,
  ensureConfigForRouteProvider,
  reg,
  cfgMod,
  activeWorkflowContext,
  hooks,
  hookCommonPayload,
  mcpClient,
  modelStandaloneTools,
  featureDisallowedTools,
  applyPreSessionToolSelection,
  statusRoutes,
  warmupTimers,
  providerModelCaches,
  reloadFullConfig,
  refreshStatuslineUsageSnapshot,
  warmProviderModelCache,
  cachedProviderSetup,
  providerWarmupDelayMs,
  providerSetupWarmupDelayMs,
  providerModelWarmupDelayMs,
  modelCatalogWarmupDelayMs,
  statuslineUsageWarmupDelayMs,
  statuslineUsageRefreshDelayMs,
  backgroundBusyRetryMs,
  providerWarmupEnabled,
  modelPrefetchEnabled,
  modelCatalogWarmupEnabled,
  prewarmTimers,
  channelsEnabled,
  getCodeGraphModule,
  channels,
  codeGraphPrewarmDelayMs,
  channelStartDelayMs,
  codeGraphPrewarmEnabled,
  prewarmState,
  agentTool,
}) {
  async function resolveMissingRouteModelForFirstTurn(signal = null) {
    if (routeHasModel()) return rt.route;
    const models = await runAbortable(signal, () => collectProviderModels());
    throwIfAborted(signal);
    const picked = models[0] || null;
    if (!picked) {
      throw new Error('No provider models available. Open /providers to sign in, then /model to choose a model.');
    }
    rt.route = {
      ...rt.route,
      provider: picked.provider,
      model: picked.id,
      preset: null,
    };
    return rt.route;
  }

  async function refreshRouteEffort(modelMetaOverride = null, expectedRoute = null, signal = null) {
    const targetRoute = expectedRoute || rt.route;
    await runAbortable(signal, () => ensureProvidersReady(ensureProviderEnabled(rt.config, targetRoute.provider)));
    const modelMeta = modelMetaOverride || await runAbortable(
      signal,
      () => lookupModelMeta(targetRoute.provider, targetRoute.model),
    );
    throwIfAborted(signal);
    // A rapid second resume/model change can replace the route while provider
    // metadata is loading. Never let the older completion overwrite it.
    if (expectedRoute && rt.route !== expectedRoute) return null;
    const { effectiveEffort, fastCapable } = resolveRouteEffortState(targetRoute, modelMeta);
    const contextState = resolveRouteContextState(targetRoute, modelMeta);
    const contextValue = clean(targetRoute.modelParameters?.context);
    const contextOption = (modelMeta?.modelParameterOptions || [])
      .find((option) => option?.id === 'context')?.options
      ?.find((option) => clean(option?.value) === contextValue);
    // Carry the catalog display name onto the route so the statusline shows a
    // human label (e.g. "Claude Fable 5") for preset-less direct models instead
    // of the raw id. `name` is only trusted when it differs from the raw model
    // id (some providers echo the id as `name`), so it can't clobber a better
    // already-resolved label. Falls back to existing route.modelDisplay, then unset.
    const metaName = clean(modelMeta?.name);
    const modelDisplay = clean(modelMeta?.display) || clean(modelMeta?.displayName)
      || (metaName && metaName !== clean(targetRoute.model) ? metaName : '')
      || clean(targetRoute.modelDisplay);
    rt.route = {
      ...targetRoute,
      fast: fastCapable ? targetRoute.fast === true : false,
      fastCapable,
      effectiveEffort,
      effortOptions: effortItemsFor(rt.route.provider, modelMeta, effectiveEffort),
      contextPercent: contextState.contextPercent,
      contextDefaultPercent: contextState.contextDefaultPercent,
      ...(Number(contextState.selectedContextWindow) > 0
        ? { selectedContextWindow: Number(contextState.selectedContextWindow) }
        : Number(contextOption?.contextWindow) > 0
          ? { selectedContextWindow: Number(contextOption.contextWindow) }
          : {}),
      ...(modelDisplay ? { modelDisplay } : {}),
    };
    return rt.route;
  }

  function routeHasModel() {
    return !!clean(rt.route?.model);
  }

  function requireModelRoute() {
    if (routeHasModel()) return;
    throw new Error('No model configured. Open /providers to sign in, then /model to choose a model.');
  }

  async function recreateCurrentSessionIfReady() {
    if (!routeHasModel()) {
      rt.session = null;
      return null;
    }
    return await createCurrentSession();
  }

  async function createCurrentSession(reason = 'demand', options = {}) {
    const signal = options?.signal || null;
    throwIfAborted(signal);
    if (rt.sessionCreatePromise) {
      return await runAbortable(signal, () => rt.sessionCreatePromise, 'Session creation aborted');
    }
    if (rt.session?.id && !rt.sessionNeedsCwdRefresh) {
      const liveSession = mgr.getSession(rt.session.id);
      if (liveSession && liveSession.closed !== true && liveSession.status !== 'closed') {
        rt.session = liveSession;
        return rt.session;
      }
      rt.session = null;
    }

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
    const promise = (async () => {
      // Demand-only: this starts only after the user submits (unless an
      // explicitly enabled prewarm caller asks for a session). Core-memory
      // startup does not depend on keychain/provider readiness, so overlap the
      // two cold paths instead of paying their bounded waits serially.
      if (rt.agentSessionSpec) {
        // Agent shard spread: this runtime hosts a spawned worker session.
        // Build it through the shared agent session builder so permission,
        // role rules, and preset telemetry match an in-process spawn; skip
        // every Lead-only fold (workflow pack, core-memory block, Lead tool
        // surface, statusline route, session hooks).
        await runAbortable(signal, () => awaitKeychainPrewarm());
        ensureConfigForRouteProvider();
        await resolveMissingRouteModelForFirstTurn(signal);
        requireModelRoute();
        const expectedAgentRoute = rt.route;
        await runAbortable(signal, () => refreshRouteEffort(null, expectedAgentRoute, signal));
        throwIfAborted(signal);
        if (!reg.getProvider(rt.route.provider)) {
          throw new Error(`Provider "${rt.route.provider}" is not configured.`);
        }
        if (rt.closeRequested) throw new Error('runtime is closing');
        const { session } = prepareAgentSession({
          ...rt.agentSessionSpec,
          mcpScopeId: rt.mcpScopeId,
          ...(rt.reservedSessionId ? { sessionId: rt.reservedSessionId } : {}),
        });
        rt.session = session;
        rt.reservedSessionId = null;
        rt.sessionNeedsCwdRefresh = false;
        bootProfile('session:create:agent-ready', {
          ms: (performance.now() - startedAt).toFixed(1),
          agent: rt.agentSessionSpec.agent || null,
        });
        return rt.session;
      }
      const coreMemoryContextPromise = Promise.resolve(loadCoreMemoryContext());
      coreMemoryContextPromise.catch(() => {});
      await runAbortable(signal, () => awaitKeychainPrewarm());
      ensureConfigForRouteProvider();
      await resolveMissingRouteModelForFirstTurn(signal);
      requireModelRoute();
      bootProfile('session:create:route-ready', { ms: (performance.now() - startedAt).toFixed(1) });
      // Route effort waits on provider readiness while the already-started
      // memory load continues independently.
      const expectedRoute = rt.route;
      const [, coreMemoryContext] = await runAbortable(signal, () => Promise.all([
        refreshRouteEffort(null, expectedRoute, signal),
        coreMemoryContextPromise,
      ]));
      throwIfAborted(signal);
      bootProfile('session:create:effort-ready', { ms: (performance.now() - startedAt).toFixed(1) });
      const providerImpl = reg.getProvider(rt.route.provider);
      if (!providerImpl) {
        throw new Error(`Provider "${rt.route.provider}" is not configured.`);
      }
      bootProfile('session:create:provider-ready', { ms: (performance.now() - startedAt).toFixed(1) });
      if (rt.closeRequested) throw new Error('runtime is closing');
      throwIfAborted(signal);
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      // Load the active WORKFLOW.md pack once for both summary + context block.
      const { summary: workflow, context: workflowContext } = activeWorkflowContext(rt.config, dataDir);
      const sessionOpts = {
        ...(rt.reservedSessionId ? { id: rt.reservedSessionId } : {}),
        provider: rt.route.provider,
        model: rt.route.model,
        preset: rt.route.preset || undefined,
        tools: toolSpecForMode(rt.mode),
        owner: 'cli',
        agent: 'lead',
        lane: 'cli',
        sourceType: 'lead',
        sourceName: 'main',
        ...(rt.approvalMode ? { approvalMode: rt.approvalMode } : {}),
        clientHostPid: process.pid,
        mcpScopeId: rt.mcpScopeId,
        disallowedTools: [
          ...LEAD_DISALLOWED_TOOLS,
          ...(rt.disallowDelegation ? ['agent'] : []),
          ...featureDisallowedTools(),
        ],
        cwd: rt.currentCwd,
        ...(rt.desktopSession && typeof rt.desktopSession === 'object' ? { desktopSession: rt.desktopSession } : {}),
        coreMemoryContext,
        workflow,
        workflowContext,
        fast: rt.route.fast === true,
        modelParameters: rt.route.modelParameters || {},
        contextPercent: rt.route.contextPercent,
        selectedContextWindow: rt.route.selectedContextWindow || null,
        compaction: rt.config.compaction && typeof rt.config.compaction === 'object'
          ? normalizeCompactionConfig(rt.config.compaction)
          : undefined,
      };
      if (hasOwn(rt.route, 'effort') || rt.route.effectiveEffort) {
        sessionOpts.effort = rt.route.effectiveEffort || null;
      }
      rt.session = mgr.createSession(sessionOpts);
      rt.reservedSessionId = null;
      rt.sessionNeedsCwdRefresh = false;
      attachSessionHooks(rt.session, { hooks, hookCommonPayload, getCwd: () => rt.currentCwd });
      // Every-create MCP fold (NO blocking): seed the INITIAL provider-visible
      // surface (and native BP2 manifest) from MCP servers connected at create
      // time. There is no await — a boot connect still mid-handshake is caught on
      // the first user turn by refreshInitialDeferredMcpSurface (session-turn-api),
      // which re-folds the live registry into the first-turn surface before the
      // prompt renders. This fold keeps recreate paths (cwd change with MCP
      // already connected) seeding their manifest instead of re-announcing late.
      let connectedMcpTools = [];
      try { connectedMcpTools = mcpClient.getMcpTools?.(rt.mcpScopeId) || []; }
      catch { connectedMcpTools = []; }
      applyDeferredToolSurface(
        rt.session,
        deferredSurfaceModeForLead(rt.mode),
        connectedMcpTools.length ? [...modelStandaloneTools(), ...connectedMcpTools] : modelStandaloneTools(),
        { provider: rt.route.provider },
      );
      // Session-local one-shot: mark this FRESH session eligible for the
      // first-turn deferred-surface refresh (session-turn-api). A resumed
      // session (prior transcript) is NEVER marked, so its already-baked BP2 is
      // never rebuilt or re-announced — the gate is per-session, not the
      // process-wide firstTurnCompleted.
      rt.session.deferredInitialRefreshPending = !/resume/i.test(String(reason || ''));
      applyPreSessionToolSelection();
      writeStatuslineRoute(statusRoutes, rt.session, rt.route);
      try {
        agentTool?.upsertLeadSession?.(rt.session, { status: 'idle', stage: 'idle' });
      } catch { /* lead pool must never break session create */ }
      hooks.emit('session:create', { sessionId: rt.session.id, provider: rt.route.provider, model: rt.route.model, toolMode: rt.mode, cwd: rt.currentCwd });
      // SessionStart: bridge to the standard project hook bus. Best-effort;
      // a hook error must never break session creation. additionalContext is
      // injected before the first user turn as a system-reminder context pair.
      try {
        const startSource = /resume/i.test(String(reason || ''))
          ? 'resume'
          : (/clear/i.test(String(reason || '')) ? 'clear' : 'startup');
        const startDispatch = await runAbortable(
          signal,
          () => hooks.dispatch('SessionStart', hookCommonPayload({ session_id: rt.session.id, source: startSource, model: rt.route.model })),
        );
        const startContext = Array.isArray(startDispatch?.additionalContext)
          ? startDispatch.additionalContext.join('\n\n')
          : String(startDispatch?.additionalContext || '');
        if (startContext.trim()) {
          rt.session.messages.push({ role: 'user', content: `<system-reminder>\n# SessionStart Hook Context\n${startContext.trim()}\n</system-reminder>` });
          rt.session.messages.push({ role: 'assistant', content: '.' });
          rt.session.updatedAt = Date.now();
        }
      } catch {
        throwIfAborted(signal);
        // best-effort: ordinary hook failure never breaks session create
      }
      throwIfAborted(signal);
      bootProfile('session:create:ready', {
        ms: (performance.now() - startedAt).toFixed(1),
        reason,
        tools: Array.isArray(rt.session.tools) ? rt.session.tools.length : 0,
        catalog: Array.isArray(rt.session.deferredToolCatalog) ? rt.session.deferredToolCatalog.length : 0,
      });
      // A rebind push may have been deferred (e.g. 'acquired' landed before this
      // session existed). The writer is now bindable — flush it exactly once.
      remoteTranscript.flushPendingTranscriptRebind();
      return rt.session;
    })();

    rt.sessionCreatePromise = promise;
    try {
      return await promise;
    } finally {
      if (rt.sessionCreatePromise === promise) rt.sessionCreatePromise = null;
    }
  }

  const {
    scheduleProviderWarmup,
    scheduleProviderSetupWarmup,
    scheduleProviderModelWarmup,
    scheduleModelCatalogWarmup,
    scheduleStatuslineUsageWarmup,
    scheduleStatuslineUsageRefresh,
  } = createWarmupSchedulers({
    timers: warmupTimers,
    bootProfile,
    getRoute: () => rt.route,
    getConfig: () => rt.config,
    isCloseRequested: () => rt.closeRequested,
    getActiveTurnCount: () => rt.activeTurnCount,
    getSessionCreatePromise: () => rt.sessionCreatePromise,
    getProviderModelsCache: () => providerModelCaches.providerModelsCache,
    getProviderModelsPromise: () => providerModelCaches.providerModelsPromise,
    reloadFullConfig,
    ensureConfigForRouteProvider,
    awaitKeychainPrewarm,
    ensureProvidersReady,
    ensureProviderEnabled,
    refreshStatuslineUsageSnapshot,
    warmProviderModelCache,
    cachedProviderSetup,
    warmCatalogsInBackground,
    isFirstTurnCompleted: () => rt.firstTurnCompleted,
    isCatalogRefreshPending: () => rt.startupProviderCatalogRefreshPending,
    envFlag,
    delays: {
      providerWarmupDelayMs,
      providerSetupWarmupDelayMs,
      providerModelWarmupDelayMs,
      modelCatalogWarmupDelayMs,
      statuslineUsageWarmupDelayMs,
      statuslineUsageRefreshDelayMs,
      backgroundBusyRetryMs,
    },
    flags: {
      providerWarmupEnabled,
      modelPrefetchEnabled,
      modelCatalogWarmupEnabled,
    },
  });
  rt.scheduleProviderModelWarmupRef = scheduleProviderModelWarmup;
  rt.scheduleProviderSetupWarmupRef = scheduleProviderSetupWarmup;

  const {
    scheduleCodeGraphPrewarm,
    scheduleToolRuntimeWarmup,
    scheduleSearchRuntimeWarmup,
    invokeChannelStart,
    scheduleChannelStart,
  } = createPrewarmSchedulers({
    timers: prewarmTimers,
    bootProfile,
    getCurrentCwd: () => rt.currentCwd,
    isCloseRequested: () => rt.closeRequested,
    getActiveTurnCount: () => rt.activeTurnCount,
    getSessionCreatePromise: () => rt.sessionCreatePromise,
    getSession: () => rt.session,
    isRemoteEnabled: () => rt.remoteEnabled,
    channelsEnabled,
    hasActiveAutomation,
    getCodeGraphModule,
    createCurrentSession,
    channels,
    envFlag,
    delays: {
      codeGraphPrewarmDelayMs,
      channelStartDelayMs,
      backgroundBusyRetryMs,
    },
    flags: {
      codeGraphPrewarmEnabled,
    },
    state: prewarmState,
  });

  // Remote transcript binding + worker rebind pushes live in
  // remote-transcript.mjs; the facade injects the mutable session/cwd/remote
  // state it needs.
  const remoteTranscript = createRemoteTranscript({
    getSession: () => rt.session,
    getCwd: () => rt.currentCwd,
    isRemoteEnabled: () => rt.remoteEnabled,
    getRemoteSessionId: () => rt.remoteSessionId,
    setRemoteSessionId: (next) => { rt.remoteSessionId = next; },
    isCloseRequested: () => rt.closeRequested,
    channelsEnabled,
    channels,
    bootProfile,
  });

  return {
    resolveMissingRouteModelForFirstTurn,
    scheduleProviderWarmup,
    scheduleProviderSetupWarmup,
    scheduleProviderModelWarmup,
    scheduleModelCatalogWarmup,
    scheduleStatuslineUsageWarmup,
    scheduleStatuslineUsageRefresh,
    scheduleCodeGraphPrewarm,
    scheduleToolRuntimeWarmup,
    scheduleSearchRuntimeWarmup,
    invokeChannelStart,
    scheduleChannelStart,
    refreshRouteEffort,
    routeHasModel,
    requireModelRoute,
    recreateCurrentSessionIfReady,
    createCurrentSession,
    remoteTranscript,
  };
}
