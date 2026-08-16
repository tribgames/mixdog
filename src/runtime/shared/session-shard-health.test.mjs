import assert from 'node:assert/strict';
import test from 'node:test';

import {
  recordShardDirectoryReadSuccess,
  reportShardAbortListenerPressure,
} from './session-shard-health.mjs';

test('repeated AbortSignal listener pressure marks only a session shard unhealthy', () => {
  const originalShardPid = process.env.MIXDOG_SESSION_SHARD_PID;
  let detail = null;
  const onUnhealthy = (value) => { detail = value; };
  process.env.MIXDOG_SESSION_SHARD_PID = String(process.pid);
  process.on('mixdog:session-shard-unhealthy', onUnhealthy);
  recordShardDirectoryReadSuccess();
  try {
    const warning = new Error('51 abort listeners added to [AbortSignal]');
    assert.equal(reportShardAbortListenerPressure(warning, 500, 0), false);
    assert.equal(reportShardAbortListenerPressure(warning, 1_000, 51), false);
    assert.equal(reportShardAbortListenerPressure(warning, 2_000, 51), false);
    assert.equal(reportShardAbortListenerPressure(warning, 3_000, 51), true);
    assert.equal(detail?.code, 'ABORT_LISTENER_PRESSURE');
    assert.equal(detail?.retainedListeners, 51);
  } finally {
    recordShardDirectoryReadSuccess();
    process.off('mixdog:session-shard-unhealthy', onUnhealthy);
    if (originalShardPid === undefined) delete process.env.MIXDOG_SESSION_SHARD_PID;
    else process.env.MIXDOG_SESSION_SHARD_PID = originalShardPid;
  }
});
