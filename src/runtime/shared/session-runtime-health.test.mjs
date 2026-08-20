import assert from 'node:assert/strict';
import test from 'node:test';

import {
  recordRuntimeDirectoryReadSuccess,
  reportRuntimeAbortListenerPressure,
} from './session-runtime-health.mjs';

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
