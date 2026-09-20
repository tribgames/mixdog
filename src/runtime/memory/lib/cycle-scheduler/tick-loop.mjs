const TICK_MS = 60_000;

export function periodicCycleDue(lastRun, cyclesStartedAt, intervalMs, now = Date.now()) {
  const persistedLastRun = Number(lastRun) || 0;
  const anchor = persistedLastRun > 0 ? persistedLastRun : Number(cyclesStartedAt) || 0;
  return Number(intervalMs) > 0 && Number(now) - anchor >= Number(intervalMs);
}

// The self-rescheduling tick: re-read config, enqueue whichever periodic
// cycles are due, then probe the backlog. start()/stop() own the timer.
export function createCycleTickLoop({
  readMainConfig,
  setConfig,
  memoryCyclesEnabled,
  parseInterval,
  getCycleLastRun,
  enqueue,
  probeBacklog,
  ledger,
  cancelRetries,
  log,
}) {
  let active = false;
  let timer = null;
  let startedAt = 0;
  let checkInFlight = false;

  async function checkCycles() {
    const mainConfig = readMainConfig();
    setConfig(mainConfig);
    const cyclesOn = memoryCyclesEnabled();
    const cycle1Ms = parseInterval(mainConfig?.cycle1?.interval || '10m');
    const cycle2Ms = parseInterval(mainConfig?.cycle2?.interval || '1h');
    const now = Date.now();
    const last = await getCycleLastRun();
    if (cyclesOn) {
      if (periodicCycleDue(last.cycle1, startedAt, cycle1Ms, now)) await enqueue.enqueueScheduledCycle1(cycle1Ms);
      if (periodicCycleDue(last.cycle2, startedAt, cycle2Ms, now)) await enqueue.enqueueScheduledCycle2(cycle2Ms);
    }
    await probeBacklog(now);
  }

  async function runCheckGuarded() {
    if (checkInFlight) return;
    checkInFlight = true;
    try {
      await checkCycles();
    } catch (e) {
      log(`[cycle-tick] error: ${e.message}\n`);
    } finally {
      checkInFlight = false;
    }
  }

  function scheduleNext() {
    timer = setTimeout(async () => {
      timer = null;
      try {
        await runCheckGuarded();
      } catch (e) {
        log(`[cycle-tick] re-arm guard caught: ${e?.message || e}\n`);
      } finally {
        if (active) scheduleNext();
      }
    }, TICK_MS);
  }

  function start() {
    if (active) return;
    active = true;
    startedAt = Date.now();
    // Boot reset: a previous daemon that crashed mid-run leaves the state
    // file's `running` marker set, and the statusline keeps showing a phantom
    // "Memory cycle running" spinner until its 10-minute stale guard kicks
    // in. No cycle can be running when this scheduler starts.
    ledger.resetRunning();
    ledger.write();
    Promise.resolve(getCycleLastRun())
      .then((last) => ledger.hydrateSuccess(last))
      .catch(() => {});
    scheduleNext();
  }

  function stop() {
    active = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      cancelRetries();
    } catch {}
  }

  return {
    checkCycles,
    start,
    stop,
    reset: () => {
      checkInFlight = false;
      startedAt = 0;
    },
  };
}
