import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createFairCallScheduler } from './fair-call-scheduler.mjs';

function fixture(activeMax) {
  const dispatches = [];
  const scheduler = createFairCallScheduler({
    activeMax,
    schedule: (dispatch) => dispatches.push(dispatch),
  });
  return {
    scheduler,
    admit() { dispatches.shift()?.(); },
  };
}

for (const activeMax of [1, Infinity]) {
  for (const stopping of ['abort', 'close']) {
    test(`${stopping} before invocation prevents an admitted call from starting (limit=${activeMax})`, async () => {
      const { scheduler, admit } = fixture(activeMax);
      const controller = new AbortController();
      const reason = new Error('canceled before invocation');
      let calls = 0;
      const pending = scheduler.enqueue('owner', () => { calls += 1; }, { signal: controller.signal });
      admit();
      if (stopping === 'abort') controller.abort(reason);
      else scheduler.close('transport stopped');
      await assert.rejects(pending, (error) => stopping === 'abort'
        ? error === reason
        : error.statusCode === 503 && error.message === 'transport stopped');
      await setImmediate();
      assert.equal(calls, 0);
      assert.equal(scheduler.active, 0);
      assert.equal(scheduler.queued, 0);
      assert.equal(scheduler.snapshot().owners, 0);
      scheduler.close();
    });
  }

  test(`cancellation and closure do not revoke a call that already started (limit=${activeMax})`, async () => {
    const { scheduler, admit } = fixture(activeMax);
    const controller = new AbortController();
    const entered = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const pending = scheduler.enqueue('owner', async () => {
      entered.resolve();
      await finish.promise;
      return 'completed';
    }, { signal: controller.signal });
    admit();
    await entered.promise;
    controller.abort(new Error('late cancellation'));
    scheduler.close();
    finish.resolve();
    assert.equal(await pending, 'completed');
    await setImmediate();
    assert.equal(scheduler.active, 0);
    assert.equal(scheduler.snapshot().owners, 0);
  });
}
