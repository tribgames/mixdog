// Spawn/job lifecycle: job start (foreground deferral, admission control),
// the progress-idle watchdogs, spawn prep (provider/session preparation),
// and the full runSpawn execution with turn-review collection and terminal
// accounting. The pieces live under spawn-flow/: job-start, spawn-prep,
// spawn-run and deferred-spawn; this wires them into one flow.
import { createJobStarter } from './spawn-flow/job-start.mjs';
import { createSpawnPreparer } from './spawn-flow/spawn-prep.mjs';
import { createSpawnRunner } from './spawn-flow/spawn-run.mjs';
import { createDeferredSpawn } from './spawn-flow/deferred-spawn.mjs';

export function createSpawnFlow(deps) {
  const startJob = createJobStarter({
    mgr: deps.mgr,
    notifyStatusChange: deps.notifyStatusChange ?? (() => {}),
    notifySessionCompletion: deps.notifySessionCompletion,
  });
  const { prepareSpawn, prepareSpawnInProcess } = createSpawnPreparer(deps);
  const runner = createSpawnRunner(deps);
  const { closePreparedSpawn, startDeferredSpawnJob } = createDeferredSpawn({
    ...deps,
    startJob,
    prepareSpawn,
    runSpawn: runner.runSpawn,
  });

  return {
    closePreparedSpawn,
    workerNotifyFn: runner.workerNotifyFn,
    notifyOwnerAgentCompletionEarly: runner.notifyOwnerAgentCompletionEarly,
    startJob,
    startDeferredSpawnJob,
    progressWatchdogs: runner.progressWatchdogs,
    startProgressIdleWatchdog: runner.startProgressIdleWatchdog,
    turnStartStamper: runner.turnStartStamper,
    progressStamper: runner.progressStamper,
    prepareSpawn,
    prepareSpawnInProcess,
    runSpawn: runner.runSpawn,
  };
}
