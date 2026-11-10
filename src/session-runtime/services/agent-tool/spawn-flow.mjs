// Spawn/job lifecycle: job start (foreground deferral, admission control),
// the worker turn owner (row status and progress watchdog), spawn prep (provider/session preparation),
// and the full runSpawn execution with turn-review collection and terminal
// accounting. The pieces live under spawn-flow/: job-start, spawn-prep,
// spawn-run and deferred-spawn; this wires them into one flow.
import { createJobStarter } from './spawn-flow/job-start.mjs';
import { createSpawnPreparer } from './spawn-flow/spawn-prep.mjs';
import { createSpawnRunner } from './spawn-flow/spawn-run.mjs';
import { createDeferredSpawn } from './spawn-flow/deferred-spawn.mjs';
import { createWorkerTurns } from './worker-turns.mjs';

export function createSpawnFlow(deps) {
  const startJob = createJobStarter({
    mgr: deps.mgr,
    notifyStatusChange: deps.notifyStatusChange ?? (() => {}),
    notifySessionCompletion: deps.notifySessionCompletion,
  });
  const { prepareSpawn, prepareSpawnInProcess, agentWatchdogOverrides } = createSpawnPreparer(deps);
  // The one owner of every worker turn's row status and watchdog.
  const workerTurns = createWorkerTurns({ ...deps, agentWatchdogOverrides });
  const runner = createSpawnRunner({ ...deps, workerTurns });
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
    workerTurns,
    prepareSpawn,
    prepareSpawnInProcess,
    agentWatchdogOverrides,
    runSpawn: runner.runSpawn,
  };
}
