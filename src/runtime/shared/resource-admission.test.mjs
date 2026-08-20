import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceAdmissionController } from './resource-admission.mjs';

test('provider-style waits yield and reacquire the current agent lease', async () => {
  const admission = new ResourceAdmissionController({
    limits: {
      maxAgents: 1,
      maxShells: 1,
      maxHighLoad: 1,
      maxQueue: 8,
    },
  });
  const first = await admission.acquire('agent', { ownerKey: 'first' });
  const waitStarted = Promise.withResolvers();
  const finishWait = Promise.withResolvers();
  let yieldedFinished = false;

  const yielding = admission.runWithLease(first, () => admission.runYielded(async () => {
    waitStarted.resolve();
    await finishWait.promise;
    return 'provider-result';
  })).then((value) => {
    yieldedFinished = true;
    return value;
  });

  await waitStarted.promise;
  assert.equal(admission.snapshot().active.agent, 0);
  const second = await admission.acquire('agent', { ownerKey: 'second' });
  assert.equal(admission.snapshot().active.agent, 1);

  finishWait.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(yieldedFinished, false, 'the first continuation waits to reacquire its slot');

  await second.release();
  assert.equal(await yielding, 'provider-result');
  assert.equal(admission.snapshot().active.agent, 1);
  await first.release();
  assert.equal(admission.snapshot().active.agent, 0);
});
