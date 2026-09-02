import assert from 'node:assert/strict';
import test from 'node:test';

import { createBootPhaseProfiler } from './boot-phase-profiler.mjs';

test('boot phase profiler records monotonic marks, completions, and failures', async () => {
  let now = 100;
  const lines = [];
  const profiler = createBootPhaseProfiler({
    log: (line) => lines.push(line),
    now: () => now,
    startedAt: 100,
  });

  profiler.mark('daemon-main');
  now = 110;
  const value = await profiler.measure('session-import', async () => {
    now = 145;
    return 7;
  }, { lane: 'daemon' });
  assert.equal(value, 7);

  now = 150;
  await assert.rejects(
    profiler.measure('keychain', async () => {
      now = 180;
      throw new TypeError('unavailable');
    }),
    TypeError,
  );

  assert.deepEqual(lines, [
    'boot-phase phase=daemon-main status=mark totalMs=0',
    'boot-phase phase=session-import status=start totalMs=10 lane=daemon',
    'boot-phase phase=session-import status=ready totalMs=45 lane=daemon durationMs=35',
    'boot-phase phase=keychain status=start totalMs=50',
    'boot-phase phase=keychain status=failed totalMs=80 durationMs=30 errorName=TypeError',
  ]);
});
