/**
 * agent-tool/spawn-flow/spawn-run.mjs — one prepared worker's turn: the
 * progress-idle watchdog with its worker-row stampers, turn-review
 * collection, the terminal completion value (abnormal-empty finishes
 * promoted to errors), watchdog partial handoff, and terminal accounting.
 */
import { createNotify } from '../notify.mjs';
import {
  reconcileJobFinally,
  reconcileJobStreamStalled,
  reconcileJobTerminalResult,
  reconcileJobWatchdogPartial,
} from '../job-task-reconcile.mjs';
import { abnormalEmptyFinishError } from '../render.mjs';
import { createProgressWatchdogRegistry } from '../../agent-watchdog-registry.mjs';
import {
  resolveHandoffMessageStartIndex,
  watchdogPartialHandoffFromError,
} from '../../../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';
import { saveSessionAsync } from '../../../runtime/agent/orchestrator/session/store.mjs';
import { presetDescriptor } from './spawn-prep.mjs';

// Mid-turn worker persistence cadence. The watchdog sweep runs every second;
// a transcript save is far more expensive than a bookkeeping stamp, so the
// in-progress snapshot lands on this slower clock.
const AGENT_PROGRESS_SAVE_MS = 2_000;

export function createSpawnRunner({
  mgr,
  upsertWorkerSessionDeferred,
  notifyStatusChange = () => {},
  notifySessionCompletion,
  emitSubagentEvent,
  scheduleReap,
  sessionSurface = null,
  createTurnReviewCollector,
}) {
  // Owner/worker completion notification lives in ../notify.mjs.
  const { workerNotifyFn, notifyOwnerAgentCompletionEarly } = createNotify(mgr, { notifySessionCompletion });

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
        stage: progress.stage || 'running',
        ...(messages > 0 ? { messages } : {}),
      });
      // The canonical runtime owns persistence; this session is only its descriptor.
      if (sessionSurface?.canonical === true) return;
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
      } catch {
        /* progress persistence is best-effort */
      }
    };
  };

  // Promote an abnormal finish (iteration cap, truncation, or a public agent's
  // empty terminal turn) to an explicit error, so the Lead receives it as a
  // failure with an accurate reason instead of a silent `completed` empty
  // result. Keyed off loop.mjs terminationReason; hidden agents finishing
  // normally-empty are left untagged (benign).
  const completionValueFor = (prepared) => (result) => {
    const { tag, session, agent, preset, presetName } = prepared;
    const abnormalError = abnormalEmptyFinishError(result, agent);
    return {
      tag,
      sessionId: session.id,
      ...presetDescriptor(agent, preset, presetName),
      content: result?.content || '',
      ...(sessionSurface?.canonical === true ? { handoffOnly: true } : {}),
      ...(abnormalError ? { error: abnormalError } : {}),
    };
  };

  async function runTurn(prepared, turnHooks) {
    const { args, session, prompt, workerCwd } = prepared;
    if (typeof sessionSurface?.runTurn === 'function' && sessionSurface.canRun?.(session) !== false) {
      return sessionSurface.runTurn({ session, prompt, context: args.context || null, cwd: workerCwd, ...turnHooks });
    }
    return mgr.askSession(session.id, prompt, args.context || null, null, workerCwd, null, turnHooks);
  }

  async function runSpawn(prepared, notifyContext = null, job = null) {
    const { tag, session, agent, preset, presetName, watchdogPolicy } = prepared;
    const watchdog = startProgressIdleWatchdog(session.id, watchdogPolicy, agent, {
      onTurnStart: turnStartStamper(session, tag),
      onProgress: progressStamper(session, tag),
    });
    const turnReview = createTurnReviewCollector(session, tag, agent, notifyContext || {});
    const completionValue = completionValueFor(prepared);
    let finalStatus = 'idle';
    // SubagentStart: a worker session is about to run its first turn.
    emitSubagentEvent('start', agent, { session_id: session.id, tag });
    upsertWorkerSessionDeferred(session, tag, {
      ...presetDescriptor(agent, preset, presetName),
      status: 'running',
      stage: 'running',
      turnStartedAt: new Date().toISOString(),
    });
    notifyStatusChange();
    let handoffMsgStart = 0;
    try {
      handoffMsgStart = resolveHandoffMessageStartIndex(mgr.getSession(session.id));
      const turnHooks = {
        notifyFn: workerNotifyFn(session.id, notifyContext || {}),
        onToolResult: (message) => turnReview.onToolResult(message),
        ...(job
          ? {
              onTerminalResult: (terminalResult) => {
                turnReview.complete();
                const value = completionValue(terminalResult);
                job._terminalResultValue = value;
                notifyOwnerAgentCompletionEarly(job, value, notifyContext || {});
                reconcileJobTerminalResult(job, value);
              },
            }
          : {}),
      };
      const result = await runTurn(prepared, turnHooks);
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
          ...presetDescriptor(agent, preset, presetName),
          content: partial,
          stallAbort: true,
        };
        if (job) job._terminalResultValue = value;
        reconcileJobWatchdogPartial(job, value);
        return value;
      }
      if (job?.status === 'cancelled') {
        finalStatus = 'cancelled';
        throw error;
      }
      finalStatus = 'error';
      reconcileJobStreamStalled(job, error);
      throw error;
    } finally {
      turnReview.complete();
      watchdog?.stop?.();
      upsertWorkerSessionDeferred(session, tag, {
        ...presetDescriptor(agent, preset, presetName),
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
      try {
        mgr.unloadSessionRuntime?.(session.id, 'agent-turn-complete');
      } catch {}
    }
  }

  return {
    workerNotifyFn,
    notifyOwnerAgentCompletionEarly,
    progressWatchdogs,
    startProgressIdleWatchdog,
    turnStartStamper,
    progressStamper,
    runSpawn,
  };
}
