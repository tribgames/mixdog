#!/usr/bin/env node
// Golden twin of the dispatch watchdog's timing, run on real Node with its timers and clock mocked:
// `startDispatchWatchdog` (agent-dispatch/watchdog.mjs) makes its `setInterval(…, 1000)` synchronously as it
// arms, so every sweep is a whole number of seconds after arming, however the run is scheduled, and a run silent since
// arming is aborted at the first sweep past its idle budget. Recorded per dog: when each interval callback ran
// (`Date.now()`), which of them evaluated the progress snapshot (instrumented at the snapshot's store read; a callback after
// the abort returns before it), and when the run was aborted, with its message.
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

const inactive = { firstTransportMs: 0, firstSemanticMs: 0, idleStaleMs: 0 };

mock.timers.enable({ apis: ['setInterval', 'Date'], now: T0 });
// Every `setInterval(…, 1000)` made while a dog is being armed belongs to it: the sweep time is recorded (relative to the
// scenario's start) as the callback begins, and the abort moment as the callback ends with the run's signal aborted.
let origin = T0;
let arming = null;
let watched = null;
let read = false;
const dogs = new Map();
const mapGet = Map.prototype.get;
Map.prototype.get = function (key) {
  if (watched !== null && key === watched) read = true;
  return mapGet.call(this, key);
};
const mockedSetInterval = globalThis.setInterval;
globalThis.setInterval = (callback, ms, ...rest) => {
  if (ms !== 1000 || arming === null) return mockedSetInterval(callback, ms, ...rest);
  const tag = arming;
  dogs.get(tag).intervals += 1;
  return mockedSetInterval(
    (...a) => {
      const record = dogs.get(tag);
      const at = Date.now() - origin;
      record.callbacks.push(at);
      // The snapshot read is `_runtimeState.get(sessionId)` (session/manager/runtime-liveness.mjs, getSessionProgressSnapshot): a
      // callback that returns at the aborted check (watchdog.mjs:20) never reaches it, and that is what is recorded, not inferred.
      watched = record.sessionId;
      read = false;
      let result;
      try {
        result = callback(...a);
      } finally {
        watched = null;
      }
      if (read) record.evaluations.push(at);
      if (record.abortedAt === null && record.handle.signal?.aborted) record.abortedAt = at;
      return result;
    },
    ms,
    ...rest
  );
};

/**
 * One scenario on one mocked timeline (ms from its start): `arms` are `startDispatchWatchdog` calls (a run whose progress
 * stamp is its arming), `progress` re-stamps a run's progress, `stops` are the instants the timeline is run to. Events
 * happen after the timers due at their instant. Per dog: the intervals it made, its sweep times, the sweep that aborted
 * its run and with what message.
 */
function record(name, { arms, progress = [], stops }) {
  origin = Date.now();
  dogs.clear();
  const events = [
    ...arms.map((arm) => ({ ...arm, kind: 'arm' })),
    ...progress.map((p) => ({ ...p, kind: 'progress' })),
  ].sort((a, b) => a.at - b.at);
  const times = [...new Set([...stops, ...events.map((e) => e.at)])].sort((a, b) => a - b);
  let now = 0;
  // After the timers due at each instant (before that instant's events): per dog, how many evaluations had run and whether its
  // run was aborted.
  const afterStops = [];
  for (const at of times) {
    mock.timers.tick(at - now);
    now = at;
    afterStops.push(Object.fromEntries([...dogs].map(([dog, record]) => [dog, { evaluated: record.evaluations.length, aborted: record.handle.signal?.aborted === true }])));
    for (const event of events.filter((e) => e.at === at)) {
      const sessionId = `sess_dispatch_watchdog_${name}_${event.dog}`;
      if (event.kind === 'arm') {
        updateSessionStage(sessionId, 'streaming');
        dogs.set(event.dog, { sessionId, armedAt: at, armed: null, intervals: 0, callbacks: [], evaluations: [], abortedAt: null, message: null, handle: null });
        arming = event.dog;
        const handle = startDispatchWatchdog({ agent: 'worker', sessionId, policy: event.policy ?? policy });
        arming = null;
        dogs.get(event.dog).handle = handle;
        dogs.get(event.dog).armed = handle.signal !== null;
      } else {
        updateSessionStage(sessionId, 'streaming');
      }
    }
  }
  const out = {};
  for (const [dog, record] of dogs) {
    record.handle.stop();
    const reason = record.handle.signal?.reason;
    out[dog] = {
      armedAt: record.armedAt,
      armed: record.armed,
      intervals: record.intervals,
      callbacks: record.callbacks,
      evaluations: record.evaluations,
      abortedAt: record.abortedAt,
      message: record.abortedAt === null ? null : String(reason?.message ?? reason),
    };
  }
  return { name, arms, progress, stops: times, afterStops, dogs: out };
}

const every = (step, until) => Array.from({ length: until / step }, (_, i) => (i + 1) * step);
const scenarios = [
  // A silent run: swept once a second from arming, stopped at the first sweep past its idle budget.
  record('silent', { arms: [{ dog: 'A', at: 0 }], stops: every(1000, 62000) }),
  // The first part of the period passes before anything else happens: the first sweep is still one period after arming.
  record('late', { arms: [{ dog: 'A', at: 0 }], stops: [400, 1000, 2000, 3000] }),
  // A dispatch started while another runs has its own interval, made as it arms: not the first one's phase.
  record('second', { arms: [{ dog: 'A', at: 0 }, { dog: 'B', at: 400 }], stops: [400, 1000, 1400, 2000, 2400, 3000] }),
  // A sweep that found nothing arms nothing: the same interval goes on, and what is judged is the snapshot's last progress,
  // not the time since arming.
  record('progress', { arms: [{ dog: 'A', at: 0 }], progress: [{ dog: 'A', at: 30500 }], stops: every(1000, 92000) }),
  // A policy with no deadline makes no signal and no interval.
  record('inactive', { arms: [{ dog: 'A', at: 0, policy: inactive }], stops: [1000, 5000] }),
];
mock.timers.reset();

writeJson(join(stage, 'golden.json'), { t0: T0, policy, scenarios });
writeSetManifest(stage, { set: 'agent-dispatch-watchdog', recorder, command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`, identity });
commitStage(stage, finalDir);
console.log(
  scenarios
    .flatMap((s) => Object.entries(s.dogs).map(([dog, d]) => `${s.name}/${dog}: armed ${d.armed} at ${d.armedAt}, intervals ${d.intervals}, callbacks ${d.callbacks.length}, evaluations ${d.evaluations.length} (first ${d.evaluations[0]}), aborted at ${d.abortedAt}`))
    .join('\n')
);
process.exit(0);
