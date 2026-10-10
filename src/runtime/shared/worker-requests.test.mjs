import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createWorkerRequestClient } from './worker-requests.mjs';

const ECHO_WORKER = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, payload }) => parentPort.postMessage({ id, result: payload }));
`;

test('a request that cannot be posted leaves no pending entry and still lets the worker retire', async () => {
  const request = createWorkerRequestClient(ECHO_WORKER, { eval: true, idleExitMs: 20 });
  assert.equal(await request('first'), 'first');
  // Functions cannot be structured-cloned: postMessage throws synchronously.
  await assert.rejects(request({ fn: () => {} }), { name: 'DataCloneError' });
  assert.equal(await request('after'), 'after');
  await delay(200);
  assert.equal(request.running(), false);
});

test('a failed post as the only request retires the worker once idle', async () => {
  const request = createWorkerRequestClient(ECHO_WORKER, { eval: true, idleExitMs: 20 });
  await assert.rejects(
    request(() => {}),
    { name: 'DataCloneError' }
  );
  await delay(200);
  assert.equal(request.running(), false);
});
