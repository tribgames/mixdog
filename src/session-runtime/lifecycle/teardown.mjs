/**
 * src/session-runtime/lifecycle/teardown.mjs - runtime teardown: close (full
 * or detached), abort, and the canonical-session tombstone barrier.
 *
 *   teardown/session-close.mjs — SessionEnd hook, own-session close, tombstone barrier, abort
 *   teardown/runtime-stops.mjs — process-wide service stops and their settlement
 */
import { SessionClosedError } from '../../runtime/agent/orchestrator/session/manager/session-errors.mjs';
import { forgetSessionSaveBaseline } from '../../runtime/agent/orchestrator/session/store/save-worker.mjs';
import { flushAllIndexWrites } from '../services/agent-tool/index-write-queue.mjs';
import { unregisterLiveSession } from '../../runtime/shared/staged-update.mjs';
import { abortRuntime, closeCanonicalSession, closeOwnSession, dispatchSessionEnd } from './teardown/session-close.mjs';
import { settleAll, settleDetached, startRuntimeStops, startWorkStops } from './teardown/runtime-stops.mjs';

const CLOSE_ALL_DEADLINE_MS = 5000;
const PROCESS_EXIT_REASON =/exit|quit|shutdown|sighup|sigint|sigterm/;
const WARMUP_TIMER_KEYS = [
  'providerSetupWarmupTimer',
  'providerWarmupTimer',
  'providerModelWarmupTimer',
  'modelCatalogWarmupTimer',
  'statuslineUsageWarmupTimer',
  'statuslineUsageRefreshTimer',
];
const PREWARM_TIMER_KEYS = ['channelStartTimer', 'codeGraphPrewarmTimer', 'searchRuntimeWarmupTimer'];

// The synchronous close block (runtime stops + the canonical lifecycle
// barrier, a full rewrite of the session file) runs in its OWN event-loop
// turn, one teardown at a time, process-wide. Concurrent teardowns (an idle
// sweep evicting many sessions) otherwise reach it in the same microtask batch
// and block the loop for the sum of every barrier. Each turn is a fresh
// setImmediate queued after the previous close finished, so I/O and timers run
// between two closes. Order is FIFO; a teardown's own steps keep their order.
let closeTurns = Promise.resolve();
const nextLoopTurn = () => new Promise((resolve) => setImmediate(resolve));

function inOwnLoopTurn(work) {
  const turn = closeTurns.then(nextLoopTurn).then(work);
  closeTurns = turn.then(
    () => {},
    () => {}
  );
  return turn;
}

function clearTimers(holder, keys) {
  for (const key of keys) {
    if (holder[key]) {
      clearTimeout(holder[key]);
      holder[key] = null;
    }
  }
}

/**
 * What this close may reap. Background registries are process-global, but
 * jobs belong to sessions. Non-exit disposal reaps only this session's jobs;
 * without an owner it reaps nothing. Only a process exit may sweep every
 * session's work, and a keepBackgroundWork dispose (desktop idle eviction of
 * one engine while other sessions keep working in the SAME process) reaps
 * nothing at all.
 */
function teardownScope(reason, options, closingSessionId) {
  const detach = options?.detach === true || options?.wait === false || options?.waitForExit === false;
  const keepBackgroundWork = options?.keepBackgroundWork === true;
  const isProcessExit = PROCESS_EXIT_REASON.test(String(reason || '').toLowerCase());
  const scopedTeardown = !isProcessExit;
  const teardownReapsWork = !keepBackgroundWork && (!scopedTeardown || Boolean(closingSessionId));
  return { detach, isProcessExit, scopedTeardown, teardownReapsWork, closingSessionId };
}

export function createTeardown(deps, { ingestSessionIntoMemory, closeSurfaceSession, cancelBackgroundTasks }) {
  const {
    getSession,
    setCloseRequested,
    hooks,
    channels,
    agentTool,
    warmupTimers,
    prewarmTimers,
    flushAllConfigSavesAsync,
    withTeardownDeadline,
    stopSelfUpdateBootCheck,
    disposeSessionTitles,
    disposeInternalTools,
    disposeGlobalExtensionSubscription,
    abortActiveTurns,
    getReservedSessionId,
  } = deps;

  /** Stop accepting work and cut every in-flight turn before anything is persisted. */
  function quiesce(reason) {
    setCloseRequested(true);
    disposeInternalTools?.();
    try {
      disposeGlobalExtensionSubscription?.();
    } catch {}
    const closingTurnId = getSession()?.id || getReservedSessionId?.() || 'pending';
    try {
      abortActiveTurns?.(new SessionClosedError(closingTurnId, `runtime close (reason=${reason})`, reason));
    } catch {}
    try {
      stopSelfUpdateBootCheck?.();
    } catch {}
    try {
      disposeSessionTitles?.();
    } catch {}
  }

  /** Reap the background work this close owns; a scoped cancel ALWAYS notifies. */
  function reapWork(reason, scope) {
    if (!scope.teardownReapsWork) return;
    try {
      // A task that dies for a reason its owner never asked for must still be reported.
      cancelBackgroundTasks(
        scope.scopedTeardown
          ? { reason, notify: true, callerSessionId: scope.closingSessionId }
          : { reason, notify: false }
      );
    } catch {}
  }

  // Agent closes that have not settled yet (one per close invocation, kept
  // past the bounded wait if it overran).
  const outstandingCloses = new Set();

  /** Persist every queued index write. A close only ever drains: the shared
   *  indexes stay registered (exit hook included) for the closes still to come. */
  async function drainIndexWrites() {
    try {
      await agentTool.flushIndexWrites?.();
      await flushAllIndexWrites();
    } catch {}
  }

  // The disposal in progress (if any). New closes wait for it before starting
  // their own closeAll, so no close produces writes while registrations are
  // being released.
  let indexDisposal = null;

  /** Release this runtime's per-runtime index registrations (exit callbacks,
   *  approval writer, store refs) once its drain has completed. Idempotent. A
   *  drain that cannot complete tears nothing down: the registrations stay until
   *  a later close drains successfully. Exit flushing itself is process-owned. */
  function disposeIndexes(settle) {
    // Assign before disposal runs (deferred), clear on settlement: a synchronous
    // dispose must not clear the slot before it is assigned.
    indexDisposal ??= Promise.resolve()
      .then(async () => {
        if (typeof agentTool.disposeAsync === 'function') await agentTool.disposeAsync({ settle });
        else agentTool.dispose?.({ settle });
      })
      .catch(() => {
        /* drain failed: registrations are kept for a later retry */
      })
      .finally(() => {
        indexDisposal = null;
      });
    return indexDisposal;
  }

  async function close(reason = 'cli-exit', options = {}) {
    quiesce(reason);
    const scope = teardownScope(reason, options, String(getSession()?.id || ''));
    await dispatchSessionEnd(deps, reason);
    // Ingest the final conversation BEFORE the memory runtime stop below is
    // kicked off, so the write happens against a live module/daemon.
    try {
      await ingestSessionIntoMemory(getSession());
    } catch {
      /* best-effort */
    }
    // Teardown stays async end-to-end across every writer sharing the config
    // lock. Never start a synchronous lock wait while an in-process async
    // holder still needs the event loop to finish and release it.
    try {
      await flushAllConfigSavesAsync();
    } catch (error) {
      // A failed final flush means config written during this session never
      // reached disk. Teardown still completes (the remaining stops must run),
      // but silent data loss at shutdown is invisible to the user — report it
      // on the same diagnostic channel the rest of session-runtime uses.
      process.emitWarning(`config flush failed during teardown: ${error?.message || error}`, {
        code: 'TEARDOWN_CONFIG_FLUSH_FAILED',
      });
    }
    try {
      hooks.flushRules?.();
    } catch {}
    clearTimers(prewarmTimers, PREWARM_TIMER_KEYS);
    clearTimers(warmupTimers, WARMUP_TIMER_KEYS);
    reapWork(reason, scope);
    const channelStop = channels.stop(reason, {
      ...(scope.detach ? { waitForExit: false } : {}),
      // Runtime teardown/restart is not an explicit Remote OFF. Preserve the
      // session-pinned intent so the resumed session can reclaim it.
      preserveRemoteIntent: true,
    });
    // Agent workers die with a REAL teardown only (process exit, explicit
    // close). A keepBackgroundWork dispose (daemon idle eviction) reclaims
    // memory and must leave workers/rows for the re-materialized owner.
    // Scoped teardown closes only THIS session's workers — the worker index
    // is shared across every Lead in the process.
    let closing = null;
    while (indexDisposal) await indexDisposal;
    if (scope.teardownReapsWork) {
      // Every close runs its OWN scope's closeAll: a scoped close for one Lead
      // never stands in for a process-wide close. Closing produces final index
      // writes (settled rows, tombstones); the deadline only bounds how long
      // teardown waits and does not stop the close.
      const settled = () => {
        outstandingCloses.delete(closing);
      };
      closing = new Promise((resolve) =>
        resolve(agentTool.closeAll(reason, scope.scopedTeardown ? { callerSessionId: scope.closingSessionId } : {}))
      ).then(settled, settled);
      outstandingCloses.add(closing);
      try {
        await withTeardownDeadline(closing, CLOSE_ALL_DEADLINE_MS, false);
      } catch {}
    }
    // Drain after the closes settle, then release this runtime's index
    // registrations. A close that overran its deadline chains this onto its
    // settlement (teardown may return before then). The live outstanding set is
    // re-checked after every wait and drain, so the single disposal runs only
    // when no close is outstanding; the check and the disposal start share one
    // tick, and closes admitted afterwards wait for it.
    const finish = async () => {
      for (;;) {
        while (outstandingCloses.size > 0) await Promise.allSettled([...outstandingCloses]);
        await drainIndexWrites();
        if (outstandingCloses.size === 0) break;
      }
      await disposeIndexes(scope.teardownReapsWork === true);
    };
    if (outstandingCloses.size > 0) void finish();
    else await finish();
    const { ok, stops } = await inOwnLoopTurn(() => {
      const runtimeStops = startRuntimeStops(deps, reason, scope);
      const closed = closeOwnSession(deps, closeSurfaceSession, reason);
      return { ok: closed, stops: { channelStop, ...runtimeStops, ...startWorkStops(deps, reason, scope) } };
    });
    if (scope.detach) await settleDetached(withTeardownDeadline, stops);
    else await settleAll(withTeardownDeadline, stops);
    // The session went away (idle eviction included): free its save baselines.
    if (scope.closingSessionId) forgetSessionSaveBaseline(scope.closingSessionId, { releaseWriteControl: true });
    // Self-update stages in the background and swaps on the next clean launch
    // (see staged-update.mjs) — nothing installs at shutdown. On a real
    // process exit we just drop this session's live-refcount pid file so a
    // pending swap on the next launch is no longer blocked by us.
    if (scope.isProcessExit) {
      try {
        unregisterLiveSession();
      } catch {
        /* advisory refcount only */
      }
    }
    return ok;
  }

  return {
    closeCanonicalSession: (reason) => closeCanonicalSession(deps, reason),
    close,
    abort: (reason) => abortRuntime(deps, reason),
  };
}
