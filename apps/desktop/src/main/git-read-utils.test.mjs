import assert from 'node:assert/strict';
import test from 'node:test';

import { sharedRead } from './git-read-utils.ts';

test('concurrent identical reads share one follow-up read that starts after every caller asked', async () => {
  const runs = [];
  const read = sharedRead(
    (key) => key,
    (key) => {
      const run = { key, ...Promise.withResolvers() };
      runs.push(run);
      return run.promise;
    }
  );
  const first = read('repo');
  // Asked while the first read runs: none of them may be answered by it.
  const joined = [read('repo'), read('repo'), read('repo')];
  const other = read('other');
  assert.deepEqual(
    runs.map((run) => run.key),
    ['repo', 'other']
  );
  runs[0].resolve('before');
  assert.equal(await first, 'before');
  await Promise.resolve();
  assert.equal(runs.length, 3, 'one follow-up read serves every joined caller');
  runs[2].resolve('after');
  assert.deepEqual(await Promise.all(joined), ['after', 'after', 'after']);
  runs[1].resolve('other');
  assert.equal(await other, 'other');
  // Settled: the next caller starts a fresh read at once.
  const next = read('repo');
  assert.equal(runs.length, 4);
  runs[3].resolve('fresh');
  assert.equal(await next, 'fresh');
});

test('a failed read fails only its own callers; joined callers still get their own read', async () => {
  const runs = [];
  const read = sharedRead(
    () => 'repo',
    () => {
      const run = Promise.withResolvers();
      runs.push(run);
      return run.promise;
    }
  );
  const first = read();
  const joined = read();
  runs[0].reject(new Error('git failed'));
  await assert.rejects(first, /git failed/);
  await Promise.resolve();
  runs[1].resolve('ok');
  assert.equal(await joined, 'ok');
});
