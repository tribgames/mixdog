/**
 * src/session-runtime/lifecycle/session-switch.mjs - session catalog access
 * and the switch paths: delete, context switch, new, resume, prefetch.
 * session-switch/: session-delete (delete + work release), context-switch
 * (switch + new), resume.
 */
import { getStoreDir } from '../../runtime/agent/orchestrator/session/store/paths-heartbeat.mjs';
import { toolSpecForMode } from '../effort.mjs';
import { listLeadSessions } from './session-catalog.mjs';
import { createSessionDelete } from './session-switch/session-delete.mjs';
import { createContextSwitch } from './session-switch/context-switch.mjs';
import { createSessionResume } from './session-switch/resume.mjs';

export { resolveResumeCwd } from './session-switch/resume.mjs';

export function createSessionSwitching(deps, { ingestSessionIntoMemory, closeSurfaceSession, cancelBackgroundTasks }) {
  const { mgr, getMode } = deps;
  const { releaseSessionWork, deleteSession } = createSessionDelete(deps, { cancelBackgroundTasks });
  const { switchContext, newSession } = createContextSwitch(deps, {
    ingestSessionIntoMemory,
    closeSurfaceSession,
    releaseSessionWork,
  });
  const { resume } = createSessionResume(deps, { ingestSessionIntoMemory, closeSurfaceSession });

  function listSessions(options = {}) {
    return listLeadSessions(mgr, options);
  }

  // Desktop watcher hook: absolute path of the on-disk session store so the
  // host can fs.watch it and push sidebar updates instead of polling.
  function sessionStoreDir() {
    try {
      return getStoreDir();
    } catch {
      return null;
    }
  }

  function prefetchSession(id) {
    return mgr.prefetchSession?.(id, toolSpecForMode(getMode())) === true;
  }

  return { listSessions, sessionStoreDir, deleteSession, switchContext, newSession, prefetchSession, resume };
}
