import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';

import {
  createPassthroughSignal,
  createTimeoutSignal,
} from '../agent/orchestrator/stall-policy.mjs';
import { createAbortController } from './abort-controller.mjs';
import {
  createRuntimeLagTracker,
  recordRuntimeDirectoryReadSuccess,
  reportRuntimeAbortListenerPressure,
  RUNTIME_LAG_DEFAULTS,
  startRuntimeEventLoopLagMonitor,
} from './session-runtime-health.mjs';

test('sustained event-loop lag degrades a shard, a single spike does not', () => {
  const tracker = createRuntimeLagTracker();
  const spike = { p99Ms: RUNTIME_LAG_DEFAULTS.degradedP99Ms + 500 };
  assert.equal(tracker.record(spike).degraded, false);
  assert.equal(tracker.record(spike).degraded, false);
  const degraded = tracker.record(spike);
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.changed, true);
  // Already degraded: no repeated transition.
  assert.equal(tracker.record(spike).changed, false);
  assert.equal(tracker.degraded, true);

  // Hysteresis: still-elevated lag keeps the quarantine, a clean sample lifts it.
  assert.equal(tracker.record({ p99Ms: RUNTIME_LAG_DEFAULTS.degradedP99Ms - 1 }).degraded, true);
  const recovered = tracker.record({ p99Ms: 10 });
  assert.equal(recovered.degraded, false);
  assert.equal(recovered.changed, true);

  // A fresh process starts from a clean slate.
  tracker.record(spike);
  tracker.reset();
  assert.equal(tracker.degraded, false);
  assert.equal(tracker.sample, null);
});

test('the event-loop lag monitor samples this process and stops cleanly', async () => {
  const samples = [];
  const stop = startRuntimeEventLoopLagMonitor({
    intervalMs: 20,
    onSample: (sample) => samples.push(sample),
  });
  try {
    const deadline = Date.now() + 2_000;
    while (samples.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    stop();
  }
  assert.ok(samples.length > 0, 'monitor produced at least one sample');
  const [sample] = samples;
  for (const key of ['p50Ms', 'p95Ms', 'p99Ms', 'maxMs']) {
    assert.equal(Number.isFinite(sample[key]), true, `${key} is numeric`);
    assert.ok(sample[key] >= 0);
  }
  const seen = samples.length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(samples.length, seen, 'no samples after stop');
});

test('sequential and parallel session scopes release every parent abort listener', () => {
  const parent = createAbortController(128);
  for (let index = 0; index < 75; index += 1) {
    const scope = createPassthroughSignal(parent.signal);
    assert.equal(getEventListeners(parent.signal, 'abort').length, 1);
    scope.cleanup();
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  }

  const scopes = Array.from(
    { length: 64 },
    (_, index) => createTimeoutSignal(parent.signal, 60_000, `parallel scope ${index}`),
  );
  assert.equal(getEventListeners(parent.signal, 'abort').length, scopes.length);
  for (const scope of scopes) scope.cleanup();
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});

test('repeated AbortSignal listener pressure marks only the session runtime worker unhealthy', () => {
  const originalRuntimeWorkerPid = process.env.MIXDOG_SESSION_RUNTIME_WORKER_PID;
  let detail = null;
  const onUnhealthy = (value) => { detail = value; };
  process.env.MIXDOG_SESSION_RUNTIME_WORKER_PID = String(process.pid);
  process.on('mixdog:session-runtime-worker-unhealthy', onUnhealthy);
  recordRuntimeDirectoryReadSuccess();
  try {
    const warning = Object.assign(
      new Error('51 abort listeners added to [AbortSignal]'),
      {
        count: 51,
        target: createAbortController().signal,
        type: 'abort',
      },
    );
    const context = {
      shard: 2,
      runtimesAtWarning: 4,
      agentDispatchesAtWarning: 3,
      runtimesAfterDelay: 2,
      agentDispatchesAfterDelay: 1,
    };
    assert.equal(reportRuntimeAbortListenerPressure(warning, 500, 0), false);
    assert.equal(reportRuntimeAbortListenerPressure(warning, 1_000, 51, context), false);
    assert.equal(reportRuntimeAbortListenerPressure(warning, 2_000, 51, context), false);
    assert.equal(reportRuntimeAbortListenerPressure(warning, 3_000, 51, context), true);
    assert.equal(detail?.code, 'ABORT_LISTENER_PRESSURE');
    assert.equal(detail?.retainedListeners, 51);
    assert.equal(detail?.observedListeners, 51);
    assert.equal(detail?.targetType, 'AbortSignal');
    assert.equal(detail?.shard, 2);
    assert.equal(detail?.runtimesAtWarning, 4);
    assert.equal(detail?.agentDispatchesAfterDelay, 1);
    assert.match(detail?.warningStack, /51 abort listeners/u);
  } finally {
    recordRuntimeDirectoryReadSuccess();
    process.off('mixdog:session-runtime-worker-unhealthy', onUnhealthy);
    if (originalRuntimeWorkerPid === undefined) delete process.env.MIXDOG_SESSION_RUNTIME_WORKER_PID;
    else process.env.MIXDOG_SESSION_RUNTIME_WORKER_PID = originalRuntimeWorkerPid;
  }
});
