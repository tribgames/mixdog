import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionTitleController } from './session-title.mjs';

test('first-turn LLM title waits until visible assistant progress', async () => {
  let release;
  const after = new Promise((resolve) => { release = resolve; });
  const generated = [];
  const promoted = [];
  const controller = createSessionTitleController({
    dataRoot: () => '',
    generateSessionTitle: async (source) => {
      generated.push(source);
      return 'Deferred title';
    },
    promoteGeneratedTitle: async (...args) => {
      promoted.push(args);
      return true;
    },
  });

  assert.equal(controller.scheduleFirst(
    { id: 'session-title-deferred', messages: [] },
    'Investigate cold-start latency',
    { after },
  ), true);
  await Promise.resolve();
  assert.deepEqual(generated, []);

  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(generated, ['Investigate cold-start latency']);
  assert.deepEqual(promoted, [['session-title-deferred', 'Deferred title', 'first']]);
  controller.disposeAll();
});
