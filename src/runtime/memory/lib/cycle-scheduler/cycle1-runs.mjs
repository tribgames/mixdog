// Cycle1 outer coalesce layer: one in-flight run shared by every caller,
// caller deadlines that hand back a skipped marker, and the scheduled-queue
// retry that re-arms while a run is still in flight.
export function createCycle1Runs({
  ledger,
  getDb,
  dataDir,
  log,
  getCycle1CallLlm,
  runCycle1,
  setCycleLastRun,
  memoryCyclesEnabled,
  resolveCoalesceMaxRetries,
  scheduleCoalescedCycleRetry,
}) {
  let inFlight = null;

  async function recordCycle1Result(result) {
    const now = Date.now();
    await setCycleLastRun('cycle1_heartbeat', now);
    const skipped = result?.skippedInFlight === true;
    const coalescedNoop = result?.coalescedRetryNoop === true;
    const allFailed =
      !skipped &&
      Number(result?.chunks ?? 0) === 0 &&
      Number(result?.processed ?? 0) === 0 &&
      Number(result?.skipped ?? 0) > 0;
    if (!skipped && !coalescedNoop && !allFailed) {
      await setCycleLastRun('cycle1', now);
    }
    if (!skipped && !coalescedNoop) ledger.markDone('cycle1', !allFailed, allFailed ? 'all rows skipped' : null);
  }

  function startCycle1Run(config = {}, options = {}) {
    const runOptions = typeof options?.callLlm === 'function' ? options : { ...options, callLlm: getCycle1CallLlm() };
    ledger.markRunning('cycle1');
    let run = null;
    run = (async () => {
      try {
        const result = await runCycle1(getDb(), config, runOptions, dataDir);
        // A coalesced (scheduled) run records its own result through
        // onCoalescedSuccess inside runCycle1.
        if (typeof runOptions.onCoalescedSuccess !== 'function') await recordCycle1Result(result);
        return result;
      } catch (err) {
        ledger.markDone('cycle1', false, err?.message || err);
        throw err;
      } finally {
        ledger.clearRunning('cycle1');
        if (inFlight === run) inFlight = null;
      }
    })();
    inFlight = run;
    return run;
  }

  function skippedMarker(callerDeadlineMs) {
    return {
      processed: 0,
      chunks: 0,
      skipped: 0,
      sessions: 0,
      skippedInFlight: true,
      timedOutWaiting: true,
      callerDeadlineMs,
    };
  }

  async function awaitCycle1Run(config = {}, options = {}) {
    const target = inFlight || startCycle1Run(config, options);
    const callerDeadlineMs = Number(options.callerDeadlineMs) || 0;
    if (callerDeadlineMs <= 0) return await target;
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(skippedMarker(callerDeadlineMs)), callerDeadlineMs);
    });
    try {
      return await Promise.race([target, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  function scheduleScheduledCycle1(config, signature, attempt = 0) {
    const maxRetries = resolveCoalesceMaxRetries(config, 3);
    if (attempt > maxRetries) {
      log('[cycle1] scheduled queue retry cap reached\n');
      return;
    }
    scheduleCoalescedCycleRetry(
      getDb(),
      'cycle1',
      async () => {
        if (!memoryCyclesEnabled()) return;
        if (inFlight) {
          scheduleScheduledCycle1(config, signature, attempt + 1);
          return;
        }
        const result = await awaitCycle1Run(config, {
          coalescedRetry: true,
          onCoalescedSuccess: recordCycle1Result,
        });
        if (result?.skippedInFlight) scheduleScheduledCycle1(config, signature, attempt + 1);
      },
      config,
      signature
    );
  }

  return {
    startCycle1Run,
    awaitCycle1Run,
    recordCycle1Result,
    scheduleScheduledCycle1,
    getInFlight: () => inFlight,
    reset: () => {
      inFlight = null;
    },
  };
}
