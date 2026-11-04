import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

test('a request unanswered past its deadline rejects, terminates the worker and the next request gets a fresh one', async () => {
  const request = createWorkerRequestClient('setInterval(() => {}, 1000);', { eval: true });
  await assert.rejects(request({}, { timeoutMs: 100 }), { code: 'ETIMEDOUT' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(request.running(), false, 'the wedged worker is detached');
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
