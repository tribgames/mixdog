// Spawn/job lifecycle, extracted from agent-tool.mjs: job start (foreground
// deferral, admission control), the progress-idle watchdogs, spawn prep
// (provider/session preparation), and the full runSpawn
// execution with turn-review collection and terminal accounting.
import { agentDefinitionExists, clean, clearAgentStatuslineRoute, nonNegativeInt, normalizeAgentName, positiveInt, presetKey, readAgentFrontmatterPermission, resolvePrompt, terminalPidForContext, writeAgentStatuslineRoute } from './helpers.mjs';
import { createNotify } from './notify.mjs';
import { sanitizeTaskMeta, startBackgroundTask } from '../../runtime/shared/background-tasks.mjs';
import {
  reconcileJobFinally,
  reconcileJobStreamStalled,
  reconcileJobTerminalResult,
  reconcileJobWatchdogPartial,
} from './job-task-reconcile.mjs';
import { isAgentDisabled } from '../../runtime/shared/agent-route-config.mjs';
import { abnormalEmptyFinishError, renderResult } from './render.mjs';
import { resourceAdmission } from '../../runtime/shared/resource-admission.mjs';
import { createProgressWatchdogRegistry } from '../agent-watchdog-registry.mjs';
import { resolve } from 'node:path';
import { normalizeAgentPermission } from '../../runtime/shared/markdown-frontmatter.mjs';
import { resolveAgentSpawnPreset } from './spawn-preset.mjs';
import { resolveAgentWatchdogPolicy, resolveHandoffMessageStartIndex, watchdogPartialHandoffFromError } from '../../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';
import { prepareAgentSession } from '../../runtime/agent/orchestrator/agent-runtime/session-builder.mjs';
import { saveSessionAsync } from '../../runtime/agent/orchestrator/session/store.mjs';
import { AGENT_OWNER } from '../../runtime/agent/orchestrator/agent-owner.mjs';
import { getProvider } from '../../runtime/agent/orchestrator/providers/registry.mjs';
// Mid-turn worker persistence cadence. The watchdog sweep runs every second;
// a transcript save is far more expensive than a bookkeeping stamp, so the
// in-progress snapshot lands on this slower clock.
const AGENT_PROGRESS_SAVE_MS = 2_000;

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
  mcpScopeId = null,
  nextTag,
  cancelReap,
  bindTag,
  emitSubagentEvent,
  notifyStatusChange = () => {},
  notifySessionCompletion,
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

  // Owner/worker completion notification lives in ./agent-tool/notify.mjs.
  const { workerNotifyFn, notifyOwnerAgentCompletionEarly } = createNotify(mgr, {
    notifySessionCompletion,
  });

  function startJob(type, meta, run, notifyContext = null) {
    const clientHostPid = terminalPidForContext(notifyContext);
    const ownerSessionId = clean(notifyContext?.callerSessionId || notifyContext?.sessionId);
    const ownerNotifyContext = {
      callerSessionId: ownerSessionId || null,
      clientHostPid: clientHostPid || null,
      notifyFn: ownerSessionId && typeof notifySessionCompletion === 'function'
        ? (text, completionMeta = {}) => notifySessionCompletion(ownerSessionId, text, {
            ...(completionMeta && typeof completionMeta === 'object' ? completionMeta : {}),
            caller_session_id: ownerSessionId,
          })
        : null,
    };
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
      context: ownerNotifyContext,
      meta: jobMeta,
      resultType: 'agent_task_result',
      renderResult: (result) => renderResult(result),
      cancel: () => {
        try { admissionController.abort(new Error('agent task cancelled before resource admission')); } catch {}
        const currentMeta = task?.meta || jobMeta;
        if (currentMeta?.sessionId) {
          try { mgr.closeSession(currentMeta.sessionId, 'agent-task-cancel'); } catch {}
        }
        setImmediate(notifyStatusChange);
      },
      run: async () => {
        const lease = await resourceAdmission.acquire('agent', {
          signal: admissionController.signal,
          label: jobMeta?.tag || type,
          ownerKey: ownerSessionId || clientHostPid || null,
        });
        try {
          // Yield one macrotask before doing agent work. startBackgroundTask uses
          // a Promise microtask, which otherwise begins CPU-heavy spawn prep
          // before the TUI receives/render the "running" result.
          await new Promise((resolve) => setImmediate(resolve));
          if (task?.status === 'cancelled') return null;
          return await resourceAdmission.runWithLease(lease, () => run(task, ownerNotifyContext));
        } finally {
          await lease.release();
          // startBackgroundTask stamps the terminal state in its next promise
          // continuation; publish after that continuation, not before it.
          setImmediate(notifyStatusChange);
        }
      },
    });
    notifyStatusChange();
    return task;
  }

  function startDeferredSpawnJob(args, callerCwd, context, notifyContext, extras = {}) {
    return startJob('spawn', pendingSpawnMeta(args, extras), async (job, ownerNotifyContext) => {
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
      notifyStatusChange();
      if (job?.status === 'cancelled') {
        closePreparedSpawn(prepared);
        return null;
      }
      return await runSpawn(prepared, ownerNotifyContext, job);
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

  // In-turn progress stamp. turnStartStamper only fires at a TURN boundary, so
  // one long first turn (a review agent easily runs 20+ tool iterations) left
  // the worker row untouched for minutes and the panel looked stalled. The
  // watchdog sweep reports each observed change; the row keeps its own live
  // message count and updatedAt from it.
  const progressStamper = (session, tag) => {
    let lastSavedAt = 0;
    return (progress = {}) => {
      const messages = Number(progress?.messages) || 0;
      upsertWorkerSessionDeferred(session, tag, {
        status: 'running',
        stage: 'running',
        ...(messages > 0 ? { messages } : {}),
      });
      // Mid-turn durability. A worker transcript otherwise reaches disk only
      // when the turn ENDS, so a pane opened on a running worker shows the
      // prompt and nothing after it — the work is real but invisible to every
      // viewer. Persisting on the sweep makes the in-progress transcript
      // readable like any other session. Throttled: a transcript save is not
      // free, and the sweep runs every second.
      const now = Date.now();
      if (now - lastSavedAt < AGENT_PROGRESS_SAVE_MS) return;
      lastSavedAt = now;
      try {
        Promise.resolve(saveSessionAsync(session)).catch(() => {});
      } catch { /* progress persistence is best-effort */ }
    };
  };

  async function prepareSpawn(args, callerCwd = null, context = {}, prepState = null) {
    refreshTagsFromSessions({ context });
    return prepareSpawnInProcess(args, callerCwd, context, prepState);
  }

  /** Shared spawn-prep validations (agent/preset/tag/cwd/prompt). */
  async function resolveSpawnPlan(args, callerCwd, context, prepState) {
    const config = cfgMod.loadConfig();
    const agent = normalizeAgentName(args.agent);
    if (!agent) throw new Error('agent spawn: agent is required');
    // Deleted/unknown agents fail here: settings-deleted custom roles would
    // otherwise still spawn as role-less generic agents by remembered name.
    if (!agentDefinitionExists(agent, dataDir, STANDALONE_SOURCE_ROOT)) {
      throw new Error(`agent spawn: unknown agent "${agent}"`);
    }
    // Switched off in settings: the role is dropped from the Lead prompt, so a
    // spawn can only arrive from a stale name. Refuse instead of running it.
    if (isAgentDisabled(config, agent)) {
      throw new Error(`agent spawn: agent "${agent}" is turned off`);
    }
    const agentPermission = readAgentFrontmatterPermission(agent, dataDir, STANDALONE_SOURCE_ROOT);
    const agentPerm = normalizeAgentPermission(agentPermission) || null;
    const { presetName, preset } = resolveAgentSpawnPreset(config, args);
    const tag = clean(args.tag) || nextTag(agent, context);
    // Any resolved same-tag binding in this terminal (live or lingering trace)
    // blocks a fresh spawn. execute() routes live reuse before prepareSpawn.
    if (resolveTag(tag, context, { scanSessions: wantsSessionScan(args) })) {
      throw new Error(`agent spawn: tag "${tag}" already exists`);
    }
    const baseCwd = resolve(callerCwd || defaultCwd || process.cwd());
    const workerCwd = clean(args.cwd) ? resolve(baseCwd, args.cwd) : baseCwd;
    const prompt = await resolvePrompt(args, workerCwd);
    if (prepState?.timedOut) {
      throw new Error('agent spawn prep timed out before session bind');
    }
    return { config, agent, agentPerm, presetName, preset, tag, workerCwd, prompt };
  }

  /** Build the normalized in-process agent session spec. */
  function spawnSessionSpec(plan, args, context) {
    const { agent, agentPerm, presetName, preset, tag, workerCwd } = plan;
    return {
      agent,
      presetName,
      preset,
      runtimeSpec: cfgMod.resolveRuntimeSpec(preset, { lane: 'agent', agentId: tag }),
      owner: AGENT_OWNER,
      cwd: workerCwd,
      sourceType: 'cli',
      sourceName: agent,
      parentSessionId: clean(context?.callerSessionId || context?.sessionId) || null,
      ownerSessionId: clean(context?.callerSessionId || context?.sessionId) || null,
      clientHostPid: terminalPidForContext(context) || null,
      agentTag: tag,
      taskType: clean(args.taskType) || clean(args.typeHint) || undefined,
      maxLoopIterations: positiveInt(args.maxLoopIterations) || undefined,
      permission: agentPerm || undefined,
      cacheKeyOverride: args.cacheKey || undefined,
      mcpScopeId,
    };
  }

  /** Shared post-create wiring. Lead sessions write a gateway-session route on
   *  create; agent sessions are built through prepareAgentSession()/the remote
   *  runtime, so mirror that registration here or the vendored L1/L2
   *  statusline cannot resolve the agent route/model. */
  function bindSpawnedSession(session, plan) {
    const { agent, presetName, preset, tag } = plan;
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
  }

  function preparedSpawnResult(plan, args, session, spec, extra = {}) {
    return {
      args,
      tag: plan.tag,
      session,
      agent: plan.agent,
      preset: plan.preset,
      presetName: plan.presetName,
      workerCwd: plan.workerCwd,
      prompt: plan.prompt,
      maxLoopIterations: spec.maxLoopIterations || null,
      watchdogPolicy: resolveAgentWatchdogPolicy(plan.agent),
      ...extra,
    };
  }

  async function prepareSpawnInProcess(args, callerCwd = null, context = {}, prepState = null) {
    const plan = await resolveSpawnPlan(args, callerCwd, context, prepState);
    await ensureProvider(plan.config, plan.preset.provider);
    if (prepState?.timedOut) {
      throw new Error('agent spawn prep timed out before session bind');
    }
    const spec = spawnSessionSpec(plan, args, context);
    const { session, effectiveCwd } = prepareAgentSession(spec);
    bindSpawnedSession(session, plan);
    // Spawn prewarm builds the materialized stable prompt and keeps the
    // resulting Codex-style client handle reserved for the first turn.
    // Fire-and-forget: failures fall back to the lazy per-send handshake.
    // MIXDOG_AGENT_SPAWN_WS_PREWARM=0 disables.
    maybePrewarmSpawnTransport(plan, session);
    return preparedSpawnResult(
      { ...plan, workerCwd: effectiveCwd || plan.workerCwd },
      args,
      session,
      spec,
    );
  }

  function maybePrewarmSpawnTransport(plan, session) {
    if (process.env.MIXDOG_AGENT_SPAWN_WS_PREWARM === '0') return;
    try {
      const provider = getProvider(plan?.preset?.provider);
      if (typeof provider?.prewarmWsTransportForSession !== 'function') return;
      void Promise.resolve(provider.prewarmWsTransportForSession({
        sessionId: session?.id || null,
        session,
      })).catch(() => {});
    } catch { /* best-effort — the first send owns the lazy handshake */ }
  }

  async function runSpawn(prepared, notifyContext = null, job = null) {
    const { args, tag, session, agent, preset, presetName, workerCwd, prompt, watchdogPolicy } = prepared;
    const watchdog = startProgressIdleWatchdog(session.id, watchdogPolicy, agent, {
      onTurnStart: turnStartStamper(session, tag),
      onProgress: progressStamper(session, tag),
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
    notifyStatusChange();
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
            reconcileJobTerminalResult(job, value);
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
      setImmediate(notifyStatusChange);
      reconcileJobFinally(job, finalStatus);
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
    progressStamper,
    prepareSpawn,
    prepareSpawnInProcess,
    runSpawn,
  };
}
