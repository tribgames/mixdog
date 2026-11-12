/**
 * agent-tool/spawn-flow/spawn-run.mjs — one prepared worker's turn:
 * turn-review collection, the terminal completion value (abnormal-empty
 * finishes promoted to errors), watchdog partial handoff, and terminal
 * accounting. The worker row and the progress watchdog follow the turn
 * itself (../worker-turns.mjs).
 */
import { createNotify } from '../notify.mjs';
import {
  reconcileJobCancelled,
  reconcileJobFinally,
  reconcileJobStreamStalled,
  reconcileJobWatchdogPartial,
  terminalResultHook,
} from '../job-task-reconcile.mjs';
import { abnormalEmptyFinishError } from '../render.mjs';
import {
  noteStoppedShellJobsOnError,
  resolveHandoffMessageStartIndex,
  turnPartialHandoff,
  watchdogPartialHandoffFromError,
  watchdogStoppedHandoff,
} from '../../../../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';
import { presetDescriptor } from './spawn-prep.mjs';
import { handoffContent } from '../../../handoff-attachments.mjs';
import { whileTurnDispatched } from '../../../../runtime/agent/orchestrator/session/manager/runtime-state.mjs';
import { takeStoppedShellJobs } from '../../../../runtime/agent/orchestrator/session/manager/turn-reap.mjs';
import { turnReportText } from '../../../../runtime/agent/orchestrator/session/loop/turn-report.mjs';
import { carrySensitiveValues, redactSensitiveText } from '../../../../runtime/agent/orchestrator/session/sensitive-values.mjs';

export function createSpawnRunner({
  mgr,
  workerTurns,
  notifySessionCompletion,
  emitSubagentEvent,
  sessionSurface = null,
  createTurnReviewCollector,
  onWorkerCompletionQueued = null,
}) {
  // Owner/worker completion notification lives in ../notify.mjs.
  const { workerNotifyFn, notifyOwnerAgentCompletionEarly } = createNotify(mgr, {
    notifySessionCompletion,
    onWorkerCompletionQueued,
  });

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
      // The report leaves the worker: its sensitive values as the marker.
      content: redactSensitiveText(session.id, turnReportText(result)),
      ...(sessionSurface?.canonical === true ? { handoffOnly: true } : {}),
      ...(abnormalError ? { error: abnormalError } : {}),
    };
  };

  async function runTurn(prepared, turnHooks) {
    const { args, session, workerCwd } = prepared;
    // The caller's forwarded files ride along as attachment parts.
    const prompt = handoffContent(prepared.prompt, args.attachmentParts);
    // Host-set only (a routine executor, routine-executor.mjs): the trusted
    // text skills are selected from, so nothing else in the prompt selects one.
    const selection = typeof args.skillSelection === 'string' ? { skillSelection: args.skillSelection } : {};
    return whileTurnDispatched(session.id, () => {
      if (typeof sessionSurface?.runTurn === 'function' && sessionSurface.canRun?.(session) !== false) {
        return sessionSurface.runTurn({
          session,
          prompt,
          context: args.context || null,
          cwd: workerCwd,
          ...selection,
          ...turnHooks,
        });
      }
      return mgr.askSession(session.id, prompt, args.context || null, null, workerCwd, null, {
        ...turnHooks,
        ...selection,
      });
    });
  }

  async function runSpawn(prepared, notifyContext = null, job = null) {
    const { tag, session, agent, preset, presetName } = prepared;
    const turn = workerTurns.claim(session, job);
    const turnReview = createTurnReviewCollector(session, tag, agent, notifyContext || {});
    const completionValue = completionValueFor(prepared);
    // The sessions the turn's report and handoffs reach and whose text its prompt carries: each one's sensitive
    // values follow the text both ways, and the prompt leaves its owners with theirs as the marker.
    for (const owner of [notifyContext?.callerSessionId, session.parentSessionId, notifyContext?.ownerSessionId, session.ownerSessionId]) {
      if (!owner) continue;
      carrySensitiveValues(session.id, owner);
      carrySensitiveValues(owner, session.id);
      prepared.prompt = redactSensitiveText(owner, prepared.prompt);
    }
    let finalStatus = 'idle';
    // SubagentStart: a worker session is about to run its first turn.
    emitSubagentEvent('start', agent, { session_id: session.id, tag });
    let handoffMsgStart = 0;
    // A cancelled turn reports the output it produced before it stopped.
    const settleCancelled = (error, result = null) => {
      finalStatus = 'cancelled';
      reconcileJobCancelled(job, {
        tag,
        sessionId: session.id,
        ...presetDescriptor(agent, preset, presetName),
        content: redactSensitiveText(session.id, turnPartialHandoff(error, mgr.getSession(session.id), handoffMsgStart) || result?.content || ''),
      });
    };
    try {
      handoffMsgStart = resolveHandoffMessageStartIndex(mgr.getSession(session.id));
      const turnHooks = {
        submissionId: turn.submissionId,
        notifyFn: workerNotifyFn(session.id),
        onToolResult: (message) => turnReview.onToolResult(message),
        ...(job
          ? {
              onTerminalResult: terminalResultHook({
                job,
                turnReview,
                completionValue,
                notifyEarly: notifyOwnerAgentCompletionEarly,
                notifyContext,
              }),
            }
          : {}),
      };
      const result = await runTurn(prepared, turnHooks);
      // The early preview does not promise body suppression, so the canonical
      // notifyTaskCompletion fires exactly once with output via the
      // resolve/reconcile/finally path.
      const finalValue = completionValue(result);
      if (job?.status === 'cancelled') {
        settleCancelled(null, result);
        return finalValue;
      }
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
      if (typeof error?.message === 'string') error.message = redactSensitiveText(session.id, error.message);
      if (job?.status === 'cancelled') {
        settleCancelled(error);
        throw error;
      }
      const partial = watchdogPartialHandoffFromError(error, mgr.getSession(session.id), handoffMsgStart);
      if (partial) {
        finalStatus = 'idle';
        const value = {
          tag,
          sessionId: session.id,
          ...presetDescriptor(agent, preset, presetName),
          content: redactSensitiveText(session.id, watchdogStoppedHandoff(error, partial, await takeStoppedShellJobs(session.id))),
          stallAbort: true,
        };
        if (job) job._terminalResultValue = value;
        reconcileJobWatchdogPartial(job, value);
        return value;
      }
      finalStatus = 'error';
      noteStoppedShellJobsOnError(error, await takeStoppedShellJobs(session.id));
      reconcileJobStreamStalled(job, error, {
        tag,
        sessionId: session.id,
        ...presetDescriptor(agent, preset, presetName),
      });
      throw error;
    } finally {
      turnReview.complete();
      turn.release(finalStatus);
      reconcileJobFinally(job, finalStatus);
      // SubagentStop: worker finished (terminal), regardless of outcome.
      emitSubagentEvent('stop', agent, { session_id: session.id, tag, status: finalStatus });
      // Keep the durable session/tag for same-tag follow-ups, but release every
      // process-local shell, watchdog and tool cache immediately. Pooled
      // provider connections stay for the follow-up's response chain.
      try {
        mgr.unloadSessionRuntime?.(session.id, 'agent-turn-complete');
      } catch {}
    }
  }

  return {
    workerNotifyFn,
    notifyOwnerAgentCompletionEarly,
    runSpawn,
  };
}
