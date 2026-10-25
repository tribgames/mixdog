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
  const scheduler = new Scheduler([]);
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
  const scheduler = new Scheduler([]);
  scheduler.running.add('a');
  const moves = [];
  const result = await dispatchOver(scheduler, moves)('rename_schedule', { name: 'a', def: { name: 'b' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Schedule "a" is running/);
  // The refusal keeps its code and name for the app to show it translated.
  assert.equal(result.code, 'SCHEDULE_RENAME_RUNNING');
  assert.deepEqual(result.details, { name: 'a' });
  assert.deepEqual(moves, []);
});

test('a failure without a schedule code carries neither its code nor its details', async () => {
  const { handleToolCall } = createToolDispatch({
    isChannelsDegraded: () => false,
    lifecycle: {
      reloadRuntimeConfig: async () => {
        throw Object.assign(new Error('config unreadable'), { code: 'EACCES', details: { privateToken: 'tok_secret' } });
      },
    },
  });
  const result = await handleToolCall('reload_config', {});
  assert.equal(result.isError, true);
  assert.equal(Object.hasOwn(result, 'code'), false);
  assert.equal(Object.hasOwn(result, 'details'), false);
  assert.doesNotMatch(JSON.stringify(result), /tok_secret/);
});

test('a schedule refusal carries only its public name, never other details', async () => {
  const { handleToolCall } = createToolDispatch({
    isChannelsDegraded: () => false,
    lifecycle: {
      renameSchedule: async () => {
        throw Object.assign(new Error('Schedule "a" is running.'), {
          code: 'SCHEDULE_RENAME_RUNNING',
          details: { name: 'a', privateToken: 'tok_secret' },
        });
      },
    },
  });
  const result = await handleToolCall('rename_schedule', { name: 'a', def: { name: 'b' } });
  assert.equal(result.code, 'SCHEDULE_RENAME_RUNNING');
  assert.deepEqual(result.details, { name: 'a' });
  assert.doesNotMatch(JSON.stringify(result), /tok_secret/);
});
