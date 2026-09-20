// Background cycle scheduling cluster.
//
// Owns the mutually-referential cycle machinery: the cycle-health ledger and
// run-state file, the cycle1 outer coalesce layer, the scheduled enqueue /
// retry paths for cycle1/2, checkCycles(), and the self-rescheduling tick
// loop. The phases live under cycle-scheduler/. index.mjs keeps lifecycle
// ownership by injecting live getters (getDb/getConfig/setConfig) plus the
// cycle runners and LLM adapters.
//
// Factory contract — everything the phases close over is passed in:
//   getDb()            -> live db handle (null before _initStore)
//   getConfig()        -> live mainConfig
//   setConfig(cfg)     -> checkCycles re-reads config each tick (poll-on-use)
//   dataDir            -> DATA_DIR
//   log                -> __mixdogMemoryLog
//   getCycleLastRun / setCycleLastRun -> meta-backed cycle timestamps
//   readMainConfig / memoryCyclesEnabled -> config-flag helpers
//   getCycle{1,2}CallLlm -> in-process LLM adapters
//   runCycle1 / runCycle2 / parseInterval / flushRawEmbeddings
//   claimAndMarkScheduledCycle / resolveCoalesceMaxRetries /
//     scheduleCoalescedCycleRetry -> coalesced queue primitives
//   scheduledCycle{1,2}Signature -> queue signatures
//   cycleStateFile -> path to memory-cycle-state.json
import { createCycleHealthLedger } from './cycle-scheduler/health-ledger.mjs';
import { createCycle1Runs } from './cycle-scheduler/cycle1-runs.mjs';
import { createCycle2Runs } from './cycle-scheduler/cycle2-runs.mjs';
import { createScheduledEnqueue } from './cycle-scheduler/scheduled-enqueue.mjs';
import { createBacklogProbe } from './cycle-scheduler/backlog-probe.mjs';
import { createCycleTickLoop } from './cycle-scheduler/tick-loop.mjs';

export { periodicCycleDue } from './cycle-scheduler/tick-loop.mjs';

export function createCycleScheduler(deps) {
  const {
    getDb,
    getConfig,
    setConfig,
    dataDir,
    log = () => {},
    getCycleLastRun,
    setCycleLastRun,
    readMainConfig,
    memoryCyclesEnabled,
    getCycle1CallLlm,
    getCycle2CallLlm,
    runCycle1,
    runCycle2,
    parseInterval,
    flushRawEmbeddings,
    claimAndMarkScheduledCycle,
    resolveCoalesceMaxRetries,
    scheduleCoalescedCycleRetry,
    cancelCoalescedCycleRetries,
    scheduledCycle1Signature,
    scheduledCycle2Signature,
    cycleStateFile,
  } = deps;

  const ledger = createCycleHealthLedger({ cycleStateFile, log });
  const queue = { memoryCyclesEnabled, resolveCoalesceMaxRetries, scheduleCoalescedCycleRetry };
  const cycle1 = createCycle1Runs({
    ledger,
    getDb,
    dataDir,
    log,
    getCycle1CallLlm,
    runCycle1,
    setCycleLastRun,
    ...queue,
  });
  const cycle2 = createCycle2Runs({ ledger, getDb, log, getCycle2CallLlm, runCycle2, setCycleLastRun, ...queue });
  const enqueue = createScheduledEnqueue({
    getDb,
    getConfig,
    claimAndMarkScheduledCycle,
    scheduledCycle1Signature,
    scheduledCycle2Signature,
    scheduleScheduledCycle1: cycle1.scheduleScheduledCycle1,
    scheduleScheduledCycle2: cycle2.scheduleScheduledCycle2,
  });
  const backlog = createBacklogProbe({ getDb, ledger, log, flushRawEmbeddings });
  const tick = createCycleTickLoop({
    readMainConfig,
    setConfig,
    memoryCyclesEnabled,
    parseInterval,
    getCycleLastRun,
    enqueue,
    probeBacklog: backlog.probe,
    ledger,
    cancelRetries: () => cancelCoalescedCycleRetries?.(getDb()),
    log,
  });

  // Full-shutdown reset so a later init() starts from a clean slate instead of
  // coalescing onto (or skipping behind) pre-stop in-flight work / stale
  // running state.
  function resetInFlight() {
    cycle1.reset();
    cycle2.reset();
    backlog.reset();
    tick.reset();
    ledger.resetRunning();
  }

  return {
    // health/state accessors (HTTP /health, statusline)
    getCycleHealth: () => ledger.health,
    getCycleRunning: ledger.getRunning,
    getCycleBacklogSnapshot: ledger.getBacklog,
    // cycle1 in-flight handle (rebuild drain in index.mjs)
    getCycle1InFlight: cycle1.getInFlight,
    // run primitives used by MCP action handlers
    startCycle1Run: cycle1.startCycle1Run,
    awaitCycle1Run: cycle1.awaitCycle1Run,
    finalizeCycle2Run: cycle2.finalizeCycle2Run,
    periodicCycle1Config: enqueue.periodicCycle1Config,
    // lifecycle
    startCycles: tick.start,
    stopCycles: tick.stop,
    resetInFlight,
    checkCycles: tick.checkCycles,
  };
}
