#!/usr/bin/env node
// Golden twin of the dispatch watchdog's timing, run on real Node with its timers and clock mocked:
// `startDispatchWatchdog` (agent-dispatch/watchdog.mjs) makes its `setInterval(…, 1000)` synchronously as it
// arms, so every sweep is a whole number of seconds after arming, however the run is scheduled, and a run silent since
// arming is aborted at the first sweep past its idle budget. Recorded: when each sweep runs relative to arming
// (the callback's `Date.now()`), and when a silent run's signal is aborted, with its message.
//
//   node benchmarks/rust-core/recorders/record-agent-dispatch-watchdog.mjs [--tree <dir>]
//
// Output: native/core/fixtures/agent-dispatch-watchdog/golden.json (+ MANIFEST.json, identity exact at the commit).
import { mock } from 'node:test';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { join } from 'node:path';

const args = parseArgs();
const tree = resolveTree(args);
const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const identity = exactProductIdentity(tree, NODE_COMMIT);
const { startDispatchWatchdog } = await importFrom(tree, 'src/runtime/agent/orchestrator/agent-runtime/agent-dispatch/watchdog.mjs');
const { updateSessionStage } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/manager/runtime-liveness.mjs');

const finalDir = join(FIXTURES_ROOT, 'agent-dispatch-watchdog');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-agent-dispatch-watchdog.mjs';

const T0 = 1_000_000;
const policy = { firstTransportMs: 0, firstSemanticMs: 0, idleStaleMs: 60000 };

mock.timers.enable({ apis: ['setInterval', 'Date'], now: T0 });
const sweepTimes = [];
let origin = T0;
const mockedSetInterval = globalThis.setInterval;
globalThis.setInterval = (callback, ms, ...rest) =>
  mockedSetInterval(
    ms === 1000
      ? (...a) => {
          sweepTimes.push(Date.now() - origin);
          return callback(...a);
        }
      : callback,
    ms,
    ...rest
  );

/** Arms the watchdog for a run that last made progress at arming, then runs `ticks` (ms) of mocked time. */
function record(name, ticks) {
  const sessionId = `sess_dispatch_watchdog_${name}`;
  sweepTimes.length = 0;
  origin = Date.now();
  updateSessionStage(sessionId, 'streaming');
  const dog = startDispatchWatchdog({ agent: 'worker', sessionId, policy });
  let elapsed = 0;
  let abortedAt = null;
  for (const ms of ticks) {
    mock.timers.tick(ms);
    elapsed += ms;
    if (abortedAt === null && dog.signal.aborted) abortedAt = elapsed;
  }
  dog.stop();
  const reason = dog.signal.reason;
  return {
    name,
    ticks,
    sweeps: [...sweepTimes],
    abortedAt,
    message: dog.signal.aborted ? String(reason?.message ?? reason) : null,
  };
}

const scenarios = [
  // A silent run: swept once a second from arming, stopped at the first sweep past its idle budget.
  record('silent', Array.from({ length: 62 }, () => 1000)),
  // The first part of the period passes before anything else happens: the first sweep is still one period after arming.
  record('late', [400, 600, 1000, 1000]),
];
mock.timers.reset();

writeJson(join(stage, 'golden.json'), { t0: T0, policy, scenarios });
writeSetManifest(stage, { set: 'agent-dispatch-watchdog', recorder, command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`, identity });
commitStage(stage, finalDir);
console.log(scenarios.map((s) => `${s.name}: sweeps ${s.sweeps.length} (first ${s.sweeps[0]}), aborted at ${s.abortedAt}`).join('\n'));
process.exit(0);
