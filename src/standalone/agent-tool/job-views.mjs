// Job/session view layer: pure readers over the tag registry + job stores. The
// views live under ./job-views/:
//   session-progress — live worker progress and the frozen terminal fields
//   agent-list       — the /agents list projection
//   job-lookup       — read/status resolution, with the worker-session fallback
//   job-render       — job list rows and the single-job status card
//   spawn-meta       — task meta for prepared / pending spawns and meta merges
import { ACTIVE_STAGES } from './tool-def.mjs';
import { createProviderInit } from './provider-init.mjs';
import { createAgentList } from './job-views/agent-list.mjs';
import { createJobLookup } from './job-views/job-lookup.mjs';
import { createJobRender } from './job-views/job-render.mjs';
import { createSessionProgress } from './job-views/session-progress.mjs';
import { mergeJobMeta, pendingSpawnMeta, preparedSpawnMeta } from './job-views/spawn-meta.mjs';

export function createJobViews({
  mgr,
  getLiveSession,
  reg,
  DEFAULT_SPAWN_PREP_TIMEOUT_MS,
  refreshTagsFromSessions,
  agentSessionEntries,
  tags,
  cfgMod,
}) {
  function isSessionBusy(sessionId) {
    const runtime = mgr.getSessionRuntime?.(sessionId);
    if (runtime?.controller?.signal && !runtime.controller.signal.aborted) return true;
    if (runtime?.stage) return ACTIVE_STAGES.has(runtime.stage);
    const session = getLiveSession(sessionId);
    return ACTIVE_STAGES.has(session?.status || '');
  }

  // Provider init de-dup lives in ./agent-tool/provider-init.mjs; the factory
  // keeps its per-provider chain/ready state private per agent instance. The
  // chain-gate defaults to the spawn-prep cap (see provider-init.mjs comments).
  const { ensureProvider } = createProviderInit(reg, DEFAULT_SPAWN_PREP_TIMEOUT_MS);

  const progress = createSessionProgress({ mgr });
  const list = createAgentList({ mgr, refreshTagsFromSessions, agentSessionEntries, progress });
  const lookup = createJobLookup({ mgr, tags, refreshTagsFromSessions });
  const render = createJobRender({ progress });

  return {
    isSessionBusy,
    ensureProvider,
    list,
    sessionProgressExtras: progress.sessionProgressExtras,
    jobWorkerSnapshot: progress.jobWorkerSnapshot,
    listJobs: render.listJobs,
    getJob: lookup.getJob,
    workerFallbackJob: lookup.workerFallbackJob,
    getJobOrWorker: lookup.getJobOrWorker,
    renderJob: render.renderJob,
    preparedSpawnMeta,
    pendingSpawnMeta: (args = {}, extras = {}) => pendingSpawnMeta(cfgMod, args, extras),
    mergeJobMeta,
  };
}
