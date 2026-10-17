/**
 * lifecycle.mjs — the session object's session-boundary surface: tool
 * approval resolution, the session catalog reads and the runtime passthroughs,
 * composed with the transition groups under ./lifecycle/ (resets, inheritance,
 * resume, dispose).
 */
import { createSessionResetActions } from './lifecycle/session-reset.mjs';
import { createInheritanceActions } from './lifecycle/inheritance.mjs';
import { createResumeAction } from './lifecycle/resume.mjs';
import { createDisposeAction } from './lifecycle/dispose.mjs';
import { publishModelSwitch } from './routes.mjs';

export function createSessionLifecycleApi(bag, { restoreTranscriptItems, oauthFlows }) {
  const { runtime, pushNotice, removeNotice, setProgressHint, finishToolApproval } = bag;

  // Canonical close = execution fence at the local-session boundary. The fence
  // is raised synchronously BEFORE the runtime/manager close (which cancels the
  // session's shells and so triggers completion notifications), so no queue
  // drain, completion wake, pending-resume kick or new submission can start
  // work for a conversation that is being closed. A durable close that fails
  // restores admission with every accepted input intact; one that succeeds
  // leaves the session terminal and settles queued submissions explicitly.
  function closeCanonical(reason, options) {
    const flags = bag.flags || {};
    const previous = flags.admission || 'open';
    if (previous === 'terminal') return runtime.closeCanonicalSession?.(reason, options) === true;
    flags.admission = 'closing';
    let closed = false;
    try {
      closed = runtime.closeCanonicalSession?.(reason, options) === true;
    } catch (error) {
      flags.admission = previous;
      restoreAdmission();
      throw error;
    }
    if (!closed) {
      flags.admission = previous;
      restoreAdmission();
      return false;
    }
    flags.admission = 'terminal';
    flags.admissionGeneration = (Number(flags.admissionGeneration) || 0) + 1;
    bag.settleClosedQueue?.();
    return true;
  }

  function restoreAdmission() {
    void bag.drain?.();
    bag.flushDeferredExecutionPendingResumeKick?.();
  }

  return {
    isSessionTerminal: () => bag.flags?.admission === 'terminal' || runtime.isSessionTerminal?.() === true,
    resolveToolApproval: (id, decision = {}) => {
      const approved = decision === true || decision?.approved === true;
      return finishToolApproval(
        id,
        approved,
        decision?.reason || (approved ? 'approved by user' : 'denied by user'),
        typeof decision?.device === 'string' ? decision.device : '',
        decision?.answers,
        typeof decision?.reply === 'string' ? decision.reply : undefined
      );
    },
    pushNotice,
    removeNotice,
    setProgressHint,
    ...createSessionResetActions(bag),
    listSessions: (options) => {
      return runtime.listSessions(options);
    },
    renameSessionTitle: (id, title) => {
      return runtime.renameSessionTitle?.(id, title) ?? false;
    },
    // Quota escape hatch: re-route THIS session onto another model, in place,
    // only after its latest settled turn failed on exhausted provider quota.
    // Starts no turn — the caller resubmits through retryFailedTurn.
    continueSessionInModel: async (sessionId, route) => {
      const state = bag.getState();
      if (state.busy || state.commandBusy) throw new Error('session is busy');
      if (!sessionId || state.sessionId !== sessionId) throw new Error('session is not the active session');
      const items = Array.isArray(state.items) ? state.items : [];
      const last = items.findLast((item) => item?.kind === 'user' || item?.kind === 'turndone');
      if (last?.kind !== 'turndone' || last.status !== 'failed' || !last.quota) {
        throw new Error('latest turn did not fail on exhausted provider quota');
      }
      if (typeof runtime.continueSessionInModel !== 'function') throw new Error('runtime cannot continue in a model');
      bag.set({ commandBusy: true });
      try {
        const result = await runtime.continueSessionInModel(sessionId, route);
        bag.set({ ...bag.routeState(), stats: { ...bag.getState().stats } });
        bag.syncContextStats?.({ allowEstimated: true });
        // The same live divider as a picker switch; IPC and remote callers
        // see it through the published snapshot.
        publishModelSwitch(bag, result?.modelSwitch);
        return true;
      } finally {
        bag.set({ commandBusy: false });
        bag.flushEmitImmediate?.();
      }
    },
    // Desktop sidebar watcher hook: the desktop host watches this directory,
    // and a session record write (a turn starting or settling) schedules a
    // debounced catalog refresh that re-reads `working` from the daemon's
    // in-memory run state. Without it the watcher silently no-ops and the
    // sidebar only refreshes on other store notifications (user: spinner kept
    // spinning after the turn ended).
    sessionStoreDir: () => {
      try {
        return runtime.sessionStoreDir?.() || null;
      } catch {
        return null;
      }
    },
    ...createInheritanceActions(bag, { restoreTranscriptItems }),
    ...createResumeAction(bag, { restoreTranscriptItems }),

    deliverToolCompletion: (sessionId, text, meta = {}) =>
      runtime.deliverToolCompletion?.(sessionId, text, meta) === true,

    closeCanonicalSession: (reason = 'canonical-session-close', options) => closeCanonical(reason, options),

    bindSessionAddress: (sessionId) => runtime.bindSessionAddress?.(sessionId) === true,

    ...createDisposeAction(bag, { oauthFlows }),
  };
}
