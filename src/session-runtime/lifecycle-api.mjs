/**
 * src/session-runtime/lifecycle-api.mjs - session lifecycle surface: teardown
 * (close/abort), resume/new/delete, the resumable-session listing, and
 * inheritance. Stateless helpers are imported directly and the runtime injects
 * live getters/setters for the mutable session/route/cwd locals plus the
 * closure callbacks and long-lived handles (managers, timers,
 * channel/agent/mcp).
 */
import { cancelBackgroundTasks } from '../runtime/shared/background-tasks.mjs';
import { runHandoffCompaction } from '../runtime/agent/orchestrator/session/manager/compaction-runner.mjs';
import { saveSession } from '../runtime/agent/orchestrator/session/store.mjs';
import { createSurfaceSessionCloser } from './lifecycle/shared.mjs';
import { createMemoryIngest } from './lifecycle/memory-ingest.mjs';
import { createTeardown } from './lifecycle/teardown.mjs';
import { createSessionSwitching } from './lifecycle/session-switch.mjs';
import { createInheritance } from './lifecycle/inheritance.mjs';

export { resolveResumeCwd } from './lifecycle/session-switch.mjs';

export function createLifecycleApi(deps) {
  const shared = {
    cancelBackgroundTasks: deps.cancelBackgroundTasks || cancelBackgroundTasks,
    closeSurfaceSession: createSurfaceSessionCloser(deps.mgr),
    ingestSessionIntoMemory: createMemoryIngest(deps),
  };
  const teardown = createTeardown(deps, shared);
  const switching = createSessionSwitching(deps, shared);
  const inheritance = createInheritance(deps, {
    compactConversation: deps.compactConversation || runHandoffCompaction,
    saveSession: deps.saveSession || saveSession,
  });
  return {
    closeCanonicalSession: teardown.closeCanonicalSession,
    close: teardown.close,
    abort: teardown.abort,
    listSessions: switching.listSessions,
    sessionStoreDir: switching.sessionStoreDir,
    deleteSession: switching.deleteSession,
    switchContext: switching.switchContext,
    newSession: switching.newSession,
    prefetchSession: switching.prefetchSession,
    resume: switching.resume,
    inheritancePreflight: inheritance.inheritancePreflight,
    inheritFrom: inheritance.inheritFrom,
  };
}
