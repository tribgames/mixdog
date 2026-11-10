/**
 * session-switch/context-switch.mjs — leaving the open conversation for a
 * new desktop context (cwd + desktop session) or a fresh session.
 */
import { closeOutgoingSession, isScratchSession } from '../shared.mjs';
import { replacementSessionCwd } from '../../workspace/workspace-state.mjs';

export function createContextSwitch(deps, { ingestSessionIntoMemory, closeSurfaceSession, releaseSessionWork }) {
  const {
    getSession,
    setSession,
    setRoute,
    getConfig,
    setDesktopSession,
    createCurrentSession,
    refreshRouteEffort,
    invalidateContextStatusCache,
    invalidatePreSessionToolSurface,
    applyResolvedCwd,
    resolveRoute,
    clearRoutePreparation,
  } = deps;

  async function switchContext({ cwd, desktopSession: nextDesktopSession, forResume = false } = {}) {
    // Leaving the open conversation would re-key an addressed runtime.
    deps.assertNotAddressed?.('switchContext');
    clearRoutePreparation?.();
    const session = getSession();
    if (session?.id) {
      const cleanupReason = 'desktop-context-switch';
      // A failed close throws here, before anything else was released.
      await closeOutgoingSession(closeSurfaceSession, session, cleanupReason, { tombstone: isScratchSession(session) });
      // Fire-and-forget: context switch is user-facing latency; the memory
      // runtime outlives the closed session so the write completes safely.
      void ingestSessionIntoMemory(session);
      releaseSessionWork(session.id, cleanupReason);
      setSession(null);
    }
    setDesktopSession(nextDesktopSession && typeof nextDesktopSession === 'object' ? nextDesktopSession : null);
    // Retargets the live execution cwd in place; extension settings are
    // global, so the switch never waits on an MCP or Skills reload.
    await applyResolvedCwd(cwd);
    // Resuming a historical session temporarily routes the runtime through
    // that session's provider/model. A fresh desktop task or project must
    // return to the configured Lead route instead of inheriting the route
    // of whichever session happened to be open immediately beforehand.
    if (
      !forResume &&
      typeof setRoute === 'function' &&
      typeof getConfig === 'function' &&
      typeof resolveRoute === 'function'
    ) {
      setRoute(resolveRoute(getConfig(), {}));
      await refreshRouteEffort?.();
    }
    invalidateContextStatusCache();
    invalidatePreSessionToolSurface();
    return true;
  }

  async function newSession() {
    deps.assertNotAddressed?.('newSession');
    const session = getSession();
    // Leaving a worktree-bound Lead: the new session starts in the Project
    // folder, never in the worktree the old session retains.
    const projectFolder = replacementSessionCwd(session);
    if (session?.id) {
      await closeOutgoingSession(closeSurfaceSession, session, 'cli-new', { tombstone: isScratchSession(session) });
      void ingestSessionIntoMemory(session);
      setSession(null);
    }
    if (projectFolder) await applyResolvedCwd(projectFolder);
    invalidateContextStatusCache();
    await createCurrentSession();
    return getSession().id;
  }

  return { switchContext, newSession };
}
