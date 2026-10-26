import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerRequestClient } from './worker-requests.mjs';

const ECHO_WORKER = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, payload }) => parentPort.postMessage({ id, result: payload }));
`;

const IDLE_EXIT_MS = 20;

// The idle timer is armed before a settled request's promise resolves (or, for
// a failed post, before it rejects), so once the awaited request has settled
// the retirement is only a matter of the mocked clock reaching `idleExitMs`.
function assertRetiresAfterIdleExit(t, request) {
  t.mock.timers.tick(IDLE_EXIT_MS - 1);
  assert.equal(request.running(), true, 'still attached before idleExitMs has passed');
  t.mock.timers.tick(1);
  assert.equal(request.running(), false);
}

test('a request that cannot be posted leaves no pending entry and still lets the worker retire', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const request = createWorkerRequestClient(ECHO_WORKER, { eval: true, idleExitMs: IDLE_EXIT_MS });
  assert.equal(await request('first'), 'first');
  // Functions cannot be structured-cloned: postMessage throws synchronously.
  await assert.rejects(request({ fn: () => {} }), { name: 'DataCloneError' });
  assert.equal(await request('after'), 'after');
  assertRetiresAfterIdleExit(t, request);
});

test('a failed post as the only request retires the worker once idle', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const request = createWorkerRequestClient(ECHO_WORKER, { eval: true, idleExitMs: IDLE_EXIT_MS });
  await assert.rejects(
    request(() => {}),
    { name: 'DataCloneError' }
  );
  assertRetiresAfterIdleExit(t, request);
});
