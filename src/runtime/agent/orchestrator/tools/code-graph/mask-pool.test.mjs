// The off-thread mask pool bounds its outstanding work, honours abort, kills a
// stalled or crashed worker, and shuts down cleanly; every refusal rejects so
// the caller masks on its own path (#308).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import {
  _maskTextsOffThread,
  _shutdownMaskPool,
  _configureMaskPoolForTest,
  _maskPoolOutstandingChars,
} from './mask-pool.mjs';
import { _maskNonCodeText } from './text-mask.mjs';

const STALL = "require('node:worker_threads').parentPort.on('message', () => {});";
const CRASH = "require('node:worker_threads').parentPort.on('message', () => process.exit(3));";

function evalWorkers(code, counter = { spawned: 0 }) {
  return (_url, options) => {
    counter.spawned += 1;
    return new Worker(code, { ...options, eval: true });
  };
}

test.afterEach(() => _configureMaskPoolForTest());

test('outstanding work is bounded: past the cap a request is refused, not queued', async () => {
  _configureMaskPoolForTest({ createWorker: evalWorkers(STALL), maxOutstandingChars: 10 });
  const first = _maskTextsOffThread(['12345678'], ['javascript']);
  await assert.rejects(_maskTextsOffThread(['abcdefgh'], ['javascript']), { code: 'ERR_MASK_POOL_SATURATED' });
  assert.equal(_maskPoolOutstandingChars(), 8);
  _shutdownMaskPool();
  await assert.rejects(first, { code: 'ERR_MASK_POOL_SHUTDOWN' });
  assert.equal(_maskPoolOutstandingChars(), 0);
});

test('a worker past its deadline is terminated and replaced; the pool then works again', async () => {
  const counter = { spawned: 0 };
  _configureMaskPoolForTest({ createWorker: evalWorkers(STALL, counter), deadlineMs: 100 });
  await assert.rejects(_maskTextsOffThread(['a'], ['javascript']), { code: 'ERR_MASK_WORKER_DEADLINE' });
  await assert.rejects(_maskTextsOffThread(['b'], ['javascript']), { code: 'ERR_MASK_WORKER_DEADLINE' });
  assert.equal(counter.spawned, 2, 'the stalled worker was replaced, not reused');
  assert.equal(_maskPoolOutstandingChars(), 0);
  _configureMaskPoolForTest();
  const text = '// x\nconst s = "target";';
  assert.deepEqual(await _maskTextsOffThread([text], ['javascript']), [_maskNonCodeText(text, 'javascript')]);
});

test('a crashed worker rejects its request and the next request gets a new worker', async () => {
  const counter = { spawned: 0 };
  _configureMaskPoolForTest({ createWorker: evalWorkers(CRASH, counter) });
  await assert.rejects(_maskTextsOffThread(['a'], ['javascript']), { code: 'ERR_MASK_WORKER_EXITED' });
  await assert.rejects(_maskTextsOffThread(['b'], ['javascript']), { code: 'ERR_MASK_WORKER_EXITED' });
  assert.equal(counter.spawned, 2);
  assert.equal(_maskPoolOutstandingChars(), 0);
});

test('aborting a queued request drops it and releases its share of the bound', async () => {
  _configureMaskPoolForTest({ createWorker: evalWorkers(STALL) });
  // Two workers take the first two; the third waits in the queue.
  const running = [_maskTextsOffThread(['aa'], ['javascript']), _maskTextsOffThread(['bb'], ['javascript'])];
  const controller = new AbortController();
  const queued = _maskTextsOffThread(['cccc'], ['javascript'], { signal: controller.signal });
  assert.equal(_maskPoolOutstandingChars(), 8);
  controller.abort();
  await assert.rejects(queued, { code: 'ABORT_ERR' });
  assert.equal(_maskPoolOutstandingChars(), 4);
  _shutdownMaskPool();
  for (const request of running) await assert.rejects(request, { code: 'ERR_MASK_POOL_SHUTDOWN' });
});
