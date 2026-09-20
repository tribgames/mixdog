/**
 * commands.mjs — the session object's long-running slash commands: memory
 * control, recall, doctor, and manual compaction (scheduled for turn end when
 * a turn is running). Each shows a command status while it holds the lock.
 */
import { compactEventDetail } from '../labels.mjs';
import { buildDoctorReport } from '../../app/doctor.mjs';

export function createSessionCommandsApi(bag) {
  const {
    runtime,
    nextId,
    getState,
    set,
    flushEmitImmediate,
    pushItem,
    pushNotice,
    routeState,
    syncContextStats,
    replaceItems,
  } = bag;

  // Run `work` under the command lock with a visible commandStatus.
  const withCommandStatus = async (verb, mode, work) => {
    const startedAt = Date.now();
    set({ commandBusy: true, commandStatus: { active: true, verb, startedAt, mode } });
    try {
      return await work(startedAt);
    } finally {
      set({ commandBusy: false, commandStatus: null });
    }
  };

  // /compact mid-turn runs once the turn AND the queued follow-ups finish
  // (compacting between queued turns would interleave a summary pass into the
  // user's planned sequence). One pending schedule at a time; the timer is
  // unref'd so it never holds the process open, and any error path clears it.
  const scheduleCompactForTurnEnd = (compactCommand) => {
    if (bag._scheduledCompactTimer) {
      pushNotice('Compact already scheduled for turn end', 'info');
      return { changed: false, scheduled: true };
    }
    pushNotice('Compact scheduled: runs when the current turn finishes', 'info');
    bag._scheduledCompactTimer = setInterval(() => {
      try {
        const s = getState();
        if (s.busy || s.commandBusy || (s.queued || []).length > 0) return;
        clearInterval(bag._scheduledCompactTimer);
        bag._scheduledCompactTimer = null;
        void compactCommand();
      } catch {
        try {
          clearInterval(bag._scheduledCompactTimer);
        } catch {
          /* gone */
        }
        bag._scheduledCompactTimer = null;
      }
    }, 750);
    bag._scheduledCompactTimer.unref?.();
    return { changed: false, scheduled: true };
  };

  const compactDoneItem = (result, startedAt) => {
    // null = session missing/closed: still surface a done row so /compact
    // never ends silently without a completion marker.
    if (!result) return { kind: 'statusdone', id: nextId(), label: 'Compact failed', detail: 'no active session' };
    let compactOutcome = { label: 'Compact complete', status: 'compacted' };
    if (result.error) compactOutcome = { label: 'Compact failed', status: 'failed' };
    else if (result.changed === false) compactOutcome = { label: 'Compact checked', status: 'no_change' };
    return {
      kind: 'statusdone',
      id: nextId(),
      label: compactOutcome.label,
      detail: compactEventDetail({
        stage: 'manual',
        trigger: 'manual',
        status: compactOutcome.status,
        compactType: result.compactType,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
        beforeMessages: result.beforeMessages,
        afterMessages: result.afterMessages,
        freshContext: result.freshContext,
        handoffSource: result.handoffSource,
        durationMs: Date.now() - startedAt,
        error: result.error,
      }),
    };
  };

  async function compactCommand() {
    if (getState().commandBusy) return null;
    if (getState().busy) return scheduleCompactForTurnEnd(compactCommand);
    try {
      return await withCommandStatus('Compacting conversation', 'compacting', async (startedAt) => {
        // Give Ink one event-loop turn to paint the compacting spinner before
        // runtime.compact() starts synchronous session/transcript work (same
        // yield as the auto-clear path; without it /compact looks frozen with
        // no spinner until the compact already finished).
        await new Promise((resolve) => setTimeout(resolve, 0));
        const result = await runtime.compact({ recoverAgent: true });
        const compactChanged = Boolean(result && !result.error && result.changed !== false);
        syncContextStats({
          allowEstimated: true,
          invalidateExact: compactChanged,
        });
        set({ ...routeState(), stats: { ...getState().stats } });
        if (compactChanged) set({ items: replaceItems([]) });
        pushItem(compactDoneItem(result, startedAt));
        return result;
      });
    } finally {
      // A command reply reads the published snapshot, not the draft. Commit
      // completion before the awaiting service constructs that reply.
      flushEmitImmediate();
    }
  }

  return {
    memoryControl: async (args = {}, options = {}) => {
      // Project panels prefetch multiple scopes. Reads do not own the command
      // lock and must neither be dropped nor release another command's lock.
      const readOnlyList = args.op === 'list' && (args.action == null || args.action === 'core');
      if (!readOnlyList && getState().commandBusy) return null;
      if (!readOnlyList) set({ commandBusy: true });
      try {
        const result = await runtime.memoryControl(args);
        const text = String(result || '').trim() || '(empty memory result)';
        if (!options.silent) pushNotice(text, 'info');
        return result;
      } finally {
        if (!readOnlyList) set({ commandBusy: false });
      }
    },
    recall: async (query, args = {}) => {
      if (getState().commandBusy) return null;
      return withCommandStatus('Recalling memory', 'recalling', async () => {
        const result = await runtime.recall(query, args);
        pushNotice(String(result || '').trim() || '(empty recall result)', 'info');
        return result;
      });
    },
    runDoctor: async () => {
      if (getState().commandBusy) return null;
      return withCommandStatus('Running diagnostics', 'doctor', async () => {
        try {
          // Yield one event-loop turn so Ink paints the running indicator
          // before the (mostly synchronous) health checks run — same pattern
          // as compact.
          await new Promise((resolve) => setTimeout(resolve, 0));
          const report = await buildDoctorReport(runtime, getState);
          pushNotice(report, 'info');
          return report;
        } catch (e) {
          pushNotice(`doctor failed: ${e?.message || e}`, 'error');
          return null;
        }
      });
    },
    compact: compactCommand,
  };
}
