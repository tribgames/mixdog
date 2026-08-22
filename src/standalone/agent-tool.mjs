import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cancelBackgroundTask,
  cleanupBackgroundTasks,
  getBackgroundTask,
  listBackgroundTasks,
  startBackgroundTask,
  sanitizeTaskMeta,
  taskIdFromArgs,
} from '../runtime/shared/background-tasks.mjs';
import { presentErrorText, errorLine } from '../runtime/shared/err-text.mjs';
import { normalizeAgentPermission } from '../runtime/shared/markdown-frontmatter.mjs';
import { ensureProcessListenerHeadroom } from '../runtime/shared/process-listener-headroom.mjs';
import { resourceAdmission } from '../runtime/shared/resource-admission.mjs';
import { prepareAgentSession } from '../runtime/agent/orchestrator/agent-runtime/session-builder.mjs';
import {
  resolveAgentWatchdogPolicy,
  resolveHandoffMessageStartIndex,
  watchdogPartialHandoffFromError,
} from '../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';
import { createProgressWatchdogRegistry } from './agent-watchdog-registry.mjs';
import { buildAgentTaskProgressFields } from './agent-task-status.mjs';
import { AGENT_OWNER } from '../runtime/agent/orchestrator/agent-owner.mjs';
import {
  ACTIVE_STAGES,
  AGENT_TOOL,
  WORKER_INDEX_FILE,
} from './agent-tool/tool-def.mjs';
import {
  agentScope,
  agentTagOf,
  clean,
  clearAgentStatuslineRoute,
  envTimeoutMs,
  nonNegativeInt,
  normalizeAgentName,
  positiveInt,
  callerSessionForContext,
  presetKey,
  readAgentFrontmatterPermission,
  resolvePrompt,
  rowMatchesContext,
  sessionMatchesContext,
  terminalPidForContext,
  writeAgentStatuslineRoute,
} from './agent-tool/helpers.mjs';
import { abnormalEmptyFinishError, renderResult } from './agent-tool/render.mjs';
import { createProviderInit } from './agent-tool/provider-init.mjs';
import { createNotify } from './agent-tool/notify.mjs';
import { createTagRegistry } from './agent-tool/tag-registry.mjs';
import { createJobViews } from './agent-tool/job-views.mjs';
import {
  reconcileJobFinally,
  reconcileJobStreamStalled,
  reconcileJobTerminalResult,
  reconcileJobWatchdogPartial,
} from './agent-tool/job-task-reconcile.mjs';
import { createSpawnFlow } from './agent-tool/spawn-flow.mjs';
import { resolveAgentSpawnPreset } from './agent-tool/spawn-preset.mjs';
import {
  TAG_TOMBSTONE_TTL_MS,
  isLeadPoolAgent,
  isTerminalWorkerStatus,
  tagTombstoneKey,
  workerRowTime,
  workerRowToSession,
} from './agent-tool/worker-rows.mjs';
import { resolveAgentTerminalReapMs } from '../session-runtime/config-helpers.mjs';
import { createWorkerIndex } from './agent-tool/worker-index.mjs';
import {
  beginAgentTurnReview,
  completeAgentTurnReview,
} from '../runtime/shared/turn-snapshot.mjs';
// Re-export the static tool descriptor so importers of this facade keep the
// identical public surface (`import { AGENT_TOOL } from './agent-tool.mjs'`).
export { AGENT_TOOL };
export { resolveAgentSpawnPreset } from './agent-tool/spawn-preset.mjs';

ensureProcessListenerHeadroom(64);

const STANDALONE_SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Independent hard cap for the spawn *prep* phase (ensureProvider /
// prepareAgentSession / catalog+rules load). Kept separate from the
// first-response watchdog so prep cannot hang a whole fanout before the model
// request starts. Set MIXDOG_AGENT_SPAWN_PREP_TIMEOUT_MS=0 to fully disable the
// cap and restore strictly-unbounded prep.
const DEFAULT_SPAWN_PREP_TIMEOUT_MS = envTimeoutMs('MIXDOG_AGENT_SPAWN_PREP_TIMEOUT_MS', 120_000);

export function createStandaloneAgent({
  cfgMod,
  reg,
  mgr: baseMgr,
  dataDir,
  cwd: defaultCwd,
  mcpScopeId = null,
  onSubagentEvent,
  notifySessionCompletion,
  awaitKeychainPrewarm = async () => {},
  isKeychainPrewarmReady = () => true,
}) {
  const mgr = baseMgr;
  const statusListeners = new Set();
  const notifyStatusChange = () => {
    for (const listener of [...statusListeners]) {
      try { listener(); } catch { /* status observers never affect agent lifecycle */ }
    }
  };
  // Optional bridge to the standard hook bus for SubagentStart / SubagentStop.
  // Best-effort: a hook error must never affect worker spawn/finish.
  function emitSubagentEvent(phase, agent, extra = {}) {
    if (typeof onSubagentEvent !== 'function') return;
    try { onSubagentEvent(phase, { agent_type: agent || null, ...extra }); } catch { /* best-effort */ }
  }
  function createTurnReviewCollector(session, tag, agent, notifyContext = {}) {
    const ownerSessionId = clean(
      notifyContext?.callerSessionId
      || notifyContext?.sessionId
      || notifyContext?.routingSessionId
      || session?.ownerSessionId,
    );
    const handle = beginAgentTurnReview(ownerSessionId, session?.id, { tag, agent });
    let latestPatch = null;
    return {
      onToolResult(message) {
        if (Object.hasOwn(message || {}, 'uiDiff') && typeof message.uiDiff === 'string') {
          latestPatch = message.uiDiff;
        }
      },
      complete() {
        completeAgentTurnReview(handle, latestPatch === null ? [] : [latestPatch]);
      },
    };
  }
    // Tag maps + resolve/bind/reap lifecycle: agent-tool/tag-registry.mjs.
    const {
      tags,
      tagAgents,
      tagCwds,
      reapTimers,
      wantsSessionScan,
      resolveTag,
      getLiveSession,
      tagForSession,
      agentSessionEntries,
      nextTag,
      refreshTagsFromSessions,
      bindTag,
      forgetTag,
      forgetTerminalSession,
      tombstoneTerminalSession,
      tagTombstoneForTag,
      consumeTagTombstone,
      cancelReap,
      scheduleReap,
      transitionStaleNonterminalRows,
      readAllTagTombstones,
      readTagTombstones,
      readWorkerRows,
      writeWorkerRows,
      flushWorkerIndexMutations,
      upsertWorkerSession,
      upsertWorkerSessionDeferred,
      upsertLeadSession,
      removeWorkerRow,
      refreshTagsFromIndex,
    } = createTagRegistry({
      dataDir,
      cfgMod,
      mgr,
      emitSubagentEvent,
    });

    // Job/session views (list/getJob/render/spawn-meta): agent-tool/job-views.mjs.
    const {
      isSessionBusy,
      ensureProvider,
      list,
      sessionProgressExtras,
      jobWorkerSnapshot,
      listJobs,
      getJob,
      workerFallbackJob,
      getJobOrWorker,
      renderJob,
      preparedSpawnMeta,
      pendingSpawnMeta,
      mergeJobMeta,
    } = createJobViews({
      mgr,
      getLiveSession,
      reg,
      DEFAULT_SPAWN_PREP_TIMEOUT_MS,
      refreshTagsFromSessions,
      agentSessionEntries,
      tags,
      cfgMod,
    });

    // Spawn/job lifecycle (startJob/watchdogs/prepare/run): agent-tool/spawn-flow.mjs.
    const {
      closePreparedSpawn,
      workerNotifyFn,
      notifyOwnerAgentCompletionEarly,
      startJob,
      startDeferredSpawnJob,
      progressWatchdogs,
      startProgressIdleWatchdog,
      turnStartStamper,
      progressStamper,
      prepareSpawn,
      prepareSpawnInProcess,
      runSpawn,
    } = createSpawnFlow({
      mgr,
      forgetTerminalSession,
      pendingSpawnMeta,
      DEFAULT_SPAWN_PREP_TIMEOUT_MS,
      mergeJobMeta,
      preparedSpawnMeta,
      upsertWorkerSessionDeferred,
      refreshTagsFromSessions,
      readWorkerRows,
      defaultCwd,
      mcpScopeId,
      nextTag,
      cancelReap,
      bindTag,
      emitSubagentEvent,
      notifyStatusChange,
      notifySessionCompletion,
      scheduleReap,
      cfgMod,
      dataDir,
      STANDALONE_SOURCE_ROOT,
      ensureProvider,
      resolveTag,
      wantsSessionScan,
      createTurnReviewCollector,
    });

  async function spawn(args) {
    return await runSpawn(await prepareSpawn(args));
  }

  async function prepareSend(args, context = {}) {
    refreshTagsFromSessions({ scanSessions: wantsSessionScan(args), context });
    const target = clean(args.tag || args.sessionId);
    if (!target) throw new Error('agent send: tag or sessionId is required');
    const sessionId = resolveTag(target, context, { scanSessions: wantsSessionScan(args) });
    if (!sessionId) throw new Error(`agent send: target "${target}" not found`);
    const session = mgr.getSession(sessionId);
    if (!session || session.closed) throw new Error(`agent send: session "${sessionId}" is closed`);
    cancelReap(sessionId);
    const prompt = await resolvePrompt(args, session.cwd || defaultCwd);
    return { args, session, sessionId, prompt };
  }

  async function runSend(prepared, notifyContext = null, job = null) {
    const { args, session, sessionId, prompt } = prepared;
    const sendAgent = session.agent || normalizeAgentName(args.agent);
    const tag = tagForSession(sessionId);
    // Queued sends run as follow-up turns inside this same askSession call;
    // the watchdog sweep re-stamps turnStartedAt at each turn boundary.
    const watchdog = startProgressIdleWatchdog(sessionId, resolveAgentWatchdogPolicy(sendAgent), sendAgent, {
      onTurnStart: turnStartStamper(session, tag),
      onProgress: progressStamper(session, tag),
    });
    const turnReview = createTurnReviewCollector(session, tag, sendAgent, notifyContext || {});
    let finalStatus = 'idle';
    upsertWorkerSessionDeferred(session, tag, {
      status: 'running',
      stage: 'running',
      turnStartedAt: new Date().toISOString(),
    });
    let handoffMsgStart = 0;
    try {
      const completionValue = (result) => {
        // Same abnormal-empty → error promotion as runSpawn: a reused/`send`
        // worker that hits the cap, truncates, or finishes empty must surface
        // as a failure with an accurate reason, not a silent completed empty.
        const abnormalError = abnormalEmptyFinishError(result, session.agent || sendAgent);
        return {
          tag,
          sessionId,
          agent: session.agent || null,
          provider: session.provider,
          model: session.model,
          content: result?.content || '',
          ...(abnormalError ? { error: abnormalError } : {}),
        };
      };
      handoffMsgStart = resolveHandoffMessageStartIndex(mgr.getSession(sessionId));
      const result = await mgr.askSession(sessionId, prompt, args.context || null, null, session.cwd || defaultCwd, null, {
        notifyFn: workerNotifyFn(sessionId, notifyContext || {}),
        onToolResult: (message) => turnReview.onToolResult(message),
        ...(job ? {
          onTerminalResult: (terminalResult) => {
            turnReview.complete();
            const value = completionValue(terminalResult);
            if (job) job._terminalResultValue = value;
            notifyOwnerAgentCompletionEarly(job, value, notifyContext || {});
            reconcileJobTerminalResult(job, value);
          },
        } : {}),
      });
      // Early preview no longer suppresses the canonical body notification;
      // notifyTaskCompletion fires once with output via resolve/reconcile.
      const finalValue = completionValue(result);
      if (finalValue.error) {
        finalStatus = 'error';
        if (job) job._terminalResultValue = finalValue;
        throw new Error(finalValue.error);
      }
      return finalValue;
    } catch (error) {
      const partial = watchdogPartialHandoffFromError(error, mgr.getSession(sessionId), handoffMsgStart);
      if (partial) {
        finalStatus = 'idle';
        const value = {
          tag,
          sessionId,
          agent: session.agent || null,
          provider: session.provider,
          model: session.model,
          content: partial,
          stallAbort: true,
        };
        if (job) job._terminalResultValue = value;
        reconcileJobWatchdogPartial(job, value);
        return value;
      }
      finalStatus = 'error';
      reconcileJobStreamStalled(job, error);
      throw error;
    } finally {
      turnReview.complete();
      watchdog?.stop?.();
      upsertWorkerSessionDeferred(session, tag, {
        status: finalStatus,
        stage: finalStatus,
        finishedAt: new Date().toISOString(),
      });
      reconcileJobFinally(job, finalStatus);
      scheduleReap(sessionId);
      // Same lifecycle as a fresh spawn: the transcript/tag stays resumable,
      // while heavy process-local runtime state is reclaimed immediately.
      try { mgr.unloadSessionRuntime?.(sessionId, 'agent-turn-complete'); } catch {}
    }
  }

  async function send(args) {
    return await runSend(await prepareSend(args));
  }

  // Shared send dispatch for an already-resolved live session. Used by the
  // `send` branch AND by the `spawn` branch when an explicit tag maps to a
  // live session (reuse path). Busy sessions queue the prompt; idle ones run a
  // background send job that continues the existing session (context kept).
  function dispatchToExistingSession(prepared, notifyContext, extras = {}) {
    if (isSessionBusy(prepared.sessionId) && typeof mgr.enqueuePendingMessage === 'function') {
      const queueDepth = mgr.enqueuePendingMessage(prepared.sessionId, prepared.prompt);
      return renderResult({
        queued: true,
        ...extras,
        tag: tagForSession(prepared.sessionId),
        sessionId: prepared.sessionId,
        agent: prepared.session.agent || null,
        queueDepth,
      });
    }
    const job = startJob('send', {
      tag: tagForSession(prepared.sessionId),
      sessionId: prepared.sessionId,
      agent: prepared.session.agent || null,
      provider: prepared.session.provider || null,
      model: prepared.session.model || null,
      preset: prepared.session.presetName || null,
      effort: prepared.session.effort || null,
      fast: prepared.session.fast === true,
    }, (job, ownerNotifyContext) => runSend(prepared, ownerNotifyContext, job), notifyContext);
    return renderResult({ ...extras, ...renderJob(job, false) });
  }

  function close(args, context = {}) {
    const scopedContext = agentScope(args, context);
    refreshTagsFromSessions({ scanSessions: wantsSessionScan(args), context: scopedContext });
    const taskId = taskIdFromArgs(args);
    const task = taskId ? getBackgroundTask(taskId, { surface: 'agent', context }) : null;
    const taskMeta = task?.meta || {};
    const target = clean(args.tag || args.sessionId || taskMeta.sessionId);
    if (!target) {
      if (task?.taskId) {
        cancelBackgroundTask(task.taskId, 'cancelled by agent close');
        return { closed: true, tag: taskMeta.tag || null, sessionId: null, task_id: task.taskId };
      }
      throw new Error('agent close: tag or sessionId is required');
    }
    const sessionId = resolveTag(target, scopedContext, { scanSessions: wantsSessionScan(args) });
    if (!sessionId) {
      if (!target.startsWith('sess_') && tagAgents.has(target)) {
        // This is only stale local metadata: resolveTag found no session in
        // this terminal/scope, so there is no sessionId-safe worker row to
        // delete. Never turn it into a tag-wide persisted-row removal.
        tags.delete(target);
        tagAgents.delete(target);
        tagCwds.delete(target);
        if (task?.taskId) cancelBackgroundTask(task.taskId, 'cancelled by agent close');
        return { closed: true, forgotten: true, tag: target, sessionId: null, task_id: task?.taskId || null };
      }
      throw new Error(`agent close: target "${target}" not found`);
    }
    if (isLeadPoolAgent(getLiveSession(sessionId)?.agent)) {
      throw new Error(`agent close: target "${target}" is a Lead session`);
    }
    cancelReap(sessionId);
    const tag = tagForSession(sessionId);
    clearAgentStatuslineRoute(sessionId);
    // Cancel any running background task bound to this session BEFORE closing
    // the session. Otherwise closeSession rejects the in-flight runSpawn with
    // "Session closed: closeSession" and the catch path reconciles the task as
    // `failed` — a user-initiated close must surface as `cancelled` instead.
    // (The explicit task_id path below stays as a no-op fallback: cancel is
    // idempotent once terminal.)
    for (const row of listBackgroundTasks({ surface: 'agent', context: scopedContext })) {
      if (row.sessionId !== sessionId && row.tag !== target) continue;
      cancelBackgroundTask(row.task_id, 'cancelled by agent close');
    }
    // Close (and stamp cancelStatus) BEFORE dropping the worker row. Removing
    // the row first left the next pool read with only a leftover heartbeat,
    // which republished the session as `running`.
    const ok = mgr.closeSession(sessionId, 'cli-agent-close');
    if (task?.taskId) cancelBackgroundTask(task.taskId, 'cancelled by agent close');
    forgetTerminalSession(tag, sessionId);
    return { closed: ok, tag, sessionId, task_id: task?.taskId || null };
  }

  function cleanup(args = {}, context = {}) {
    const scopedContext = agentScope(args, context);
    const beforeTags = tags.size;
    refreshTagsFromSessions({ scanSessions: wantsSessionScan(args), context: scopedContext });
    const cleaned = cleanupBackgroundTasks({ surface: 'agent', context: scopedContext, force: args.force === true });
    return {
      tasksRemoved: cleaned.removed,
      tagsRemoved: beforeTags - tags.size,
      tasks: listJobs(scopedContext).length,
      // Cleanup reports how many worker rows remain known (idle/terminal
      // included); only the /agents worker section hides terminal rows.
      workers: list({ scanSessions: wantsSessionScan(args), context: scopedContext, includeTerminal: true }).length,
    };
  }

  function closeAll(reason = 'cli-agent-close-all', scope = {}) {
    // Scoped teardown (one Lead closing/deleting/switching) must close ONLY
    // that Lead's workers: the worker index and task registry are shared by
    // every Lead in the process, and the old unscoped sweep wiped sibling
    // Leads' idle workers mid-window (user: 유휴시간이 남았는데 목록이 날아감).
    const ownerSessionId = clean(scope.callerSessionId);
    const context = ownerSessionId ? { callerSessionId: ownerSessionId } : {};
    refreshTagsFromSessions({ scanSessions: false, context });
    const closed = [];
    const failed = [];
    for (const { tag, session } of agentSessionEntries({ scanSessions: false, context })) {
      try {
        closed.push(close({ sessionId: session.id }, context));
      } catch (err) {
        failed.push({ tag, error: presentErrorText(err, { surface: 'agent' }) });
      }
    }
    for (const task of listBackgroundTasks({ surface: 'agent', ...(ownerSessionId ? { context } : {}) })) {
      if (task?.status !== 'running') continue;
      cancelBackgroundTask(task.task_id, reason);
      closed.push({ closed: true, tag: task.tag || null, sessionId: task.sessionId || null, task_id: task.task_id });
    }
    if (!ownerSessionId) {
      for (const timer of reapTimers.values()) clearTimeout(timer);
      reapTimers.clear();
      tags.clear();
      tagAgents.clear();
      tagCwds.clear();
    }
    const closedSessionIds = new Set(closed.map((row) => clean(row.sessionId)).filter(Boolean));
    flushWorkerIndexMutations();
    writeWorkerRows((byKey, tombstonesByKey) => {
      for (const [key, row] of [...byKey.entries()]) {
        if (isLeadPoolAgent(row.agent)) continue;
        if (ownerSessionId
          && clean(row.ownerSessionId) !== ownerSessionId
          && !closedSessionIds.has(clean(row.sessionId))) continue;
        byKey.delete(key);
      }
      if (!ownerSessionId) tombstonesByKey.clear();
    });
    return { closed, failed };
  }

  // True when a tag has a lingering worker-index / role trace but no live
  // session in this terminal (finished worker still inside the reap grace window).
  function terminalWorkerRowForTag(tag, context = {}) {
    const value = clean(tag);
    if (!value) return null;
    return readWorkerRows(context).find((row) => {
      if (clean(row.tag) !== value) return false;
      if (!isTerminalWorkerStatus(row.status || row.stage)) return false;
      if (getLiveSession(clean(row.sessionId))) return false;
      return true;
    }) || null;
  }

  function hasTerminalTrace(tag, context = {}) {
    const value = clean(tag);
    if (!value || value.startsWith('sess_')) return false;
    if (resolveTag(value, context, { excludeTerminalTraces: true })) return false; // live -> reuse, not trace
    return Boolean(terminalWorkerRowForTag(value, context));
  }

  function reapTerminalTraceForTag(tag, context = {}) {
    const value = clean(tag);
    if (!value || value.startsWith('sess_')) return false;
    const row = terminalWorkerRowForTag(value, context);
    if (!row) return false;
    refreshTagsFromSessions({ context });
    const sessionId = clean(row.sessionId);
    if (sessionId) cancelReap(sessionId);
    forgetTerminalSession(value, sessionId);
    return true;
  }

  async function execute(args = {}, context = {}) {
    try {
      await awaitKeychainPrewarm();
      const type = clean(args.type) || 'spawn';
      const callerCwd = clean(context.cwd || context.callerCwd);
      const scopedContext = agentScope(args, context);
      const notifyContext = context;
      if (type === 'list') return renderResult({ workers: list({ scanSessions: wantsSessionScan(args), context: scopedContext }), jobs: listJobs(scopedContext) });
      if (type === 'status') return renderResult(renderJob(getJobOrWorker(args, scopedContext), false));
      if (type === 'read') return renderResult(renderJob(getJobOrWorker(args, scopedContext), true));
      if (type === 'cleanup') return renderResult(cleanup(args, scopedContext));
      if (type === 'cancel') return renderResult(close(args, scopedContext));
      if (type === 'close') return renderResult(close(args, scopedContext));
      if (type === 'send') {
        try {
          const prepared = await prepareSend(args, scopedContext);
          return dispatchToExistingSession(prepared, notifyContext);
        } catch (err) {
          // Reaped/dead-tag fallback: with the 5m terminal-reap window a
          // same-scope follow-up often lands after the session is gone.
          // Instead of bouncing an error back to Lead (who would just
          // re-issue the same content as a spawn), respawn a FRESH session
          // under the same tag with the message as its brief. `respawned:
          // true` in the result tells Lead the worker has no prior session
          // context — re-supply anchors on the next send if needed.
          // Only tag-addressed sends fall back; explicit sessionId sends
          // keep erroring (caller pinned a specific session on purpose).
          const fallbackTag = clean(args.tag);
          const isDeadTarget = /not found|is closed/i.test(String(err?.message || ''));
          if (!fallbackTag || fallbackTag.startsWith('sess_') || !isDeadTarget) throw err;
          const prompt = await resolvePrompt(args, callerCwd || defaultCwd);
          // A retained row or reap tombstone proves that this terminal owned
          // the tag. Unknown tags stay errors even when the caller supplies an
          // agent/cwd: typo absorption requires persisted same-tag evidence.
          // Absorption identity is always terminal-local, even when live
          // resolution was explicitly requested across all terminals.
          const ownershipContext = context;
          let inheritedRow = null;
          try {
            inheritedRow = readWorkerRows(ownershipContext).find((row) => clean(row.tag) === fallbackTag) || null;
          } catch { inheritedRow = null; }
          const inheritedTombstone = tagTombstoneForTag(fallbackTag, ownershipContext);
          const explicitAgent = clean(args.agent);
          // A local proof wins even if another terminal also owns this tag.
          // With no local proof, foreign rows/tombstones and unknown tags are
          // both non-absorbable and retain the original not-found error.
          if (!inheritedRow && !inheritedTombstone) throw err;
          const inheritedSessionId = clean(inheritedRow?.sessionId);
          const inheritedAgent = explicitAgent || clean(inheritedRow?.agent) || clean(inheritedTombstone?.agent);
          const inheritedCwd = clean(args.cwd) || clean(inheritedRow?.cwd) || clean(inheritedTombstone?.cwd) || clean(callerCwd);
          if (!inheritedAgent || !inheritedCwd) throw err;
          // Drop this terminal's in-memory trace and remove ONLY the persisted
          // row matching inheritedRow.sessionId. Do NOT call forgetTag here: it
          // does a tag-wide removeWorkerRow({tag,sessionId}) (L556) whose OR
          // match (L395) would delete peer terminals' same-tag rows. The map
          // deletes are guarded on the tag pointing at OUR sessionId so a peer
          // cache entry (see above) is left intact (it rebuilds from rows).
          if (tags.get(fallbackTag) === inheritedSessionId) {
            try { tags.delete(fallbackTag); tagAgents.delete(fallbackTag); tagCwds.delete(fallbackTag); } catch {}
          }
          if (inheritedSessionId) { try { removeWorkerRow({ sessionId: inheritedSessionId }); } catch {} }
          if (inheritedTombstone) consumeTagTombstone(inheritedTombstone);
          const spawnArgs = {
            ...args,
            type: 'spawn',
            tag: fallbackTag,
            prompt,
            message: undefined,
            agent: inheritedAgent,
            ...(inheritedCwd ? { cwd: inheritedCwd } : {}),
          };
          const job = startDeferredSpawnJob(spawnArgs, callerCwd, context, notifyContext, { respawned: true });
          return renderResult(renderJob(job, false));
        }
      }
      if (type === 'spawn') {
        // Explicit-tag spawn priority (auto nextTag always creates a fresh session):
        //   1) live + busy -> queue the prompt (reuse)
        //   2) live + idle -> continue existing session (reuse)
        //   3) lingering terminal trace -> reap trace and fresh spawn under same tag
        //   4) genuinely new tag -> fresh deferred spawn
        const explicitTag = clean(args.tag);
        let respawned = false;
        let spawnArgs = args;
        if (explicitTag) {
          // Resolve a LIVE same-tag session in this terminal (busy or idle).
          let liveSessionId = null;
          try {
            liveSessionId = resolveTag(explicitTag, scopedContext, {
              scanSessions: wantsSessionScan(args),
              excludeTerminalTraces: true,
            });
          } catch {
            // Ambiguous across terminals — fall through to the normal spawn
            // path which surfaces the same error consistently.
            liveSessionId = null;
          }
          if (liveSessionId && getLiveSession(liveSessionId)) {
            // Reuse the existing session via the send path (context preserved).
            const prepared = await prepareSend({ ...args, tag: explicitTag }, scopedContext);
            return dispatchToExistingSession(prepared, notifyContext, { reused: true });
          }
          if (hasTerminalTrace(explicitTag, scopedContext)) {
            reapTerminalTraceForTag(explicitTag, scopedContext);
            respawned = true;
          } else {
            // Tombstone inheritance never honors allTerminals/global scope.
            const tombstone = tagTombstoneForTag(explicitTag, context);
            if (tombstone) {
              consumeTagTombstone(tombstone);
              spawnArgs = {
                ...args,
                agent: clean(args.agent) || clean(tombstone.agent),
                ...(clean(args.cwd) || !clean(tombstone.cwd) ? {} : { cwd: tombstone.cwd }),
              };
              respawned = true;
            } else {
              const foreignTombstone = readAllTagTombstones().find((row) => (
                clean(row.tag) === explicitTag && !rowMatchesContext(row, context)
              ));
              if (foreignTombstone) {
                throw new Error(`agent spawn: tag "${explicitTag}" belongs to another terminal`);
              }
            }
          }
        }
        const job = startDeferredSpawnJob(
          spawnArgs,
          callerCwd,
          context,
          notifyContext,
          respawned ? { respawned: true } : {},
        );
        return renderResult(renderJob(job, false));
      }
      throw new Error(`agent: unknown type "${type}"`);
    } catch (err) {
      return errorLine(err, { surface: 'agent' });
    }
  }

  return {
    tools: [AGENT_TOOL],
    execute,
    onStatusChange: (listener) => {
      if (typeof listener !== 'function') return () => {};
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    getStatus: (context = {}) => {
      if (!isKeychainPrewarmReady()) {
        void awaitKeychainPrewarm();
        return { workers: [], jobs: [], scope: null };
      }
      const scopedContext = agentScope({}, context);
      const ownerSession = callerSessionForContext(scopedContext);
      const pid = terminalPidForContext(scopedContext);
      return {
        workers: list({ scanSessions: false, context: scopedContext }),
        jobs: listJobs(scopedContext),
        scope: ownerSession
          ? { sessionId: ownerSession }
          : pid ? { clientHostPid: pid } : { allTerminals: true },
      };
    },
    recoverWorkers: (context = {}) => {
      if (!isKeychainPrewarmReady()) {
        void awaitKeychainPrewarm();
        return [];
      }
      const scopedContext = agentScope({ recover: true }, context);
      refreshTagsFromSessions({ scanSessions: true, context: scopedContext });
      return list({ scanSessions: false, context: scopedContext });
    },
    upsertLeadSession,
    closeAll,
  };
}
