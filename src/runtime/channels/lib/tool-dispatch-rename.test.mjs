import '../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scheduler } from './scheduler.mjs';
import { createToolDispatch } from './tool-dispatch.mjs';

// The worker's rename_schedule: the scheduler that owns the runs performs the
// run check and the row move as one step.
function dispatchOver(scheduler, moves) {
  return createToolDispatch({
    isChannelsDegraded: () => false,
    lifecycle: {
      renameSchedule: (name, def, opts) =>
        scheduler.renameLocked(name, async () => {
          moves.push([name, def.name, opts.timingChanged]);
          return { name: def.name };
        }),
    },
  }).handleToolCall;
}

test('rename_schedule moves the row of an idle schedule and answers it as JSON', async () => {
  const scheduler = new Scheduler([], []);
  const moves = [];
  const result = await dispatchOver(scheduler, moves)('rename_schedule', {
    name: 'a',
    def: { name: 'b' },
    timingChanged: true,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), { name: 'b' });
  assert.deepEqual(moves, [['a', 'b', true]]);
  assert.equal(scheduler.renaming.size, 0);
});

test('rename_schedule is refused, and moves nothing, while the worker runs that schedule', async () => {
  const scheduler = new Scheduler([], []);
  scheduler.running.add('a');
  const moves = [];
  const result = await dispatchOver(scheduler, moves)('rename_schedule', { name: 'a', def: { name: 'b' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Schedule "a" is running/);
  assert.deepEqual(moves, []);
});
