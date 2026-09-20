/**
 * src/tui/session/session-flow/auto-clear.mjs - idle auto-clear: eligibility
 * gate, time-bounded compaction, and the late-fulfillment sync that applies a
 * cleared-session UI once the active turn settles.
 */
import { presentErrorText } from '../../../runtime/shared/err-text.mjs';
import { sessionActivityTimestamp } from '../queue-helpers.mjs';

// Upper bound on the awaited idle compaction. Without a bound a stalled
// compaction wedges autoClearRunning/commandBusy and suppresses input drain.
// NOTE: this bounds how long the INPUT stays blocked (commandBusy), not the
// compaction itself — a size-scaled summary call may exceed it, and the
// abandoned promise keeps running and the late-fulfillment path
// (autoClearInFlight / pendingClearedSessionUi) syncs the compacted session
// when it settles. Do NOT raise this to cover compaction worst cases.
const AUTO_CLEAR_COMPACT_TIMEOUT_MS = 60_000;
const LATE_COMPLETION_NOTICE = 'auto-clear completed late; compacted conversation retained';

// A zero is often an unavailable/stale meter field, not an authoritative
// measurement. Do not let it mask the sibling live estimate.
function contextUsageBelowThreshold(runtime, minContextPercent) {
  if (!(minContextPercent > 0)) return false;
  const status = runtime.contextStatus?.() || null;
  const usedTokens = Math.max(
    0,
    Number(status?.usedTokens) || 0,
    Number(status?.currentEstimatedTokens) || 0,
    Number(status?.compaction?.currentEstimatedTokens) || 0
  );
  const triggerTokens = Number(
    status?.compaction?.triggerTokens ||
      status?.compaction?.autoCompactTokenLimit ||
      runtime.session?.autoCompactTokenLimit ||
      0
  );
  if (!Number.isFinite(usedTokens) || !Number.isFinite(triggerTokens) || !(usedTokens > 0 && triggerTokens > 0)) {
    return true;
  }
  return (usedTokens / triggerTokens) * 100 < minContextPercent;
}

export function createAutoClearOps(bag, { reset, kickDrain }) {
  const {
    runtime,
    nextId,
    flags,
    pending,
    getState,
    set,
    pushItem,
    pushNotice,
    autoClearState,
    routeState,
    syncContextStats,
  } = bag;

  // Only an actual compaction resets the visible transcript; an unchanged
  // success keeps it. The model transcript always belongs to runtime.compact.
  function applyAutoClearUi(result) {
    const compactChanged = result.changed !== false;
    if (compactChanged) {
      reset.resetStats();
      reset.clearUiActivityBeforeContextSync();
    }
    syncContextStats({ allowEstimated: true, invalidateExact: compactChanged });
    set({
      ...routeState(),
      stats: { ...getState().stats },
    });
    pushItem({ kind: 'statusdone', id: nextId(), label: 'Auto-clear complete' });
  }

  // Flush a deferred cleared-session UI sync once the active turn has settled.
  // Never forces busy=false mid-turn: bails while a turn is in flight.
  function flushDeferredClearedSessionUi() {
    if (!flags.pendingClearedSessionUi || getState().busy) return;
    const { result } = flags.pendingClearedSessionUi;
    flags.pendingClearedSessionUi = null;
    flags.autoClearInFlight = false;
    applyAutoClearUi(result);
    pushNotice(LATE_COMPLETION_NOTICE, 'info');
  }

  function onLateCompact(lateResult) {
    if (getState().busy) {
      // Do not wipe items/queued or force busy=false mid-turn.
      flags.pendingClearedSessionUi = { result: lateResult };
    } else {
      applyAutoClearUi(lateResult);
      pushNotice(LATE_COMPLETION_NOTICE, 'info');
    }
  }

  // Validate both rejected calls and error results before either normal or
  // late completion can reset the UI. Never follow compact with clear:
  // that would discard conversation/execution records the compactor kept.
  async function compactWithinTimeout(compactTimeoutMs) {
    const compactPromise = runtime.compact().then((result) => {
      if (!result) throw new Error('no active session');
      if (result.error) throw new Error(result.error);
      return result;
    });
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`compaction timed out after ${compactTimeoutMs}ms; auto-clear deferred to next idle`)),
        compactTimeoutMs
      );
    });
    try {
      return await Promise.race([compactPromise, timeout]);
    } catch (raceError) {
      flags.autoClearInFlight = true;
      compactPromise
        .then(onLateCompact, () => {})
        .finally(() => {
          if (!flags.pendingClearedSessionUi) flags.autoClearInFlight = false;
        });
      throw raceError;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function autoClearBeforeSubmit() {
    flushDeferredClearedSessionUi();
    const cfg = autoClearState();
    const now = Date.now();
    const activityAt = sessionActivityTimestamp(runtime.session, flags.lastUserActivityAt);
    const idleMs = activityAt ? now - activityAt : 0;
    const notIdle =
      !cfg.enabled ||
      getState().busy ||
      pending.length > 0 ||
      flags.autoClearRunning ||
      flags.autoClearInFlight ||
      idleMs < cfg.idleMs;
    if (notIdle || contextUsageBelowThreshold(runtime, Number(cfg.minContextPercent ?? 10))) {
      if (!activityAt) flags.lastUserActivityAt = now;
      return false;
    }
    return performAutoClear();
  }

  // Idle cleanup retains the compactor's complete result, including rules-only
  // results without a summary. Plain /clear remains a separate explicit wipe.
  async function performAutoClear({ compactTimeoutMs = AUTO_CLEAR_COMPACT_TIMEOUT_MS } = {}) {
    flags.autoClearRunning = true;
    const startedAt = Date.now();
    // commandBusy blocks concurrent session commands (resume/newSession/
    // setModel) AND new submits for the duration of the async clear — the
    // compact swaps the live session object, so racing commands could act on
    // the wrong session.
    set({
      commandBusy: true,
      commandStatus: { active: true, verb: 'Auto-clearing idle conversation', startedAt, mode: 'auto-clear' },
    });
    try {
      // Give Ink one event-loop turn to paint the auto-clear status before the
      // compact path starts doing synchronous session/transcript work.
      // Without this, long idle clears can look like a frozen prompt followed by
      // an already-complete status row.
      await new Promise((resolve) => setTimeout(resolve, 0));
      applyAutoClearUi(await compactWithinTimeout(compactTimeoutMs));
      return true;
    } catch (error) {
      const message = presentErrorText(error, { surface: 'compact' });
      pushItem({
        kind: 'statusdone',
        id: nextId(),
        label: 'Auto-clear skipped',
        detail: `conversation kept · ${message}`,
      });
      pushNotice(`auto-clear skipped: ${message}`, 'error');
      return false;
    } finally {
      flags.lastUserActivityAt = Date.now();
      flags.autoClearRunning = false;
      set({ commandBusy: false, commandStatus: null });
      kickDrain();
    }
  }

  return { autoClearBeforeSubmit, performAutoClear, flushDeferredClearedSessionUi };
}
