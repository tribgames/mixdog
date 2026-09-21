import assert from 'node:assert/strict';
import test from 'node:test';
import { ResourceAdmissionController } from './resource-admission.mjs';

for (const restoring of [false, true]) {
  test(`legitimate capacity waits do not expire at five minutes (restoring=${restoring})`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const admission = new ResourceAdmissionController({
      env: {},
      limits: { maxAgents: 1, maxHighLoad: 1 },
    });
    const first = await admission.acquire('agent');
    let blocked;
    let blocker = first;
    if (restoring) {
      const response = Promise.withResolvers();
      blocked = admission.runWithLease(first, () => admission.runYielded(() => response.promise));
      blocker = await admission.acquire('agent');
      response.resolve('reply');
      await new Promise(setImmediate);
    } else {
      blocked = admission.acquire('agent');
    }
    t.mock.timers.tick(600_000);
    assert.equal(admission.snapshot().queued, 1);
    assert.equal(admission.snapshot().active.agent, 1);
    await blocker.release();
    const result = await blocked;
    if (restoring) {
      assert.equal(result, 'reply');
      await first.release();
    } else {
      await result.release();
    }
    assert.equal(admission.snapshot().active.agent, 0);
  });
}

test('turn cancellation interrupts slot restoration without cancelling the blocker', async () => {
  const admission = new ResourceAdmissionController({ env: {}, limits: { maxAgents: 1, maxHighLoad: 1 } });
  const first = await admission.acquire('agent');
  const response = Promise.withResolvers();
  const controller = new AbortController();
  const running = admission.runWithLease(first, () =>
    admission.runYielded(() => response.promise, { signal: controller.signal })
  );
  const blocker = await admission.acquire('agent');
  response.resolve('reply');
  await new Promise(setImmediate);
  const failure = new Error('turn cancelled');
  const rejected = assert.rejects(running, (error) => error === failure);
  controller.abort(failure);
  await rejected;
  assert.equal(admission.snapshot().queued, 0);
  await first.release();
  assert.equal(admission.snapshot().active.agent, 1);
  await blocker.release();
});
