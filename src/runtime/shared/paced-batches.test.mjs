import assert from 'node:assert/strict';
import test from 'node:test';

import { runInPacedBatches } from './paced-batches.mjs';

test('items run in order, a batch at a time, with the event loop turning between batches', async () => {
  const log = [];
  let turns = 0;
  const timer = setInterval(() => {}, 1);
  const spin = () => setImmediate(function again() {
    turns += 1;
    if (!done) setImmediate(again);
  });
  let done = false;
  spin();
  const seenTurns = [];
  await runInPacedBatches(
    Array.from({ length: 10 }, (_, i) => i),
    async (item) => {
      log.push(item);
      seenTurns.push(turns);
    },
    { batchSize: 4 }
  );
  done = true;
  clearInterval(timer);
  assert.deepEqual(log, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // Items of one batch share a turn; each new batch starts on a later one.
  assert.equal(new Set(seenTurns.slice(0, 4)).size, 1);
  assert.ok(seenTurns[4] > seenTurns[3] && seenTurns[8] > seenTurns[7]);
});
