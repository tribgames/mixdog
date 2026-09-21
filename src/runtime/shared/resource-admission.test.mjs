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

  const yielding = admission
    .runWithLease(first, () =>
      admission.runYielded(async () => {
        waitStarted.resolve();
        await finishWait.promise;
        return 'provider-result';
      })
    )
    .then((value) => {
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

test('an already-aborted acquire uses the shared abort reason', async () => {
  const admission = new ResourceAdmissionController({
    limits: { maxAgents: 1, maxShells: 1, maxHighLoad: 1, maxQueue: 8 },
  });
  await assert.rejects(() => admission.acquire('agent', { signal: { aborted: true } }), {
    message: 'resource admission canceled',
  });
});

test('a failed provider wait propagates without reacquiring a saturated slot', async () => {
  const admission = new ResourceAdmissionController({ env: {}, limits: { maxAgents: 1, maxHighLoad: 1 } });
  const first = await admission.acquire('agent');
  const response = Promise.withResolvers();
  const failure = new Error('connection closed');
  const running = admission.runWithLease(first, () => admission.runYielded(() => response.promise));
  const rejected = assert.rejects(running, (error) => error === failure);
  const blocker = await admission.acquire('agent');
  response.reject(failure);
  await rejected;
  assert.equal(admission.snapshot().queued, 0);
  assert.equal(admission.snapshot().active.agent, 1);
  await first.release();
  assert.equal(admission.snapshot().active.agent, 1, 'failure cleanup does not release another task');
  await blocker.release();
  assert.equal(admission.snapshot().active.agent, 0);
});

test('a caller can retry after failure and reacquire on success', async () => {
  const admission = new ResourceAdmissionController({ env: {}, limits: { maxAgents: 1, maxHighLoad: 1 } });
  const lease = await admission.acquire('agent');
  await admission.runWithLease(lease, async () => {
    await assert.rejects(
      admission.runYielded(async () => {
        throw new Error('disconnected');
      })
    );
    assert.equal(admission.snapshot().active.agent, 0);
    assert.equal(await admission.runYielded(async () => 'recovered'), 'recovered');
    assert.equal(admission.snapshot().active.agent, 1);
  });
  await lease.release();
  assert.equal(admission.snapshot().active.agent, 0);
});

test('admission abort keeps original identity and falsy-reason fallback', async () => {
  const admission = new ResourceAdmissionController({
    limits: { maxAgents: 1, maxShells: 1, maxHighLoad: 1, maxQueue: 8 },
  });
  const aborted = (reason) => ({ aborted: true, reason });
  for (const reason of [0, false, Number.NaN, '', null, undefined]) {
    await assert.rejects(
      () => admission.acquire('agent', { signal: aborted(reason) }),
      { message: 'resource admission canceled' },
      `falsy reason ${String(reason)} must not stringify into the abort message`
    );
  }
  const cause = new Error('typed abort');
  await assert.rejects(
    () => admission.acquire('agent', { signal: aborted(cause) }),
    (error) => error === cause
  );
  await assert.rejects(() => admission.acquire('agent', { signal: aborted('stop-now') }), { message: 'stop-now' });
});
