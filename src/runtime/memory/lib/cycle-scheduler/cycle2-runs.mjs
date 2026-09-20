import { countPendingCycle2Roots } from './backlog-probe.mjs';

// Max back-to-back cycle2 passes per scheduled slot (config: cycle2.catchup_passes).
const CYCLE2_CATCHUP_PASSES = 4;
const CYCLE2_CATCHUP_PASSES_MAX = 10;

function resolveCycle2CatchupPasses(config) {
  const raw = Number(config?.catchup_passes ?? CYCLE2_CATCHUP_PASSES);
  if (!Number.isFinite(raw)) return CYCLE2_CATCHUP_PASSES;
  return Math.min(CYCLE2_CATCHUP_PASSES_MAX, Math.max(1, Math.floor(raw)));
}

// Scheduled cycle2: the coalesced-queue task that drains catch-up passes, plus
// the result finalizer shared with the MCP action handlers.
export function createCycle2Runs({
  ledger,
  getDb,
  log,
  getCycle2CallLlm,
  runCycle2,
  setCycleLastRun,
  memoryCyclesEnabled,
  resolveCoalesceMaxRetries,
  scheduleCoalescedCycleRetry,
}) {
  let inFlight = false;

  async function finalizeCycle2Run(result) {
    if (result?.skippedInFlight) {
      log('[cycle2] skipped: in flight\n');
      return;
    }
    if (result.ok) {
      await setCycleLastRun('cycle2', Date.now());
      await setCycleLastRun('cycle2_last_error', '');
      log('[cycle2] completed\n');
      ledger.markDone('cycle2', true);
    } else {
      const err = result.error || 'unknown error';
      await setCycleLastRun('cycle2_last_error', err);
      log(`[cycle2] failed: ${err}\n`);
      ledger.markDone('cycle2', false, err);
    }
  }

  // Catch-up drain: one scheduled slot may run several back-to-back passes
  // while pending roots remain, so a backlog above the batch size drains in
  // one interval instead of one batch per hour.
  async function drainCatchUpPasses(config, signature, attempt) {
    const drainPasses = resolveCycle2CatchupPasses(config);
    for (let pass = 0; pass < drainPasses; pass++) {
      const result = await runCycle2(getDb(), config, {
        coalescedRetry: true,
        catchUpDrainPass: pass > 0,
        onCoalescedSuccess: finalizeCycle2Run,
        callLlm: getCycle2CallLlm(),
      });
      if (result?.skippedInFlight) {
        scheduleScheduledCycle2(config, signature, attempt + 1);
        return;
      }
      if (result?.coalescedRetryNoop) {
        log('[cycle2] scheduled queue noop\n');
        return;
      }
      if (result?.ok === false) {
        await finalizeCycle2Run(result);
        return;
      }
      const pendingLeft = await countPendingCycle2Roots(getDb());
      log(
        `[cycle2] catch-up pass ${pass + 1}/${drainPasses}: ` +
          `processed=${Number(result?.processed ?? 0)} pending=${pendingLeft}\n`
      );
      if (pendingLeft <= 0) return;
    }
  }

  async function runScheduledCycle2(config, signature, attempt) {
    if (!memoryCyclesEnabled()) return;
    if (inFlight) {
      scheduleScheduledCycle2(config, signature, attempt + 1);
      return;
    }
    inFlight = true;
    ledger.markRunning('cycle2');
    try {
      await drainCatchUpPasses(config, signature, attempt);
    } catch (err) {
      log(`[cycle2] scheduled queue failed: ${err?.message || err}\n`);
      ledger.markDone('cycle2', false, err?.message || err);
    } finally {
      inFlight = false;
      ledger.clearRunning('cycle2');
    }
  }

  function scheduleScheduledCycle2(config, signature, attempt = 0) {
    const maxRetries = resolveCoalesceMaxRetries(config, 3);
    if (attempt > maxRetries) {
      log('[cycle2] scheduled queue retry cap reached\n');
      return;
    }
    scheduleCoalescedCycleRetry(
      getDb(),
      'cycle2',
      () => runScheduledCycle2(config, signature, attempt),
      config,
      signature
    );
  }

  return {
    finalizeCycle2Run,
    scheduleScheduledCycle2,
    reset: () => {
      inFlight = false;
    },
  };
}
