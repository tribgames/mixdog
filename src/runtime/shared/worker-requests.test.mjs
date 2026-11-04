import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createWorkerRequestClient, createWorkerRequestPool } from './worker-requests.mjs';

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

test('a request unanswered past its deadline rejects, terminates the worker and the next request gets a fresh one', async () => {
  const request = createWorkerRequestClient('setInterval(() => {}, 1000);', { eval: true });
  await assert.rejects(request({}, { timeoutMs: 100 }), { code: 'ETIMEDOUT' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(request.running(), false, 'the wedged worker is detached');
});

test('errors name an inline-source worker by its label, never by its source', async () => {
  const request = createWorkerRequestClient('setInterval(() => {}, 1000);', { eval: true, label: 'inline-test' });
  const error = await request({}, { timeoutMs: 50 }).catch((caught) => caught);
  assert.equal(error.code, 'ETIMEDOUT');
  assert.match(error.message, /: inline-test$/);
});

test('a post that throws while holds are open leaves the worker referenced', () => {
  // An isolated process with nothing else pending: only the held worker can keep
  // it alive until the worker's late event arrives.
  const workerUrl = new URL('./worker-requests.mjs', import.meta.url).href;
  const script = `
    import { createWorkerRequestClient } from ${JSON.stringify(workerUrl)};
    let arrived;
    const late = new Promise((resolve) => { arrived = resolve; });
    const request = createWorkerRequestClient(
      "setTimeout(() => require('node:worker_threads').parentPort.postMessage({ event: 'late' }), 300);",
      { eval: true, onEvent: () => { console.log('EVENT'); release(); release(); arrived(); } }
    );
    const releases = [request.hold(), request.hold()];
    const release = () => releases.shift()?.();
    try { await request({ uncloneable() {} }); } catch { console.log('REJECTED'); }
    await late;
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.match(result.stdout, /REJECTED/);
  assert.match(result.stdout, /EVENT/, `exit ${result.status}: ${result.stderr}`);
  assert.equal(result.status, 0);
});

// Answers with its thread after holding it for `payload` ms, as a synchronous
// process creation holds its worker's thread.
const BLOCKING_WORKER = `
const { parentPort, threadId } = require('node:worker_threads');
parentPort.on('message', ({ id, payload }) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, payload);
  parentPort.postMessage({ id, result: threadId });
});
`;

test('a pool serves requests that block their worker on different workers', async () => {
  const request = createWorkerRequestPool(BLOCKING_WORKER, { size: 3, eval: true });
  const threads = await Promise.all([150, 150, 150].map((ms) => request(ms)));
  assert.equal(new Set(threads).size, 3, 'each concurrent request had a worker of its own');
  // More overlapping requests than workers share them rather than growing the pool.
  const more = await Promise.all([20, 20, 20, 20].map((ms) => request(ms)));
  assert.ok(more.every((thread) => threads.includes(thread)));
});

test('a pool starts one more worker only while the earlier ones are busy', async () => {
  const request = createWorkerRequestPool(BLOCKING_WORKER, { size: 3, eval: true });
  assert.equal(request.running(), false);
  const threads = [await request(1), await request(1), await request(1)];
  assert.equal(new Set(threads).size, 1, 'sequential requests reuse the first worker');
});
test('a pool grows under load and shrinks back to one warm worker once idle', async () => {
  const request = createWorkerRequestPool(BLOCKING_WORKER, { size: 3, idleExitMs: 40, eval: true });
  await Promise.all([100, 100, 100].map((ms) => request(ms)));
  assert.equal(request.workers(), 3, 'the burst started a worker per concurrent request');
  const deadline = Date.now() + 5_000;
  while (request.workers() > 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(request.workers(), 1, 'the extra workers retired; the first stays attached');
  // The retired workers are replaced when the next burst needs them.
  const threads = await Promise.all([60, 60, 60].map((ms) => request(ms)));
  assert.equal(new Set(threads).size, 3);
});

test('a failed worker request keeps the timing its worker attached to the error', async () => {
  const request = createWorkerRequestClient(
    `const { parentPort } = require('node:worker_threads');
     parentPort.on('message', ({ id }) => parentPort.postMessage({ id, error: { message: 'x', code: 'EX', timing: { queueMs: 3, spawnMs: 4 } } }));`,
    { eval: true }
  );
  await assert.rejects(request({}), (error) => error.code === 'EX' && error.timing.spawnMs === 4);
});