/**
 * session-switch/resume.mjs — resuming a historical session: reopen through
 * the manager, retarget cwd, install the session's own route, restore its
 * deferred tool surface, and finish route preparation in the background.
 */
import { writeStatuslineRoute } from '../../statusline-route.mjs';
import { clean, hasOwn } from '../../session-text.mjs';
import { toolSpecForMode, deferredSurfaceModeForLead } from '../../effort.mjs';
import { isScratchConversation } from '../shared.mjs';

export function resolveResumeCwd(session, currentCwd) {
  const desktop = session?.desktopSession;
  if (desktop?.classification === 'project') {
    // `session.cwd` is the execution source of truth. Older builds updated it
    // on `cwd set` without updating desktopSession.projectPath, so preferring
    // the duplicate UI metadata reverted the Project after a restart.
    return clean(session?.cwd) || clean(desktop.projectPath) || currentCwd;
  }
  if (desktop?.classification === 'task') {
    // Desktop task sessions deliberately stay in the app-managed unclassified
    // workspace selected by the host, even if an old transcript recorded a
    // transient cwd. CLI/TUI sessions have no metadata and retain old behavior.
    return currentCwd;
  }
  return session?.cwd || currentCwd;
}

export function createSessionResume(deps, { ingestSessionIntoMemory, closeSurfaceSession }) {
  const {
    getSession,
    setSession,
    getRoute,
    setRoute,
    getConfig,
    getMode,
    getCurrentCwd,
    getMcpScopeId,
    getDesktopSession,
    mgr,
    statusRoutes,
    agentTool,
    refreshRouteEffort,
    invalidateContextStatusCache,
    invalidatePreSessionToolSurface,
    applyResolvedCwd,
    resolveRoute,
    applyDeferredToolSurface,
    getStandaloneTools,
    beginRoutePreparation,
    clearRoutePreparation,
  } = deps;

  function restoreResumedToolSurface(target, targetRoute) {
    applyDeferredToolSurface(target, deferredSurfaceModeForLead(getMode()), getStandaloneTools(), {
      provider: targetRoute.provider,
      model: targetRoute.model,
    });
  }

  // The resumed session's OWN effort wins. resolveRoute always returns an
  // effort key, so this used to reinstate the effort of whichever session
  // happened to be open before — a schedule/webhook session opened with a
  // different effort than the one it actually ran with.
  function resumedRouteFor(resumed) {
    const route = getRoute();
    const resumeEffort = resumed.effort || (hasOwn(route, 'effort') ? route.effort : undefined);
    return resolveRoute(getConfig(), {
      provider: resumed.provider,
      model: resumed.model,
      effort: resumeEffort,
      fast: resumed.fast === true,
      modelParameters: resumed.modelParameters || {},
    });
  }

  /** Hand the previous conversation off before the resumed one takes over. */
  function retirePrevious(previous, resumed) {
    const { session: prev, id: previousId, messages, liveTurnMessages } = previous;
    if (!previousId || previousId === resumed.id) return;
    statusRoutes?.clearGatewaySessionRoute?.(previousId);
    void ingestSessionIntoMemory(prev);
    closeSurfaceSession(prev, 'cli-resume', { tombstone: isScratchConversation(messages, liveTurnMessages) });
  }

  function routePreparation(resumed, resumedRoute) {
    return async () => {
      const preparedRoute = await refreshRouteEffort(null, resumedRoute);
      // Session or route changed while provider metadata was loading.
      if (!preparedRoute || getSession() !== resumed || getRoute() !== preparedRoute) return false;
      const activeSession = getSession();
      activeSession.effort = getRoute().effectiveEffort || null;
      activeSession.fast = getRoute().fast === true;
      activeSession.cwd = getCurrentCwd();
      restoreResumedToolSurface(activeSession, getRoute());
      writeStatuslineRoute(statusRoutes, activeSession, getRoute());
      return true;
    };
  }

  async function resume(id) {
    clearRoutePreparation?.();
    const prev = getSession();
    // Captured before the manager reopens anything: the scratch decision for
    // the outgoing conversation is made on what it held at this moment.
    const previous = {
      session: prev,
      id: prev?.id || null,
      messages: prev?.messages || null,
      liveTurnMessages: prev?.liveTurnMessages || null,
    };
    // A context switch can deliberately clear the desktop marker for legacy
    // sessions, so always read the live mutable context binding.
    const activeDesktopSession = getDesktopSession();
    const resumeOptions = {
      ...(activeDesktopSession && typeof activeDesktopSession === 'object'
        ? { desktopSession: activeDesktopSession }
        : {}),
      mcpScopeId: getMcpScopeId?.() || null,
    };
    const resumed = await mgr.resumeSession(id, toolSpecForMode(getMode()), resumeOptions);
    if (!resumed) return null;
    retirePrevious(previous, resumed);
    setSession(resumed);
    try {
      agentTool?.upsertLeadSession?.(resumed, { status: 'idle', stage: 'idle' });
    } catch {
      /* lead pool must never break resume */
    }
    applyResolvedCwd(resolveResumeCwd(resumed, getCurrentCwd()));
    // Commit the applied cwd before returning the resume transcript.
    resumed.cwd = getCurrentCwd();
    const resumedRoute = resumedRouteFor(resumed);
    setRoute(resumedRoute);
    // resumeSession refreshes only the bootstrap/base bundle. Reapply the
    // persisted deferred selection synchronously with current definitions
    // before this resume becomes observable; waiting for asynchronous route
    // preparation temporarily dropped loaded tools and invalidated the
    // provider-aligned context baseline.
    restoreResumedToolSurface(resumed, resumedRoute);
    const finishRoutePreparation = routePreparation(resumed, resumedRoute);
    if (typeof beginRoutePreparation === 'function') {
      beginRoutePreparation(finishRoutePreparation);
    } else {
      await finishRoutePreparation();
    }
    invalidatePreSessionToolSurface();
    invalidateContextStatusCache();
    return {
      id: resumed.id,
      messages: resumed.messages || [],
      cwd: getCurrentCwd(),
      provider: resumed.provider,
      model: resumed.model,
    };
  }

  return { resume };
}
