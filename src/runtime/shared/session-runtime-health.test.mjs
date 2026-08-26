import assert from 'node:assert/strict';
import test from 'node:test';

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

test('repeated AbortSignal listener pressure marks only the session runtime worker unhealthy', () => {
  const originalRuntimeWorkerPid = process.env.MIXDOG_SESSION_RUNTIME_WORKER_PID;
  let detail = null;
  const onUnhealthy = (value) => { detail = value; };
  process.env.MIXDOG_SESSION_RUNTIME_WORKER_PID = String(process.pid);
  process.on('mixdog:session-runtime-worker-unhealthy', onUnhealthy);
  recordRuntimeDirectoryReadSuccess();
  try {
    const warning = new Error('51 abort listeners added to [AbortSignal]');
    assert.equal(reportRuntimeAbortListenerPressure(warning, 500, 0), false);
    assert.equal(reportRuntimeAbortListenerPressure(warning, 1_000, 51), false);
    assert.equal(reportRuntimeAbortListenerPressure(warning, 2_000, 51), false);
    assert.equal(reportRuntimeAbortListenerPressure(warning, 3_000, 51), true);
    assert.equal(detail?.code, 'ABORT_LISTENER_PRESSURE');
    assert.equal(detail?.retainedListeners, 51);
  } finally {
    recordRuntimeDirectoryReadSuccess();
    process.off('mixdog:session-runtime-worker-unhealthy', onUnhealthy);
    if (originalRuntimeWorkerPid === undefined) delete process.env.MIXDOG_SESSION_RUNTIME_WORKER_PID;
    else process.env.MIXDOG_SESSION_RUNTIME_WORKER_PID = originalRuntimeWorkerPid;
  }
});
