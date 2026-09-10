import assert from 'node:assert/strict';
import test from 'node:test';
import { createCursorTail } from './cursor-tail.ts';

test('visual feedback survives a short completed action then expires without extending on updates', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let changed = 0;
  const tail = createCursorTail(() => changed++);
  t.after(() => tail.dispose());
  const cursor = { sessionId: 'a', eventId: 1 };
  tail.update([cursor], false);
  assert.deepEqual(tail.update([], false), [cursor]);
  t.mock.timers.tick(1000);
  assert.deepEqual(tail.update([], false), [cursor]);
  t.mock.timers.tick(500);
  assert.equal(changed, 1);
  assert.deepEqual(tail.update([], false), []);
});

test('user takeover immediately removes pending visual feedback and its deadline', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let changed = 0;
  const tail = createCursorTail(() => changed++);
  tail.update([{ sessionId: 'a', eventId: 1 }], false);
  tail.update([], false);
  assert.deepEqual(tail.update([], true), []);
  t.mock.timers.tick(2000);
  assert.equal(changed, 0);
  assert.deepEqual(tail.update([], false), []);
  tail.dispose();
});

test('a new pointer owner removes the previous halo without resurrecting older events', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const tail = createCursorTail(() => {});
  t.after(() => tail.dispose());
  const a = { sessionId: 'a', eventId: 1 };
  const b = { sessionId: 'b', eventId: 2 };
  tail.update([a], false);
  tail.update([], false);
  assert.deepEqual(tail.update([a, b], false), [b]);
  assert.deepEqual(tail.update([a], false), [b]);
  t.mock.timers.tick(1500);
  assert.deepEqual(tail.update([a], false), []);
  assert.deepEqual(tail.update([{ ...a, eventId: 3 }], false), [{ ...a, eventId: 3 }]);
});
