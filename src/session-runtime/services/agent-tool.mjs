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
import {
  liveAgentStatusRow,
  onRolePolicyResolved,
  refreshRolePolicies,
} from './agent-tool/job-views/session-progress.mjs';
import { createSpawnFlow } from './agent-tool/spawn-flow.mjs';
import { createSendFlow } from './agent-tool/send-flow.mjs';
import { createCloseFlow } from './agent-tool/close-flow.mjs';
import { createRestartFailureNotifier } from './agent-tool/restart-notify.mjs';
import { createTerminalTrace } from './agent-tool/terminal-trace.mjs';
import { createAgentExecute } from './agent-tool/execute.mjs';
import { createTurnReviewCollector } from './agent-tool/turn-review.mjs';
import { registerAgentMaintenance, requestAgentMaintenance } from './agent-tool/maintenance-pass.mjs';
import {
  registerSessionPurgeHook,
  subscribeLiveSessions,
} from '../../runtime/agent/orchestrator/session/store/session-observers.mjs';
import { acquireSessionRecords } from './agent-tool/job-views/session-record.mjs';
import { onSessionActivityChange } from '../../runtime/shared/session-activity-signal.mjs';
import { onSessionApprovalWaitChange } from '../../runtime/shared/session-approval-wait.mjs';
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
  // Defined with the status reads below; a source of change only asks.
  let statusMayHaveChanged = () => {};
  const notifyStatusChange = () => {
    // An agent started, finished or was cancelled: bookkeeping runs soon.
    requestAgentMaintenance();
    statusMayHaveChanged({ force: true });
  };
  // The status pulse's getSession, from memory (job-views/session-record.mjs).
  const sessionRecords = acquireSessionRecords(mgr);
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

  const registry = createTagRegistry({ dataDir, cfgMod, mgr, sessionRecords });
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
  const views = createJobViews({ ...registry, mgr, reg, cfgMod, sessionRecords, DEFAULT_SPAWN_PREP_TIMEOUT_MS });
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

  // The status read's bookkeeping (restart-failure sweep, reaping, tag
  // reconciliation) loads session records, so it never runs on a read: the
  // process-wide maintenance pass does it for every scope status was read
  // for, one step per scope, on the events that can change it and at the
  // next moment a row of a scope ages out. A new scope only asks for a pass.
  // A scope lasts until its owner session is closed or deleted (a terminal's
  // scope, until the tool is disposed).
  const statusScopes = new Map(); // scope key -> { context, ownerSession }
  let unregisterMaintenance = null;
  function maintenanceSteps() {
    const steps = [sweepRestartFailures];
    for (const scope of statusScopes.values()) {
      steps.push(() => registry.refreshTagsFromSessions({ context: scope.context }));
    }
    steps.push(refreshRolePolicies);
    return steps;
  }
  function nextMaintenanceDeadline(since) {
    let next = Infinity;
    for (const scope of statusScopes.values()) next = Math.min(next, registry.nextStaleRowDeadline(scope.context, since));
    return next;
  }
  function noteStatusScope(scopedContext, ownerSession, pid) {
    const key = scopeKey(ownerSession, pid);
    if (statusScopes.has(key)) return;
    statusScopes.set(key, { context: scopedContext, ownerSession: ownerSession || '' });
    unregisterMaintenance ??= registerAgentMaintenance(maintenanceSteps, nextMaintenanceDeadline);
    requestAgentMaintenance();
  }
  function endStatusScopesOf(sessionId) {
    if (!sessionId) return;
    let ended = false;
    for (const [key, scope] of statusScopes) {
      if (scope.ownerSession !== sessionId) continue;
      statusScopes.delete(key);
      lastStatus.delete(key);
      ended = true;
    }
    if (!ended) return;
    if (statusScopes.size === 0) stopMaintenance();
    // Its records are no longer read: the next re-read lets them go.
    statusMayHaveChanged();
  }
  function stopMaintenance() {
    unregisterMaintenance?.();
    unregisterMaintenance = null;
    statusScopes.clear();
    lastStatus.clear();
  }

  const NOT_READY_STATUS = Object.freeze({ workers: [], jobs: [], scope: null });
  let prewarmWatched = false;

  // What getStatus answers for `scopedContext`, from memory.
  function statusFor(scopedContext) {
    if (!isKeychainPrewarmReady()) {
      if (!prewarmWatched) {
        prewarmWatched = true;
        // Prewarm finishing changes the answer from empty to the real one.
        void Promise.resolve(awaitKeychainPrewarm()).then(
          () => statusMayHaveChanged({ force: true }),
          () => statusMayHaveChanged({ force: true })
        );
      }
      return NOT_READY_STATUS;
    }
    const ownerSession = callerSessionForContext(scopedContext);
    const pid = terminalPidForContext(scopedContext);
    let scope = { allTerminals: true };
    if (ownerSession) scope = { sessionId: ownerSession };
    else if (pid) scope = { clientHostPid: pid };
    return {
      workers: views.list({ scanSessions: false, context: scopedContext, memoryOnly: true }).map(liveAgentStatusRow),
      jobs: views.listJobs(scopedContext, { memoryOnly: true }).map(liveAgentStatusRow),
      scope,
    };
  }

  // Status observers (onStatusChange) hear every change in what getStatus
  // answers a scope read lately: each source that may change it (an agent's
  // start/finish/cancel, a session's activity — turns, task waits, todos,
  // background tasks —, an approval wait, a worker-index write or another
  // process's, a session record reloaded, a role's watchdog policy resolved,
  // keychain prewarm finishing) asks
  // for one re-read of those answers from memory, on the next turn, and the
  // observers are told when any differs from what its reader last got.
  const lastStatus = new Map(); // scope key -> the answer last handed out, serialized
  let recheckQueued = false;
  let recheckForced = false;
  let disposed = false;
  const scopeKey = (ownerSession, pid) => `${ownerSession || ''}\0${pid || ''}`;
  statusMayHaveChanged = ({ force = false } = {}) => {
    if (force) recheckForced = true;
    if (recheckQueued || disposed) return;
    recheckQueued = true;
    setImmediate(() => {
      recheckQueued = false;
      let changed = recheckForced;
      recheckForced = false;
      if (disposed) return;
      // The records these answers read are exactly the ones still needed.
      sessionRecords.retainRead(() => {
        for (const [key, scope] of statusScopes) {
          let answer = '';
          try {
            answer = JSON.stringify(statusFor(scope.context));
          } catch {
            /* an unreadable answer counts as changed */
          }
          if (lastStatus.get(key) === answer) continue;
          lastStatus.set(key, answer);
          changed = true;
        }
      });
      if (!changed) return;
      for (const listener of [...statusListeners]) {
        try {
          listener();
        } catch {
          /* status observers never affect agent lifecycle */
        }
      }
    });
  };
  // The worker index or a session record changing, or a session being
  // deleted, may also leave bookkeeping to do (a row to reap, a restart
  // failure to tell): the pass is asked as well.
  const bookkeepingMayBeDue = () => {
    if (unregisterMaintenance) requestAgentMaintenance();
  };
  // A row the reaper kept for its session: the end of what kept it (an aged-out
  // row's busy session settling; an open session closing) looks again.
  const heldRowMayBeFree = (sessionId, ended) => {
    const reason = sessionId ? registry.heldRowFor(sessionId) : null;
    if (reason && (ended === 'session' || reason === ended)) bookkeepingMayBeDue();
  };
  const stopStatusSources = [
    onSessionActivityChange((sessionId) => {
      statusMayHaveChanged();
      heldRowMayBeFree(sessionId, 'work');
    }),
    onSessionApprovalWaitChange(() => statusMayHaveChanged()),
    registry.onWorkerRowsChange(() => {
      statusMayHaveChanged();
      bookkeepingMayBeDue();
    }),
    sessionRecords.onChange(() => {
      statusMayHaveChanged();
      bookkeepingMayBeDue();
    }),
    onRolePolicyResolved(() => statusMayHaveChanged()),
    registerSessionPurgeHook((sessionId) => {
      endStatusScopesOf(sessionId);
      bookkeepingMayBeDue();
    }),
    subscribeLiveSessions((session) => {
      if (session?.closed !== true) return;
      endStatusScopesOf(session.id);
      heldRowMayBeFree(session.id, 'session');
    }),
  ];

  // Every Lead's state pulse (2 s) reads this: it is served from memory — the
  // worker index (watched, plus this process's own writes), live sessions and
  // background tasks — and reads no file in steady state.
  function getStatus(context = {}) {
    const scopedContext = agentScope({}, context);
    if (!isKeychainPrewarmReady()) return statusFor(scopedContext);
    const ownerSession = callerSessionForContext(scopedContext);
    const pid = terminalPidForContext(scopedContext);
    noteStatusScope(scopedContext, ownerSession, pid);
    const status = statusFor(scopedContext);
    lastStatus.set(scopeKey(ownerSession, pid), JSON.stringify(status));
    return status;
  }

  function disposeStatus() {
    disposed = true;
    stopMaintenance();
    for (const stop of stopStatusSources) stop();
    sessionRecords.release();
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
    dispose: (options) => {
      disposeStatus();
      return registry.dispose(options);
    },
    disposeAsync: (options) => {
      disposeStatus();
      return registry.disposeAsync(options);
    },
    flushIndexWrites: () => registry.flushIndexWrites(),
  };
}
