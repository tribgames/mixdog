import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureProcessListenerHeadroom } from '../../runtime/shared/process-listener-headroom.mjs';
import { AGENT_TOOL } from './agent-tool/tool-def.mjs';
import { cancelBackgroundTask } from '../../runtime/shared/background-tasks.mjs';
import { closeManagedSession } from '../lifecycle/shared.mjs';
import {
  agentScope,
  clean,
  envTimeoutMs,
  callerSessionForContext,
  terminalPidForContext,
} from './agent-tool/helpers.mjs';
import { createTagRegistry } from './agent-tool/tag-registry.mjs';
import { createJobViews } from './agent-tool/job-views.mjs';
import { liveAgentStatusRow } from './agent-tool/job-views/session-progress.mjs';
import { createSpawnFlow } from './agent-tool/spawn-flow.mjs';
import { createSendFlow } from './agent-tool/send-flow.mjs';
import { createCloseFlow } from './agent-tool/close-flow.mjs';
import { createRestartFailureNotifier } from './agent-tool/restart-notify.mjs';
import { createTerminalTrace } from './agent-tool/terminal-trace.mjs';
import { createAgentExecute } from './agent-tool/execute.mjs';
import { createTurnReviewCollector } from './agent-tool/turn-review.mjs';
// Re-export the static tool descriptor so importers of this facade keep the
// identical public surface (`import { AGENT_TOOL } from './agent-tool.mjs'`).
export { AGENT_TOOL };
export { resolveAgentSpawnPreset } from './agent-tool/spawn-preset.mjs';

ensureProcessListenerHeadroom(64);

const STANDALONE_SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Independent hard cap for the spawn *prep* phase (ensureProvider /
// prepareAgentSession / catalog+rules load). Kept separate from the
// first-response watchdog so prep cannot hang a whole fanout before the model
// request starts. Set MIXDOG_AGENT_SPAWN_PREP_TIMEOUT_MS=0 to fully disable the
// cap and restore strictly-unbounded prep.
const DEFAULT_SPAWN_PREP_TIMEOUT_MS = envTimeoutMs('MIXDOG_AGENT_SPAWN_PREP_TIMEOUT_MS', 120_000);

// The standalone agent tool: tag registry + job views + spawn/send/close flows
// composed under one dispatcher (agent-tool/execute.mjs).
export function createStandaloneAgent({
  cfgMod,
  reg,
  mgr,
  dataDir,
  cwd: defaultCwd,
  mcpScopeId = null,
  onSubagentEvent,
  notifySessionCompletion,
  sessionSurface = null,
  awaitKeychainPrewarm = async () => {},
  isKeychainPrewarmReady = () => true,
  // Provider model catalog for user-pinned spawn models; absent on surfaces
  // without one, where only exact provider + model pass.
  listProviderModels = null,
}) {
  const canUseSessionSurface = (session) =>
    typeof sessionSurface?.runTurn === 'function' && sessionSurface.canRun?.(session) !== false;
  const statusListeners = new Set();
  const notifyStatusChange = () => {
    for (const listener of [...statusListeners]) {
      try {
        listener();
      } catch {
        /* status observers never affect agent lifecycle */
      }
    }
  };
  // Optional bridge to the standard hook bus for SubagentStart / SubagentStop.
  // Best-effort: a hook error must never affect worker spawn/finish.
  function emitSubagentEvent(phase, agent, extra = {}) {
    if (typeof onSubagentEvent !== 'function') return;
    try {
      onSubagentEvent(phase, { agent_type: agent || null, ...extra });
    } catch {
      /* best-effort */
    }
  }

  const registry = createTagRegistry({ dataDir, cfgMod, mgr });
  // Tasks the previous process was running died with it: tell their owners.
  // Later sweeps also catch rows the predecessor settled as it shut down.
  const notifyRestartFailures = createRestartFailureNotifier({
    pendingRestartFailures: registry.pendingRestartFailures,
    markRestartNotified: registry.markRestartNotified,
    mgr,
    notifySessionCompletion,
  });
  const sweepRestartFailures = () => {
    registry.recoverStaleWorkerRows({ deadOnly: true });
    notifyRestartFailures();
  };
  notifyRestartFailures();
  const views = createJobViews({ ...registry, mgr, reg, cfgMod, DEFAULT_SPAWN_PREP_TIMEOUT_MS });
  // Late-bound: the send flow that wakes an idle worker is built after spawn.
  let wakeIdleWorker = null;
  const spawnFlow = createSpawnFlow({
    onWorkerCompletionQueued: (sessionId) => wakeIdleWorker?.(sessionId),
    ...registry,
    ...views,
    mgr,
    defaultCwd,
    mcpScopeId,
    emitSubagentEvent,
    notifyStatusChange,
    notifySessionCompletion,
    sessionSurface,
    cfgMod,
    dataDir,
    STANDALONE_SOURCE_ROOT,
    DEFAULT_SPAWN_PREP_TIMEOUT_MS,
    createTurnReviewCollector,
  });
  const sendFlow = createSendFlow({
    mgr,
    cfgMod,
    dataDir,
    STANDALONE_SOURCE_ROOT,
    defaultCwd,
    sessionSurface,
    canUseSessionSurface,
    registry,
    views,
    spawnFlow,
  });
  wakeIdleWorker = sendFlow.wakeIdleWorker;
  const closeFlow = createCloseFlow({ mgr, registry, views });
  const terminalTrace = createTerminalTrace({ registry });
  const execute = createAgentExecute({
    mgr,
    defaultCwd,
    awaitKeychainPrewarm,
    registry,
    views,
    spawnFlow,
    sendFlow,
    closeFlow,
    terminalTrace,
    listProviderModels,
  });

  /**
   * Run one workflow agent (`args.agent`, `args.prompt`, optional `cwd` and
   * `attachmentParts`) to completion and resolve `{ sessionId, content }` —
   * for a caller that has no session to hand the result to (a routine's
   * executor, routine-executor.mjs). `context.callerSessionId` is the id the
   * agent is created under: its run stamp and unattended policy come from it.
   * Rejects when the agent fails or is cancelled, or `signal` aborts (which
   * cancels it). The agent's session is closed afterwards.
   */
  async function runToCompletion(args = {}, context = {}, { signal = null } = {}) {
    await awaitKeychainPrewarm();
    const abortError = () =>
      signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason || 'agent run aborted'));
    if (signal?.aborted) throw abortError();
    const job = spawnFlow.startDeferredSpawnJob({ ...args, type: 'spawn' }, clean(context.callerCwd), context, context);
    const onAbort = () => cancelBackgroundTask(job.taskId, 'agent run aborted', { notify: false });
    signal?.addEventListener?.('abort', onAbort, { once: true });
    let value = null;
    try {
      value = await job.promise;
    } finally {
      signal?.removeEventListener?.('abort', onAbort);
    }
    const sessionId = clean(job.meta?.sessionId) || clean(value?.sessionId);
    if (sessionId) {
      try {
        await closeManagedSession(mgr, sessionId, 'routine-executor-finished');
      } catch {
        /* the run's result stands; a close that fails is swept with idle agents */
      }
    }
    if (signal?.aborted) throw abortError();
    if (job.status === 'cancelled') throw new Error('the agent run was cancelled');
    if (job.status !== 'completed') throw new Error(job.error || 'the agent run failed');
    const result = value ?? job.result;
    return { sessionId: sessionId || null, content: String(result?.content ?? '') };
  }

  function getStatus(context = {}) {
    if (!isKeychainPrewarmReady()) {
      void awaitKeychainPrewarm();
      return { workers: [], jobs: [], scope: null };
    }
    sweepRestartFailures();
    const scopedContext = agentScope({}, context);
    const ownerSession = callerSessionForContext(scopedContext);
    const pid = terminalPidForContext(scopedContext);
    let scope = { allTerminals: true };
    if (ownerSession) scope = { sessionId: ownerSession };
    else if (pid) scope = { clientHostPid: pid };
    return {
      workers: views.list({ scanSessions: false, context: scopedContext }).map(liveAgentStatusRow),
      jobs: views.listJobs(scopedContext).map(liveAgentStatusRow),
      scope,
    };
  }

  function recoverWorkers(context = {}) {
    if (!isKeychainPrewarmReady()) {
      void awaitKeychainPrewarm();
      return [];
    }
    sweepRestartFailures();
    const scopedContext = agentScope({ recover: true }, context);
    registry.refreshTagsFromSessions({ scanSessions: true, context: scopedContext });
    return views.list({ scanSessions: false, context: scopedContext });
  }

  return {
    tools: [AGENT_TOOL],
    execute,
    runToCompletion,
    onStatusChange: (listener) => {
      if (typeof listener !== 'function') return () => {};
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    getStatus,
    recoverWorkers,
    // Daemon start: settle the rows the previous process left running and
    // queue each owner's failure result; resolves once they are queued.
    settleRestartFailures: () => {
      registry.recoverStaleWorkerRows({ deadOnly: true });
      return notifyRestartFailures();
    },
    upsertLeadSession: registry.upsertLeadSession,
    updateLeadWorkerCwd: registry.updateLeadWorkerCwd,
    forgetLeadSession: registry.forgetLeadSession,
    closeAll: closeFlow.closeAll,
    dispose: (options) => registry.dispose(options),
    disposeAsync: (options) => registry.disposeAsync(options),
    flushIndexWrites: () => registry.flushIndexWrites(),
  };
}
