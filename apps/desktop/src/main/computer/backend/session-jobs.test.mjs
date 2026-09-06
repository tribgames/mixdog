import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionJobs } from './session-jobs.ts';

test('session cancellation waits for the correct elevated worker termination receipt', async () => {
  const jobs = createSessionJobs();
  const cancelled = [];
  const first = jobs.begin('a', () => cancelled.push('a'));
  const second = jobs.begin('b', () => cancelled.push('b'));
  let settled = false;
  const pending = jobs.cancel('a').then((value) => { settled = true; return value; });
  await Promise.resolve();
  assert.deepEqual(cancelled, ['a']);
  assert.equal(settled, false);
  first.finish(true);
  assert.equal(await pending, true);
  assert.deepEqual(jobs.sessionIds(), ['b']);
  second.finish(true);
});

test('unconfirmed elevated termination never authorizes subsequent input', async () => {
  const jobs = createSessionJobs(1);
  const job = jobs.begin('a', () => {});
  assert.equal(await jobs.cancel('a'), false);
  job.finish(false);
  assert.equal(await jobs.cancel('a'), false);
  assert.throws(() => jobs.assertClear(), /privileged_worker_cleanup_unconfirmed/);
  assert.deepEqual(jobs.sessionIds(), ['a']);
});
