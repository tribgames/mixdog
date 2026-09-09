import assert from 'node:assert/strict';
import test from 'node:test';
import { bindCursorPreparation, prepareCursorFeedback } from './cursor-readiness.ts';

test('cursor preparation completes before dispatch without waiting forever or losing the active presenter', async () => {
  assert.equal(await prepareCursorFeedback('a'), 'unavailable');
  let release;
  const first = bindCursorPreparation(() => new Promise(resolve => { release = resolve; }));
  const timed = prepareCursorFeedback('a', 5);
  assert.equal(await timed, 'timeout');
  release();
  const calls = [];
  const second = bindCursorPreparation(async session => { calls.push(session); });
  first();
  assert.equal(await prepareCursorFeedback('b'), 'ready');
  assert.deepEqual(calls, ['b']);
  second();
  const broken = bindCursorPreparation(async () => { throw new Error('renderer failed'); });
  assert.equal(await prepareCursorFeedback('c'), 'unavailable');
  broken();
});
