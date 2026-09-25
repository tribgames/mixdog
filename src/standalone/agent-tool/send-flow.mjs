import {
  resolveAgentWatchdogPolicy,
  resolveHandoffMessageStartIndex,
  watchdogPartialHandoffFromError,
} from '../../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';
import { clean, normalizeAgentName, resolvePrompt } from './helpers.mjs';
import { abnormalEmptyFinishError, renderResult } from './render.mjs';
import {
  reconcileJobFinally,
  reconcileJobStreamStalled,
  reconcileJobWatchdogPartial,
  terminalResultHook,
} from './job-task-reconcile.mjs';
import { createTurnReviewCollector } from './turn-review.mjs';

// `send` to an existing worker: resolve the live session, run one follow-up
// turn under the progress watchdog, and reconcile the job/worker row. Busy
// sessions queue the prompt instead.
export function createSendFlow({ mgr, defaultCwd, sessionSurface, canUseSessionSurface, registry, views, spawnFlow }) {
  async function prepareSend(args, context = {}) {
    registry.refreshTagsFromSessions({ scanSessions: registry.wantsSessionScan(args), context });
    const target = clean(args.tag || args.sessionId);
    if (!target) throw new Error('agent send: tag or sessionId is required');
    const sessionId = registry.resolveTag(target, context, { scanSessions: registry.wantsSessionScan(args) });
    if (!sessionId) throw new Error(`agent send: target "${target}" not found`);
    const session = mgr.getSession(sessionId);
    if (!session || session.closed) throw new Error(`agent send: session "${sessionId}" is closed`);
    registry.cancelReap(sessionId);
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
        tag,
        sessionId,
        agent: session.agent || null,
        provider: session.provider,
        model: session.model,
        content: result?.content || '',
        ...(sessionSurface?.canonical === true ? { handoffOnly: true } : {}),
        ...(abnormalError ? { error: abnormalError } : {}),
      };
    };
  }

  function buildTurnHooks({ sessionId, notifyContext, job, turnReview, completionValue }) {
    const hooks = {
      notifyFn: spawnFlow.workerNotifyFn(sessionId, notifyContext || {}),
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

  function runTurn({ session, sessionId, prompt, args }, turnHooks) {
    const cwd = session.cwd || defaultCwd;
    if (canUseSessionSurface(session)) {
      return sessionSurface.runTurn({ session, prompt, context: args.context || null, cwd, ...turnHooks });
    }
    return mgr.askSession(sessionId, prompt, args.context || null, null, cwd, null, turnHooks);
  }

  async function runSend(prepared, notifyContext = null, job = null) {
    const { args, session, sessionId } = prepared;
    const sendAgent = session.agent || normalizeAgentName(args.agent);
    const tag = registry.tagForSession(sessionId);
    // Queued sends run as follow-up turns inside this same askSession call;
    // the watchdog sweep re-stamps turnStartedAt at each turn boundary.
    const watchdog = spawnFlow.startProgressIdleWatchdog(sessionId, resolveAgentWatchdogPolicy(sendAgent), sendAgent, {
      onTurnStart: spawnFlow.turnStartStamper(session, tag),
      onProgress: spawnFlow.progressStamper(session, tag),
    });
    const turnReview = createTurnReviewCollector(session, tag, sendAgent, notifyContext || {});
    const completionValue = completionValueFor({ session, tag, sessionId, sendAgent });
    let finalStatus = 'idle';
    registry.upsertWorkerSessionDeferred(session, tag, {
      status: 'running',
      stage: 'running',
      turnStartedAt: new Date().toISOString(),
    });
    let handoffMsgStart = 0;
    try {
      handoffMsgStart = resolveHandoffMessageStartIndex(mgr.getSession(sessionId));
      const turnHooks = buildTurnHooks({ sessionId, notifyContext, job, turnReview, completionValue });
      const result = await runTurn(prepared, turnHooks);
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
      registry.upsertWorkerSessionDeferred(session, tag, {
        status: finalStatus,
        stage: finalStatus,
        finishedAt: new Date().toISOString(),
      });
      reconcileJobFinally(job, finalStatus);
      registry.scheduleReap(sessionId);
      // Same lifecycle as a fresh spawn: the transcript/tag stays resumable,
      // while heavy process-local runtime state is reclaimed immediately.
      try {
        mgr.unloadSessionRuntime?.(sessionId, 'agent-turn-complete');
      } catch {}
    }
  }

  // Shared send dispatch for an already-resolved live session. Used by the
  // `send` branch AND by the `spawn` branch when an explicit tag maps to a
  // live session (reuse path). Busy sessions queue the prompt; idle ones run a
  // background send job that continues the existing session (context kept).
  async function dispatchToExistingSession(prepared, notifyContext, extras = {}) {
    const { session, sessionId, prompt } = prepared;
    const tag = registry.tagForSession(sessionId);
    if (canUseSessionSurface(session) && views.isSessionBusy(sessionId)) {
      const queued = await sessionSurface.enqueueTurn({ session, prompt, context: prepared.args.context || null });
      if (queued) {
        return renderResult({ queued: true, ...extras, tag, sessionId, agent: session.agent || null, ...queued });
      }
    }
    if (
      !canUseSessionSurface(session) &&
      views.isSessionBusy(sessionId) &&
      typeof mgr.enqueuePendingMessage === 'function'
    ) {
      const queueDepth = mgr.enqueuePendingMessage(sessionId, prompt);
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
      },
      (job, ownerNotifyContext) => runSend(prepared, ownerNotifyContext, job),
      notifyContext
    );
    return renderResult({ ...extras, ...views.renderJob(job, false) });
  }

  return { prepareSend, dispatchToExistingSession };
}
