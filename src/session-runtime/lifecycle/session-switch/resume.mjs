/**
 * session-switch/resume.mjs — resuming a historical session: reopen through
 * the manager, retarget cwd, install the session's own route, restore its
 * deferred tool surface, and finish route preparation in the background.
 */
import { writeStatuslineRoute } from '../../statusline-route.mjs';
import { clean, hasOwn } from '../../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import {
  toolSpecForMode,
  deferredSurfaceModeForLead,
} from '../../../runtime/agent/orchestrator/runtime-core/effort.mjs';
import { closeOutgoingSession, isScratchConversation } from '../shared.mjs';
import { compactionArchiveRange } from '../../../runtime/agent/orchestrator/session/compaction-archive.mjs';
import { stampCompactionMessageIds } from '../../../runtime/agent/orchestrator/session/compaction-archive-capture.mjs';
import { boundWorkspaceCwd, restoreWorkspaceAfterResume } from '../../workspace/workspace-state.mjs';
import { toolExposureMigrationNeeded } from '../../../runtime/agent/orchestrator/runtime-core/tool-exposure.mjs';
import { markToolSurfaceMigrated } from '../../../runtime/agent/orchestrator/session/loop/tool-exposure-migration.mjs';

export function resolveResumeCwd(session, currentCwd) {
  // A worktree-bound Lead resumes in its worktree whatever its desktop class;
  // a vanished worktree resumes in the Project folder in `recovery`, where
  // turns are refused (restoreWorkspaceAfterResume) rather than silently run.
  const bound = boundWorkspaceCwd(session);
  if (bound) return bound.cwd;
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
    // A surface persisted with another tool exposure (e.g. a pre-bridge
    // fixed canonical surface) migrates here; legacy selections never widen it.
    const migrating = toolExposureMigrationNeeded(target, targetRoute.provider);
    applyDeferredToolSurface(target, deferredSurfaceModeForLead(getMode()), getStandaloneTools(), {
      provider: targetRoute.provider,
      model: targetRoute.model,
    });
    if (migrating) markToolSurfaceMigrated(target);
  }

  // The resumed session's OWN effort wins. resolveRoute always returns an
  // effort key, so the route's effort applies only when the session has none —
  // otherwise a schedule/webhook session would reopen with the effort of
  // whichever session happened to be open before.
  function resumedRouteFor(resumed) {
    const route = getRoute();
    const resumeEffort = resumed.effort || (hasOwn(route, 'effort') ? route.effort : undefined);
    return resolveRoute(getConfig(), {
      provider: resumed.provider,
      model: resumed.model,
      effort: resumeEffort,
      fast: resumed.fast === true,
      autoEffort: resumed.autoEffort !== false,
      modelParameters: resumed.modelParameters || {},
    });
  }

  /** Hand the previous conversation off before the resumed one takes over. */
  async function retirePrevious(previous, resumed) {
    const { session: prev, id: previousId, messages, liveTurnMessages } = previous;
    if (!previousId || previousId === resumed.id) return;
    // A failed close throws here and the previous session stays current.
    await closeOutgoingSession(closeSurfaceSession, prev, 'cli-resume', {
      tombstone: isScratchConversation(messages, liveTurnMessages),
    });
    statusRoutes?.clearGatewaySessionRoute?.(previousId);
    void ingestSessionIntoMemory(prev);
  }

  function routePreparation(resumed, resumedRoute) {
    return async () => {
      const preparedRoute = await refreshRouteEffort(null, resumedRoute);
      // Session or route changed while provider metadata was loading.
      if (!preparedRoute || getSession() !== resumed || getRoute() !== preparedRoute) return false;
      const activeSession = getSession();
      activeSession.effort = getRoute().effectiveEffort || null;
      activeSession.fast = getRoute().fast === true;
      if (getRoute().autoEffort === false) activeSession.autoEffort = false;
      else delete activeSession.autoEffort;
      activeSession.cwd = getCurrentCwd();
      restoreResumedToolSurface(activeSession, getRoute());
      writeStatuslineRoute(statusRoutes, activeSession, getRoute());
      return true;
    };
  }

  async function resume(id) {
    // An addressed runtime may only reopen its own conversation; checked
    // before anything is retired or closed.
    deps.assertResumeTarget?.(id);
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
    // Restored rows carry their messages' stable ids (legacy transcripts are
    // stamped here and persisted), so a live compaction can grey exactly the
    // rows of what it drops.
    stampCompactionMessageIds(resumed.messages, resumed.id || id);
    await retirePrevious(previous, resumed);
    setSession(resumed);
    // Resume is not work: the Lead pool row is written only by turn
    // start/settle, so opening an old conversation never re-lists it in the
    // Agent window for another reap window (user report).
    restoreWorkspaceAfterResume(resumed);
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
      // The display-only compaction archive above the restored rows.
      transcriptArchive: compactionArchiveRange(resumed),
    };
  }

  return { resume };
}
