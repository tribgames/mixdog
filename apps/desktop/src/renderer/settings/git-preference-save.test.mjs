import assert from 'node:assert/strict';
import test from 'node:test';

import { createGitPreferenceSaveQueue } from './git-preference-save.ts';

const preferences = (patch = {}) => ({
  commitPreset: 'none',
  commitExample: '',
  commitInstructions: '',
  autoCommitMessage: true,
  ...patch,
});

test('git preference saves stay serialized and publish only the final snapshot', async () => {
  let durable = preferences();
  let active = 0;
  const events = [];
  const saver = createGitPreferenceSaveQueue({
    async update(patch) {
      assert.equal(active, 0);
      active += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      durable = { ...durable, ...patch };
      active -= 1;
      return durable;
    },
    async read() { return durable; },
    onBusy: (field, busy) => events.push(['busy', field, busy]),
    onResult: (field, value, context) => events.push(['result', field, value, context]),
    onError: (error) => { throw error; },
  });

  await Promise.all([
    saver.save('preset', { commitPreset: 'conventional' }),
    saver.save('auto', { autoCommitMessage: false }),
  ]);

  const results = events.filter(([kind]) => kind === 'result');
  assert.equal(results.length, 2);
  assert.equal(results[0][3].publish, false);
  assert.equal(results[1][3].publish, true);
  assert.equal(results[1][2].commitPreset, 'conventional');
  assert.equal(results[1][2].autoCommitMessage, false);
});

test('a failed save re-reads durable preferences and recovers only its field', async () => {
  const durable = preferences({ commitPreset: 'none', autoCommitMessage: false });
  const results = [];
  const errors = [];
  const saver = createGitPreferenceSaveQueue({
    async update() { throw new Error('socket hang up'); },
    async read() { return durable; },
    onBusy() {},
    onResult: (field, value, context) => results.push({ field, value, context }),
    onError: (error) => errors.push(error),
  });

  await saver.save('preset', { commitPreset: 'custom' });
  assert.equal(results.length, 1);
  assert.equal(results[0].field, 'preset');
  assert.equal(results[0].value.autoCommitMessage, false);
  assert.equal(results[0].context.recovered, true);
  assert.equal(errors[0].message, 'socket hang up');
});
