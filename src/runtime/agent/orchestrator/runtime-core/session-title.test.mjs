import assert from 'node:assert/strict';
import test from 'node:test';

import { compactSessionTitle, createSessionTitleController } from './session-title.mjs';

test('compactSessionTitle never splits a surrogate pair or emoji when clipping', () => {
  const korean = '가'.repeat(30);
  for (const tail of ['😀😀', '👨‍👩‍👧 family']) {
    const title = compactSessionTitle(`${korean}${tail}`);
    assert.ok(title.length <= 32, `${title.length}`);
    assert.doesNotMatch(title, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    assert.ok(title.startsWith(korean));
    assert.ok(title.endsWith('…'));
  }
  // Unchanged behavior: short text passes through, ASCII clips at a word boundary.
  assert.equal(compactSessionTitle('Fix the login redirect bug now please ok'), 'Fix the login redirect bug now…');
});

test('first-turn LLM title waits until visible assistant progress', async () => {
  let release;
  const after = new Promise((resolve) => {
    release = resolve;
  });
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

  assert.equal(
    controller.scheduleFirst({ id: 'session-title-deferred', messages: [] }, 'Investigate cold-start latency', {
      after,
    }),
    true
  );
  await Promise.resolve();
  assert.deepEqual(generated, []);

  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(generated, ['Investigate cold-start latency']);
  assert.deepEqual(promoted, [['session-title-deferred', 'Deferred title', 'first']]);
  controller.disposeAll();
});
