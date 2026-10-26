import assert from 'node:assert/strict';
import test from 'node:test';
import { createSharedAbortable } from './abort-race.mjs';

test('a shared operation joined first by an already-aborted caller starts nothing until a live caller joins', async () => {
  const starts = [];
  const shared = createSharedAbortable(async (signal) => {
    starts.push(signal);
    return 'ready';
  });
  const aborted = AbortSignal.abort(new Error('closed'));
  await assert.rejects(shared.join(aborted), /closed/);
  assert.equal(starts.length, 0, 'the aborted caller started nothing');
  assert.equal(shared.promise, null);

  assert.equal(await shared.join(new AbortController().signal), 'ready');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].aborted, false);
});
