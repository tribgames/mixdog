import {
  isAgentProgressWatchdogAbortError,
  noteStoppedShellJobsOnError,
  resolveAgentWatchdogPolicy,
  resolveHandoffMessageStartIndex,
  turnPartialHandoff,
  watchdogPartialHandoffFromError,
  watchdogStoppedHandoff,
} from '../../../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';
import { reconcileAgentSession } from '../../../runtime/agent/orchestrator/agent-runtime/session-builder.mjs';
import {
  agentPresetName,
  clean,
  normalizeAgentName,
  presetKey,
  readAgentFrontmatterPermission,
  resolvePrompt,
} from './helpers.mjs';
import { normalizeAgentPermission } from '../../../runtime/shared/markdown-frontmatter.mjs';
import { resolveAgentSessionPermission } from '../../../runtime/agent/orchestrator/internal-agents.mjs';
import { resolveAgentSpawnPreset } from './spawn-preset.mjs';
import { flushPendingSessionConfigWrites } from '../../config-lifecycle/config-writers.mjs';
import { AGENT_ROUTE_KEYS } from '../../agent-profile-changes.mjs';
import { abnormalEmptyFinishError, renderResult } from './render.mjs';
import {
  reconcileJobCancelled,
  reconcileJobFinally,
  reconcileJobStreamStalled,
  reconcileJobWatchdogPartial,
  terminalResultHook,
} from './job-task-reconcile.mjs';
import { createTurnReviewCollector } from './turn-review.mjs';
import { handoffContent } from '../../handoff-attachments.mjs';
import { rebindDelegation } from '../../../runtime/agent/orchestrator/session/human-gate/delegation.mjs';
import { settledWorkerStatus } from './worker-index/row-liveness.mjs';
import { whileTurnDispatched } from '../../../runtime/agent/orchestrator/session/manager/runtime-state.mjs';
import { takeStoppedShellJobs } from '../../../runtime/agent/orchestrator/session/manager/turn-reap.mjs';
import { turnReportText } from '../../../runtime/agent/orchestrator/session/loop/turn-report.mjs';

function workerResultIdentity({ session, tag, sessionId }) {
  return { tag, sessionId, agent: session.agent || null, provider: session.provider, model: session.model };
}

/** A reused worker runs with the permission its agent's definition grants
 *  now, resolved as a spawn resolves it (spawn-plan.mjs). */
export function followAgentPermission(session, { dataDir, sourceRoot }) {
  const agent = normalizeAgentName(session?.agent);
  if (!agent || !dataDir) return;
  const defined = normalizeAgentPermission(readAgentFrontmatterPermission(agent, dataDir, sourceRoot));
  const permission = resolveAgentSessionPermission(agent, defined || null);
  if (permission) session.permission = permission;
  else delete session.permission;
}

// `send` to an existing worker: resolve the live session, run one follow-up
// turn under the progress watchdog, and reconcile the job/worker row. Busy
// sessions queue the prompt instead.
export function createSendFlow({
  mgr,
  cfgMod = null,
  dataDir = null,
  STANDALONE_SOURCE_ROOT = null,
  defaultCwd,
  sessionSurface,
  canUseSessionSurface,
  registry,
  views,
  spawnFlow,
}) {
  async function prepareSend(args, context = {}) {
    registry.refreshTagsFromSessions({ scanSessions: registry.wantsSessionScan(args), context });
    const target = clean(args.tag || args.sessionId);
    if (!target) throw new Error('agent send: tag or sessionId is required');
    const sessionId = registry.resolveTag(target, context, { scanSessions: registry.wantsSessionScan(args) });
    if (!sessionId) throw new Error(`agent send: target "${target}" not found`);
    const session = mgr.getSession(sessionId);
    if (!session || session.closed) throw new Error(`agent send: session "${sessionId}" is closed`);
    const prompt = await resolvePrompt(args, session.cwd || defaultCwd);
    return { args, session, sessionId, prompt };
  }

  // Same abnormal-empty → error promotion as runSpawn: a reused/`send` worker
  // that hits the cap, truncates, or finishes empty must surface as a failure
  // with an accurate reason, not a silent completed empty.
  function completionValueFor({ session, tag, sessionId, sendAgent }) {
    return (result) => {
      const abnormalError = abnormalEmptyFinishError(result, session.agent || sendAgent);
      return {
        ...workerResultIdentity({ session, tag, sessionId }),
        content: turnReportText(result),
        ...(sessionSurface?.canonical === true ? { handoffOnly: true } : {}),
        ...(abnormalError ? { error: abnormalError } : {}),
      };
    };
  }

  function buildTurnHooks({ sessionId, notifyContext, job, turnReview, completionValue }) {
    const hooks = {
      notifyFn: spawnFlow.workerNotifyFn(sessionId),
      onToolResult: (message) => turnReview.onToolResult(message),
    };
    if (!job) return hooks;
    hooks.onTerminalResult = terminalResultHook({
      job,
      turnReview,
      completionValue,
      notifyEarly: spawnFlow.notifyOwnerAgentCompletionEarly,
      notifyContext,
    });
    return hooks;
  }

  function runTurn({ session, sessionId, prompt: text, args }, turnHooks) {
    const cwd = session.cwd || defaultCwd;
    // The caller's forwarded files ride along as attachment parts.
    const prompt = handoffContent(text, args.attachmentParts);
    return whileTurnDispatched(sessionId, () => {
      if (canUseSessionSurface(session)) {
        return sessionSurface.runTurn({ session, prompt, context: args.context || null, cwd, ...turnHooks });
      }
      // An in-process session has no turn start of its own to reconcile it
      // (a canonical child's runtime does, reconcileTurnSettings): bring its
      // settings-gated tools, connectors, compaction, prompt settings and its
      // agent's permission (as its definition stands: a narrowed one applies)
      // to the settings now.
      reconcileAgentSession(session);
      followAgentPermission(session, { dataDir, sourceRoot: STANDALONE_SOURCE_ROOT });
      return mgr.askSession(sessionId, prompt, args.context || null, null, cwd, null, turnHooks);
    });
  }

  async function runSend(prepared, notifyContext = null, job = null) {
    const { args, session, sessionId } = prepared;
    const sendAgent = session.agent || normalizeAgentName(args.agent);
    const tag = registry.tagForSession(sessionId);
    // Queued sends run as follow-up turns inside this same askSession call;
    // the watchdog sweep re-stamps turnStartedAt at each turn boundary.
    const watchdogPolicy = resolveAgentWatchdogPolicy(
      sendAgent,
      spawnFlow.agentWatchdogOverrides({
        agent: sendAgent,
        provider: session.provider,
        model: session.model,
        ...(session.modelParameters ? { modelParameters: session.modelParameters } : {}),
      })
    );
    const watchdog = spawnFlow.startProgressIdleWatchdog(sessionId, watchdogPolicy, sendAgent, {
      onTurnStart: spawnFlow.turnStartStamper(session, tag),
      onProgress: spawnFlow.progressStamper(session, tag),
    });
    const turnReview = createTurnReviewCollector(session, tag, sendAgent, notifyContext || {});
    const completionValue = completionValueFor({ session, tag, sessionId, sendAgent });
    let finalStatus = 'idle';
    let stalled = false;
    registry.upsertWorkerSessionDeferred(session, tag, {
      status: 'running',
      stage: 'running',
      // The send's own task: a restart that ends this turn reports it by id.
      task_id: job?.taskId,
      turnStartedAt: new Date().toISOString(),
    });
    let handoffMsgStart = 0;
    // A cancelled turn reports the output it produced before it stopped.
    const settleCancelled = (error, result = null) => {
      finalStatus = 'cancelled';
      reconcileJobCancelled(job, {
        ...workerResultIdentity({ session, tag, sessionId }),
        content: turnPartialHandoff(error, mgr.getSession(sessionId), handoffMsgStart) || result?.content || '',
      });
    };
    try {
      handoffMsgStart = resolveHandoffMessageStartIndex(mgr.getSession(sessionId));
      const turnHooks = buildTurnHooks({ sessionId, notifyContext, job, turnReview, completionValue });
      const result = await runTurn(prepared, turnHooks);
      // The early preview does not suppress the canonical body notification;
      // notifyTaskCompletion fires once with output via resolve/reconcile.
      const finalValue = completionValue(result);
      if (job?.status === 'cancelled') {
        settleCancelled(null, result);
        return finalValue;
      }
      if (finalValue.error) {
        finalStatus = 'error';
        if (job) job._terminalResultValue = finalValue;
        throw new Error(finalValue.error);
      }
      return finalValue;
    } catch (error) {
      if (job?.status === 'cancelled') {
        settleCancelled(error);
        throw error;
      }
      stalled = isAgentProgressWatchdogAbortError(error);
      const partial = watchdogPartialHandoffFromError(error, mgr.getSession(sessionId), handoffMsgStart);
      if (partial) {
        finalStatus = 'idle';
        const value = {
          ...workerResultIdentity({ session, tag, sessionId }),
          content: watchdogStoppedHandoff(error, partial, await takeStoppedShellJobs(sessionId)),
          stallAbort: true,
        };
        if (job) job._terminalResultValue = value;
        reconcileJobWatchdogPartial(job, value);
        return value;
      }
      finalStatus = 'error';
      noteStoppedShellJobsOnError(error, await takeStoppedShellJobs(sessionId));
      reconcileJobStreamStalled(job, error, workerResultIdentity({ session, tag, sessionId }));
      throw error;
    } finally {
      turnReview.complete();
      watchdog?.stop?.();
      registry.upsertWorkerSessionDeferred(session, tag, {
        ...settledWorkerStatus(finalStatus, stalled, job),
        finishedAt: new Date().toISOString(),
      });
      reconcileJobFinally(job, finalStatus);
      // Same lifecycle as a fresh spawn: the transcript/tag stays resumable,
      // while heavy process-local runtime state is reclaimed immediately.
      try {
        mgr.unloadSessionRuntime?.(sessionId, 'agent-turn-complete');
      } catch {}
    }
  }

  // An explicit model on a reused tag goes through the session's own route
  // API, which saves it and applies it from the session's next turn: the
  // dispatched prompt when the session is idle, a later one while it is busy.
  async function applyRequestedRoute(prepared) {
    const { session, sessionId, route } = prepared;
    if (!canUseSessionSurface(session) || typeof sessionSurface.setRoute !== 'function') {
      throw new Error(`agent spawn: this surface cannot change the model of reused session "${sessionId}"`);
    }
    await sessionSurface.setRoute({ session, route });
    return { ...prepared, session: mgr.getSession(sessionId) || session };
  }

  // The calling session hands this worker new work (a `send`, or a spawn of its
  // tag): from now on the worker acts as that caller does, so a run's worker
  // asks when the attended chat reuses it and the other way round. Not for a
  // completion wake, which is the worker's own continuation.
  function adoptCaller({ sessionId }, notifyContext) {
    return rebindDelegation(sessionId, notifyContext?.callerSessionId);
  }

  // Shared send dispatch for an already-resolved live session. Used by the
  // `send` branch AND by the `spawn` branch when an explicit tag maps to a
  // live session (reuse path). Busy sessions queue the prompt; idle ones run a
  // background send job that continues the existing session (context kept).
  // A worker that runs on its agent's configured route follows that route, as
  // a bot's home chat does (agent-route-follow.mjs): a model picked for the
  // agent since the spawn applies from this send. A worker started on an
  // explicit model or preset keeps it.
  async function agentRouteToFollow({ session }) {
    const agent = normalizeAgentName(session?.agent);
    if (!agent || !cfgMod?.loadConfig) return null;
    await flushPendingSessionConfigWrites();
    let current;
    try {
      current = resolveAgentSpawnPreset(cfgMod.loadConfig(), { agent });
    } catch {
      return null;
    }
    const spawnedOn = clean(session.presetName || session.preset);
    const own = new Set([`agent-${agent}`, agentPresetName(agent), presetKey(current.preset), current.presetName]);
    if (!spawnedOn || !own.has(spawnedOn)) return null;
    const preset = current.preset;
    if (!preset.provider || !preset.model) return null;
    // Every route key the agent's route sets (an effort or Fast change alone
    // included); a key it leaves unset is the route default either way.
    const value = (key, source) => {
      if (key === 'fast') return source?.fast === true;
      if (key === 'autoEffort') return source?.autoEffort !== false;
      return source?.[key] == null ? null : JSON.stringify(source[key]);
    };
    const set = AGENT_ROUTE_KEYS.filter(
      (key) => key === 'fast' || key === 'autoEffort' || (preset[key] !== undefined && preset[key] !== null)
    );
    const matches = (target) => set.every((key) => value(key, preset) === value(key, target));
    // Against the route the session's next turn runs on: one held for it
    // (heldRoute, an in-process worker that was busy), else its own.
    if (matches(session)) {
      // Saved back to the running route: an earlier hold is obsolete.
      if (session.heldRoute) mgr.holdSessionRoute?.(session.id, null);
      return null;
    }
    if (session.heldRoute && matches({ ...session, ...session.heldRoute })) return null;
    const route = {};
    for (const key of set) {
      if (key === 'fast') route.fast = preset.fast === true;
      else if (key === 'autoEffort') {
        if (preset.autoEffort === false) route.autoEffort = false;
      } else route[key] = preset[key];
    }
    return route;
  }

  async function dispatchToExistingSession(requested, notifyContext, extras = {}) {
    let followed = requested.route ? null : await agentRouteToFollow(requested);
    if (followed && !canUseSessionSurface(requested.session)) {
      // An in-process session takes the followed route in place, between
      // turns; a running one finishes on the route it started on and holds
      // the new one for its next turn, which runs the queued work.
      if (!views.isSessionBusy(requested.sessionId)) {
        const { session } = requested;
        const crossProvider = followed.provider !== session.provider || followed.model !== session.model;
        mgr.updateSessionRoute?.(requested.sessionId, followed, { session, crossProvider });
      } else mgr.holdSessionRoute?.(requested.sessionId, followed);
      followed = null;
    }
    const routed = followed ? { ...requested, route: followed } : requested;
    const prepared = routed.route ? await applyRequestedRoute(routed) : routed;
    const { session, sessionId, prompt } = prepared;
    const tag = registry.tagForSession(sessionId);
    if (canUseSessionSurface(session) && views.isSessionBusy(sessionId)) {
      const queued = await sessionSurface.enqueueTurn({
        session,
        prompt: handoffContent(prompt, prepared.args.attachmentParts),
        context: prepared.args.context || null,
      });
      if (queued) {
        return renderResult({ queued: true, ...extras, tag, sessionId, agent: session.agent || null, ...queued });
      }
    }
    if (
      !canUseSessionSurface(session) &&
      views.isSessionBusy(sessionId) &&
      typeof mgr.enqueuePendingMessage === 'function'
    ) {
      // The queued follow-up keeps the forwarded files, as the canonical queue does.
      const queueDepth = mgr.enqueuePendingMessage(sessionId, handoffContent(prompt, prepared.args.attachmentParts));
      return renderResult({ queued: true, ...extras, tag, sessionId, agent: session.agent || null, queueDepth });
    }
    const job = spawnFlow.startJob(
      'send',
      {
        tag,
        sessionId,
        agent: session.agent || null,
        provider: session.provider || null,
        model: session.model || null,
        preset: session.presetName || null,
        effort: session.effort || null,
        fast: session.fast === true,
        ...(session.autoEffort === false ? { autoEffort: false } : {}),
        ...(extras.resumed === true ? { resumed: true } : {}),
      },
      (job, ownerNotifyContext) => runSend(prepared, ownerNotifyContext, job),
      notifyContext
    );
    return renderResult({ ...extras, ...views.renderJob(job, false) });
  }

  // A background-task completion was queued for this worker. A busy worker
  // takes it at its next tool boundary; an idle one runs a follow-up turn on
  // an empty prompt, which drains the queued completion (never an empty user
  // turn). Its answer reaches the owner like any send result.
  function wakeIdleWorker(sessionId) {
    const id = clean(sessionId);
    if (!id || views.isSessionBusy(id)) return false;
    const session = mgr.getSession(id);
    if (!session || session.closed) return false;
    const owner = clean(session.ownerSessionId || session.parentSessionId);
    const notifyContext = owner
      ? { callerSessionId: owner, ownerSessionId: owner, clientHostPid: session.clientHostPid || null }
      : null;
    void dispatchToExistingSession({ args: {}, session, sessionId: id, prompt: '' }, notifyContext).catch((error) => {
      try {
        process.stderr.write(`[agent] completion wake failed session=${id}: ${error?.message || error}\n`);
      } catch {}
    });
    return true;
  }

  return { prepareSend, adoptCaller, dispatchToExistingSession, wakeIdleWorker };
}
