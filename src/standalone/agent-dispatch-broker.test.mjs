import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentDispatchBroker } from './agent-dispatch-broker.mjs';

function unreadablePreset() {
  return new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('preset cannot be inspected');
      },
    }
  );
}

for (const firstUnreadable of [false, true]) {
  test(`unreadable ${firstUnreadable ? 'original' : 'retry'} identity cannot authorize a dispatch replay`, async () => {
    const finish = Promise.withResolvers();
    let calls = 0;
    const broker = createAgentDispatchBroker({
      dispatchAgent: async () => {
        calls += 1;
        await finish.promise;
        return 'original';
      },
    });
    const original = broker.dispatch(
      {
        agent: 'cycle1-agent',
        prompt: 'work',
        preset: firstUnreadable ? unreadablePreset() : { model: 'first' },
      },
      { callId: 'dispatch' }
    );
    try {
      const retry = broker.dispatch(
        {
          agent: 'cycle1-agent',
          prompt: 'work',
          preset: firstUnreadable ? { model: 'different' } : unreadablePreset(),
        },
        { callId: 'dispatch' }
      );
      finish.resolve();
      await assert.rejects(retry, { code: 'ECALLIDCONFLICT' });
    } finally {
      finish.resolve();
      assert.equal(await original, 'original');
      broker.close();
    }
    assert.equal(calls, 1);
  });
}

test('matching concurrent dispatches execute once and a settled call id is reusable', async () => {
  const finish = Promise.withResolvers();
  let calls = 0;
  const broker = createAgentDispatchBroker({
    dispatchAgent: async () => {
      const value = ++calls;
      await finish.promise;
      return value;
    },
  });
  const params = { agent: 'cycle1-agent', prompt: 'work', preset: { model: 'same' } };
  const first = broker.dispatch(params, { callId: 'dispatch' });
  const retry = broker.dispatch(structuredClone(params), { callId: 'dispatch' });
  finish.resolve();
  assert.deepEqual(await Promise.all([first, retry]), [1, 1]);
  assert.equal(await broker.dispatch(params, { callId: 'dispatch' }), 2);
  assert.equal(broker.snapshot().inFlight, 0);
  broker.close();
});

test('caller cancellation reaches a running dispatch and retains its reason', async () => {
  const entered = Promise.withResolvers();
  const controller = new AbortController();
  const reason = new Error('caller canceled');
  const broker = createAgentDispatchBroker({
    dispatchAgent: async (_payload, { signal }) => {
      entered.resolve();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  const pending = broker.dispatch(
    { agent: 'cycle1-agent', prompt: 'work' },
    {
      callId: 'cancel-me',
      signal: controller.signal,
    }
  );
  const rejected = assert.rejects(pending, (error) => error === reason);
  await entered.promise;
  controller.abort(reason);
  await rejected;
  assert.equal(broker.snapshot().inFlight, 0);
  broker.close();
});
