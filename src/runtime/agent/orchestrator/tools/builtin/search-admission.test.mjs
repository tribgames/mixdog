import assert from 'node:assert/strict';
import test from 'node:test';

import { createOwnerFairGate } from '../../../../shared/owner-fair-gate.mjs';
import { runWithSearchIoAdmission } from './search-admission.mjs';

test('broad search admission serializes walks while point content bypasses the gate', async () => {
  const gate = createOwnerFairGate({
    name: 'test broad search',
    activeMax: 1,
    queueMax: 8,
    minOwnerQueue: 1,
    waitTimeoutMs: 1_000,
  });
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const holdFirst = new Promise((resolve) => { releaseFirst = resolve; });
  let secondStarted = false;

  const first = runWithSearchIoAdmission(
    { fuzzy: 'alpha' },
    { ownerKey: 'owner-a' },
    async () => {
      markFirstStarted();
      await holdFirst;
      return 'first';
    },
    { gate, waitTimeoutMs: 1_000 },
  );
  await firstStarted;
  const second = runWithSearchIoAdmission(
    { args: ['--files', '.'] },
    { ownerKey: 'owner-b' },
    async () => {
      secondStarted = true;
      return 'second';
    },
    { gate, waitTimeoutMs: 1_000 },
  );

  const point = await runWithSearchIoAdmission(
    { args: ['--line-number', '-e', 'needle', 'known.txt'] },
    { ownerKey: 'owner-c' },
    async () => 'point',
    { gate, waitTimeoutMs: 1_000 },
  );
  assert.equal(point, 'point');
  assert.equal(secondStarted, false);

  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  gate.close();
});
