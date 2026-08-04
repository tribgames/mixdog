// Spawn/job lifecycle, extracted from agent-tool.mjs: job start (foreground
// deferral, admission control), the progress-idle watchdogs, spawn prep
// (provider/session preparation), and the full runSpawn
// execution with turn-review collection and terminal accounting.
import { clean, clearAgentStatuslineRoute, nonNegativeInt, normalizeAgentName, positiveInt, presetKey, readAgentFrontmatterPermission, resolvePrompt, terminalPidForContext, withCwdHeader, writeAgentStatuslineRoute } from './helpers.mjs';
import { createNotify } from './notify.mjs';
import { reconcileBackgroundTask, sanitizeTaskMeta, startBackgroundTask } from '../../runtime/shared/background-tasks.mjs';
import { abnormalEmptyFinishError, renderResult } from './render.mjs';
import { resourceAdmission } from '../../runtime/shared/resource-admission.mjs';
import { createProgressWatchdogRegistry } from '../agent-watchdog-registry.mjs';
import { resolve } from 'node:path';
import { normalizeAgentPermission } from '../../runtime/shared/markdown-frontmatter.mjs';
import { resolveAgentSpawnPreset } from './spawn-preset.mjs';
import { resolveAgentWatchdogPolicy, resolveHandoffMessageStartIndex, watchdogPartialHandoffFromError } from '../../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';
import { prepareAgentSession } from '../../runtime/agent/orchestrator/agent-runtime/session-builder.mjs';
import { AGENT_OWNER } from '../../runtime/agent/orchestrator/agent-owner.mjs';
export function createSpawnFlow({
  mgr,
  forgetTerminalSession,
  pendingSpawnMeta,
  DEFAULT_SPAWN_PREP_TIMEOUT_MS,
  mergeJobMeta,
  preparedSpawnMeta,
  upsertWorkerSessionDeferred,
  refreshTagsFromSessions,
  defaultCwd,
  nextTag,
  cancelReap,
  bindTag,
  emitSubagentEvent,
  scheduleReap,
  cfgMod,
  dataDir,
  STANDALONE_SOURCE_ROOT,
  ensureProvider,
  resolveTag,
  wantsSessionScan,
  createTurnReviewCollector,
}) {
  function closePreparedSpawn(prepared, reason = 'agent-task-cancel') {
    if (!prepared?.session?.id) return;
    try { mgr.closeSession(prepared.session.id, reason); } catch {}
    try { clearAgentStatuslineRoute(prepared.session.id); } catch {}
    forgetTerminalSession(prepared.tag, prepared.session.id);
  }

  // Owner/worker completion notification lives in ./agent-tool/notify.mjs; the
  // factory captures mgr and registers the canonical completion fallback.
  const { workerNotifyFn, notifyOwnerAgentCompletionEarly } = createNotify(mgr);

  function startJob(type, meta, run, notifyContext = null) {
    const clientHostPid = terminalPidForContext(notifyContext);
    const jobMeta = sanitizeTaskMeta({
      ...(meta || {}),
      ...(clientHostPid ? { clientHostPid } : {}),
    });
    let task;
    const admissionController = new AbortController();
    task = startBackgroundTask({
      surface: 'agent',
      operation: type,
      label: jobMeta?.tag || jobMeta?.sessionId || type,
      input: { type, tag: jobMeta?.tag || null, sessionId: jobMeta?.sessionId || null, agent: jobMeta?.agent || null },
      context: notifyContext,
      meta: jobMeta,
      resultType: 'agent_task_result',
      renderResult: (result) => renderResult(result),
      cancel: () => {
        try { admissionController.abort(new Error('agent task cancelled before resource admission')); } catch {}
        const currentMeta = task?.meta || jobMeta;
        if (currentMeta?.sessionId) {
          try { mgr.closeSession(currentMeta.sessionId, 'agent-task-cancel'); } catch {}
        }
      },
      run: async () => {
        const lease = await resourceAdmission.acquire('agent', {
          signal: admissionController.signal,
          label: jobMeta?.tag || type,
        });
        try {
          // Yield one macrotask before doing agent work. startBackgroundTask uses
          // a Promise microtask, which otherwise begins CPU-heavy spawn prep
          // before the TUI receives/render the "running" result.
          await new Promise((resolve) => setImmediate(resolve));
          if (task?.status === 'cancelled') return null;
          return await resourceAdmission.runWithLease(lease, () => run(task));
        } finally {
          await lease.release();
        }
      },
    });
    return task;
  }

  function startDeferredSpawnJob(args, callerCwd, context, notifyContext, extras = {}) {
    return startJob('spawn', pendingSpawnMeta(args, extras), async (job) => {
      if (job?.status === 'cancelled') return null;
      // prepareSpawn (ensureProvider/prepareAgentSession) runs before runSpawn
      // installs its progress watchdog, so guard prep with an internal env-
      // backed cap rather than exposing per-call timeout knobs on the agent
      // tool surface.
      const prepDeadlineMs = nonNegativeInt(args.spawnPrepTimeoutMs ?? args.prepTimeoutMs)
        ?? DEFAULT_SPAWN_PREP_TIMEOUT_MS;
      let prepared;
      const prepState = { timedOut: false };
      if (prepDeadlineMs > 0) {
        let prepTimer = null;
        let timedOut = false;
        // If prep wins the race we use its result. If the timeout wins, the
        // prepareSpawn promise may still resolve later with a fully-built
        // session/tag/route — attach a cleanup so the late-arriving prepared is
        // torn down, otherwise the orphaned tag would collide on re-spawn.
        const prepPromise = prepareSpawn(args, callerCwd, context, prepState);
        prepPromise.then((late) => {
          if (timedOut) closePreparedSpawn(late, 'agent-spawn-prep-timeout');
        }, () => {});
        const timeout = new Promise((_resolve, reject) => {
          prepTimer = setTimeout(() => {
            timedOut = true;
            prepState.timedOut = true;
            reject(new Error(`agent spawn prep timed out (${prepDeadlineMs}ms) before model request`));
          }, prepDeadlineMs);
          prepTimer.unref?.();
        });
        try {
          prepared = await Promise.race([prepPromise, timeout]);
        } finally {
          if (prepTimer) clearTimeout(prepTimer);
        }
      } else {
        prepared = await prepareSpawn(args, callerCwd, context, prepState);
      }
      mergeJobMeta(job, preparedSpawnMeta(prepared, extras));
      upsertWorkerSessionDeferred(prepared.session, prepared.tag, {
        ...preparedSpawnMeta(prepared, extras),
        status: 'running',
        stage: 'running',
        task_id: job.taskId,
        startedAt: job.startedAt,
        turnStartedAt: new Date().toISOString(),
      });
      if (job?.status === 'cancelled') {
        closePreparedSpawn(prepared);
        return null;
      }
      return await runSpawn(prepared, notifyContext, job);
    }, notifyContext);
  }

  // Idle-progress watchdogs (shared sweep timer) live in
  // agent-watchdog-registry.mjs.
  const progressWatchdogs = createProgressWatchdogRegistry({ mgr });
  const startProgressIdleWatchdog = (sessionId, watchdogPolicy, agent = null, options = {}) =>
    progressWatchdogs.start(sessionId, watchdogPolicy, agent, options);

  // Queued `agent type=send` prompts run as follow-up turns INSIDE one
  // askSession call, so the dispatch stamp alone would keep the panel elapsed
  // growing across them. The watchdog sweep reports each turn's start; re-stamp
  // the worker-index row so elapsed resets at the queued-turn boundary.
  const turnStartStamper = (session, tag) => (turnStartedAtMs) => {
    upsertWorkerSessionDeferred(session, tag, {
      status: 'running',
      stage: 'running',
      turnStartedAt: new Date(turnStartedAtMs).toISOString(),
    });
  };

  async function prepareSpawn(args, callerCwd = null, context = {}, prepState = null) {
    refreshTagsFromSessions({ context });
    return prepareSpawnInProcess(args, callerCwd, context, prepState);
  }

  async function prepareSpawnInProcess(args, callerCwd = null, context = {}, prepState = null) {
    const config = cfgMod.loadConfig();
    const agent = normalizeAgentName(args.agent);
    if (!agent) throw new Error('agent spawn: agent is required');
    const agentPermission = readAgentFrontmatterPermission(agent, dataDir, STANDALONE_SOURCE_ROOT);
    const agentPerm = normalizeAgentPermission(agentPermission) || null;
    const { presetName, preset } = resolveAgentSpawnPreset(config, args);
    await ensureProvider(config, preset.provider);
    if (prepState?.timedOut) {
      throw new Error('agent spawn prep timed out before session bind');
    }

    const tag = clean(args.tag) || nextTag(agent, context);
    // Any resolved same-tag binding in this terminal (live or lingering trace)
    // blocks a fresh spawn. execute() routes live reuse before prepareSpawn.
    if (resolveTag(tag, context, { scanSessions: wantsSessionScan(args) })) {
      throw new Error(`agent spawn: tag "${tag}" already exists`);
    }
    const baseCwd = resolve(callerCwd || defaultCwd || process.cwd());
    const workerCwd = clean(args.cwd) ? resolve(baseCwd, args.cwd) : baseCwd;
    const prompt = withCwdHeader(await resolvePrompt(args, workerCwd), workerCwd);
    if (prepState?.timedOut) {
      throw new Error('agent spawn prep timed out before session bind');
    }
    const runtimeSpec = cfgMod.resolveRuntimeSpec(preset, { lane: 'agent', agentId: tag });
    const maxLoopIterations = positiveInt(args.maxLoopIterations) || null;
    const watchdogPolicy = resolveAgentWatchdogPolicy(agent);
    const { session, effectiveCwd } = prepareAgentSession({
      agent,
      presetName,
      preset,
      runtimeSpec,
      owner: AGENT_OWNER,
      cwd: workerCwd,
      sourceType: 'cli',
      sourceName: agent,
      parentSessionId: clean(context?.callerSessionId || context?.sessionId) || null,
      ownerSessionId: clean(context?.callerSessionId || context?.sessionId) || null,
      clientHostPid: terminalPidForContext(context) || null,
      agentTag: tag,
      taskType: clean(args.taskType) || clean(args.typeHint) || undefined,
      maxLoopIterations: maxLoopIterations || undefined,
      permission: agentPerm || undefined,
      cacheKeyOverride: args.cacheKey || undefined,
    });
    // Lead sessions write a gateway-session route when created; agent sessions
    // are built through prepareAgentSession(), so mirror that registration here
    // or the vendored L1/L2 statusline cannot resolve the agent route/model.
    writeAgentStatuslineRoute(session.id, preset);
    bindTag(tag, session, {
      agent,
      preset: presetKey(preset) || presetName,
      provider: preset.provider,
      model: preset.model,
      effort: preset.effort || null,
      fast: preset.fast === true,
      status: 'idle',
      stage: 'idle',
    });
    cancelReap(session.id);
    return {
      args,
      tag,
      session,
      agent,
      preset,
      presetName,
      workerCwd: effectiveCwd || workerCwd,
      prompt,
      maxLoopIterations,
      watchdogPolicy,
    };
  }

  async function runSpawn(prepared, notifyContext = null, job = null) {
    const { args, tag, session, agent, preset, presetName, workerCwd, prompt, watchdogPolicy } = prepared;
    const watchdog = startProgressIdleWatchdog(session.id, watchdogPolicy, agent, {
      onTurnStart: turnStartStamper(session, tag),
    });
    const turnReview = createTurnReviewCollector(session, tag, agent, notifyContext || {});
    let finalStatus = 'idle';
    // SubagentStart: a worker session is about to run its first turn.
    emitSubagentEvent('start', agent, { session_id: session.id, tag });
    upsertWorkerSessionDeferred(session, tag, {
      agent,
      preset: presetKey(preset) || presetName,
      provider: preset.provider,
      model: preset.model,
      effort: preset.effort || null,
      fast: preset.fast === true,
      status: 'running',
      stage: 'running',
      turnStartedAt: new Date().toISOString(),
    });
    let handoffMsgStart = 0;
    try {
      const completionValue = (result) => {
        // Promote an abnormal finish (iteration cap, truncation, or a public
        // agent's empty terminal turn) to an explicit error, so the Lead
        // receives it as a failure with an accurate reason instead of a silent
        // `completed` empty result. Keyed off loop.mjs terminationReason;
        // hidden agents finishing normally-empty are left untagged (benign).
        const abnormalError = abnormalEmptyFinishError(result, agent);
        return {
          tag,
          sessionId: session.id,
          agent,
          preset: presetKey(preset) || presetName,
          provider: preset.provider,
          model: preset.model,
          effort: preset.effort || null,
          fast: preset.fast === true,
          content: result?.content || '',
          ...(abnormalError ? { error: abnormalError } : {}),
        };
      };
      handoffMsgStart = resolveHandoffMessageStartIndex(mgr.getSession(session.id));
      const result = await mgr.askSession(session.id, prompt, args.context || null, null, workerCwd, null, {
        notifyFn: workerNotifyFn(session.id, notifyContext || {}),
        onToolResult: (message) => turnReview.onToolResult(message),
        ...(job ? {
          onTerminalResult: (terminalResult) => {
            turnReview.complete();
            const value = completionValue(terminalResult);
            if (job) job._terminalResultValue = value;
            notifyOwnerAgentCompletionEarly(job, value, notifyContext || {});
            // Mark the task terminal the moment the worker produces its final
            // result, so a hung/slow post-result session save cannot strand the
            // task (and the status card) in `running`. Idempotent; the finally
            // reconcile remains a backup for the error/no-terminal-result path.
            if (job?.taskId) {
              try {
                // An empty/abnormal finish is a failure, not a completion:
                // reconcile as `failed` with the accurate error so the Lead
                // card renders `error: …` instead of a header-only empty card.
                reconcileBackgroundTask(job.taskId, value.error
                  ? {
                      status: 'failed',
                      result: value,
                      error: value.error,
                      terminalReason: 'agent-empty-final',
                    }
                  : {
                      status: 'completed',
                      result: value,
                      terminalReason: 'agent-terminal-result',
                    });
              } catch {}
            }
          },
        } : {}),
      });
      // The early preview no longer promises body suppression, so the canonical
      // notifyTaskCompletion is left to fire exactly once with output via the
      // resolve/reconcile/finally path.
      const finalValue = completionValue(result);
      // Non-job return path (or job path where the terminal-result reconcile
      // already ran): if the finish was abnormal-empty, surface it as a thrown
      // error so finalStatus becomes 'error' and the caller's error path (and
      // the finally reconcile below, as `failed`) render the accurate reason.
      if (finalValue.error) {
        finalStatus = 'error';
        if (job) job._terminalResultValue = finalValue;
        throw new Error(finalValue.error);
      }
      return finalValue;
    } catch (error) {
      const partial = watchdogPartialHandoffFromError(error, mgr.getSession(session.id), handoffMsgStart);
      if (partial) {
        finalStatus = 'idle';
        const value = {
          tag,
          sessionId: session.id,
          agent,
          preset: presetKey(preset) || presetName,
          provider: preset.provider,
          model: preset.model,
          effort: preset.effort || null,
          fast: preset.fast === true,
          content: partial,
          stallAbort: true,
        };
        if (job) job._terminalResultValue = value;
        if (job?.taskId) {
          try {
            reconcileBackgroundTask(job.taskId, {
              status: 'completed',
              result: value,
              terminalReason: 'agent-watchdog-partial',
            });
          } catch {}
        }
        return value;
      }
      finalStatus = 'error';
      // Part C: a mid-stream stall (StreamStalledError / ESTREAMSTALL) throws
      // here WITHOUT a terminal result, so the finally reconcile below (gated on
      // _terminalResultValue) would be skipped and only the outer task-reject
      // path would notify. Belt-and-suspenders: reconcile this job to `failed`
      // now so the owner (Lead) always gets a failure notification instead of a
      // task stranded in `running`. Idempotent — completeBackgroundTask no-ops
      // once terminal, so the outer reject path can't double-notify.
      if (job?.taskId && job._terminalResultValue === undefined) {
        try {
          reconcileBackgroundTask(job.taskId, {
            status: 'failed',
            error,
            terminalReason: 'agent-stream-stalled',
          });
        } catch {}
      }
      throw error;
    } finally {
      turnReview.complete();
      watchdog?.stop?.();
      upsertWorkerSessionDeferred(session, tag, {
        agent,
        preset: presetKey(preset) || presetName,
        provider: preset.provider,
        model: preset.model,
        effort: preset.effort || null,
        fast: preset.fast === true,
        status: finalStatus,
        stage: finalStatus,
        finishedAt: new Date().toISOString(),
      });
      // Safety net: if a post-result step (session save) hung or threw after the
      // worker already produced a terminal result, the task could otherwise be
      // stranded in `running`. Reconcile it to a terminal state using the
      // captured result so the owner gets a completion notification + the
      // statusline clears. Idempotent once the task is already terminal.
      if (job && job._terminalResultValue !== undefined) {
        try {
          reconcileBackgroundTask(job.taskId, {
            status: finalStatus === 'error' ? 'failed' : 'completed',
            result: job._terminalResultValue,
            ...(finalStatus === 'error' && job._terminalResultValue?.error
              ? { error: job._terminalResultValue.error }
              : {}),
            terminalReason: 'agent-finally-reconcile',
          });
        } catch {}
      }
      scheduleReap(session.id);
      // SubagentStop: worker finished (terminal), regardless of outcome.
      emitSubagentEvent('stop', agent, { session_id: session.id, tag, status: finalStatus });
      // Keep the durable session/tag for same-tag follow-ups, but release every
      // process-local provider, shell, watchdog and tool cache immediately.
      try { mgr.unloadSessionRuntime?.(session.id, 'agent-turn-complete'); } catch {}
    }
  }

  return {
    closePreparedSpawn,
    workerNotifyFn,
    notifyOwnerAgentCompletionEarly,
    startJob,
    startDeferredSpawnJob,
    progressWatchdogs,
    startProgressIdleWatchdog,
    turnStartStamper,
    prepareSpawn,
    prepareSpawnInProcess,
    runSpawn,
  };
}
