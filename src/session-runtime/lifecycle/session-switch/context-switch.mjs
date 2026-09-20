/**
 * session-switch/context-switch.mjs — leaving the open conversation for a
 * new desktop context (cwd + desktop session) or a fresh session.
 */
import { isScratchSession } from '../shared.mjs';

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
    clearRoutePreparation?.();
    const session = getSession();
    if (session?.id) {
      const cleanupReason = 'desktop-context-switch';
      // Fire-and-forget: context switch is user-facing latency; the memory
      // runtime outlives the closed session so the write completes safely.
      void ingestSessionIntoMemory(session);
      releaseSessionWork(session.id, cleanupReason);
      closeSurfaceSession(session, cleanupReason, { tombstone: isScratchSession(session) });
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
    const session = getSession();
    if (session?.id) {
      void ingestSessionIntoMemory(session);
      closeSurfaceSession(session, 'cli-new', { tombstone: isScratchSession(session) });
      setSession(null);
    }
    invalidateContextStatusCache();
    await createCurrentSession();
    return getSession().id;
  }

  return { switchContext, newSession };
}
