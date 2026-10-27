import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalSessionBridge } from './daemon-local-session-bridge.mjs';

const bridgeWith = (handleCall) =>
  createLocalSessionBridge({
    getSessionService: () => ({ handleCall, releaseClient() {} }),
    log() {},
    pid: 1,
  });

test('a call without a signal reaches the service as before', async () => {
  const calls = [];
  const client = bridgeWith(async (name, args, ctx) => {
    calls.push([name, args, ctx]);
    return 'ok';
  }).attach();
  assert.equal(await client.read({ sessionId: 's' }, { callId: 'c1' }), 'ok');
  assert.deepEqual(calls, [['session.read', { sessionId: 's' }, { clientToken: 'daemon_local_1_1', callId: 'c1' }]]);
});

test('an aborted call rejects with the abort reason while the service call is still pending', async () => {
  let seen;
  const client = bridgeWith((name, args, ctx) => {
    seen = ctx.signal;
    return new Promise(() => {});
  }).attach();
  const controller = new AbortController();
  const call = client.read({ sessionId: 's' }, { signal: controller.signal });
  assert.equal(seen, controller.signal);
  const reason = new Error('deadline');
  controller.abort(reason);
  await assert.rejects(call, (error) => error === reason);
  assert.throws(
    () => client.read({ sessionId: 's' }, { signal: controller.signal }),
    (error) => error === reason
  );
});
