import assert from 'node:assert/strict';
import test from 'node:test';
import { createCursorTail } from './cursor-tail.ts';

test('visual feedback survives a short completed action then expires without extending on updates', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let changed = 0;
  const tail = createCursorTail(() => changed++);
  t.after(() => tail.dispose());
  const cursor = { sessionId: 'a', eventId: 1, mode: 'background' };
  tail.update([cursor], false);
  assert.deepEqual(tail.update([], false), [cursor]);
  t.mock.timers.tick(1000);
  assert.deepEqual(tail.update([], false), [cursor]);
  t.mock.timers.tick(500);
  assert.equal(changed, 1);
  assert.deepEqual(tail.update([], false), []);
});

test('user takeover immediately removes pending visual feedback and its deadline', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let changed = 0;
  const tail = createCursorTail(() => changed++);
  tail.update([{ sessionId: 'a', eventId: 1, mode: 'background' }], false);
  tail.update([], false);
  assert.deepEqual(tail.update([], true), []);
  t.mock.timers.tick(2000);
  assert.equal(changed, 0);
  assert.deepEqual(tail.update([], false), []);
  tail.dispose();
});

test('a new pointer owner removes the previous halo without resurrecting older events', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const tail = createCursorTail(() => {});
  t.after(() => tail.dispose());
  const a = { sessionId: 'a', eventId: 1, mode: 'foreground' };
  const b = { sessionId: 'b', eventId: 2, mode: 'foreground' };
  tail.update([a], false);
  tail.update([], false);
  assert.deepEqual(tail.update([a, b], false), [b]);
  assert.deepEqual(tail.update([a], false), [b]);
  t.mock.timers.tick(1500);
  assert.deepEqual(tail.update([a], false), []);
  assert.deepEqual(tail.update([{ ...a, eventId: 3 }], false), [{ ...a, eventId: 3 }]);
});

test('both delivery modes retain feedback, but a mode switch cannot replay it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const tail = createCursorTail(() => {});
  t.after(() => tail.dispose());
  const background = { sessionId: 'a', eventId: 1, mode: 'background' };
  assert.deepEqual(tail.update([background], false), [background]);
  assert.deepEqual(tail.update([], false), [background]);
  assert.deepEqual(tail.update([], false, new Map([['a', 'foreground']])), []);
  const foreground = { ...background, eventId: 2, mode: 'foreground' };
  assert.deepEqual(tail.update([foreground], false), [foreground]);
  assert.deepEqual(tail.update([], false, new Map([['a', 'background']])), []);
});

test('background sessions stay visible independently while another session acts and finishes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const tail = createCursorTail(() => {});
  t.after(() => tail.dispose());
  const a = { sessionId: 'a', eventId: 1, mode: 'background', effect: 'type' };
  const b = { sessionId: 'b', eventId: 2, mode: 'background', effect: 'click' };
  assert.deepEqual(tail.update([a, b], false), [a, b]);
  tail.update([a], false);
  t.mock.timers.tick(1500);
  assert.deepEqual(tail.update([a], false), [a], 'finishing B must not hide ongoing A');
});

test('foreground ownership changes do not evict independent background pointers', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const tail = createCursorTail(() => {});
  t.after(() => tail.dispose());
  const a = { sessionId: 'a', eventId: 1, mode: 'background' };
  const b = { sessionId: 'b', eventId: 2, mode: 'foreground' };
  const c = { sessionId: 'c', eventId: 3, mode: 'foreground' };
  assert.deepEqual(tail.update([a, b], false), [a, b]);
  assert.deepEqual(tail.update([a, b, c], false), [a, c]);
  tail.update([a, b], false);
  t.mock.timers.tick(1500);
  assert.deepEqual(tail.update([a, b], false), [a]);
});

test('a session still using the computer keeps its last cursor in either mode until it leaves', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let changed = 0;
  const tail = createCursorTail(() => changed++);
  t.after(() => tail.dispose());
  let eventId = 0;
  for (const mode of ['background', 'foreground']) {
    const modes = new Map([['a', mode]]);
    const cursor = { sessionId: 'a', eventId: ++eventId, mode };
    assert.deepEqual(tail.update([cursor], false, modes), [cursor]);
    assert.deepEqual(tail.update([], false, modes), [cursor]);
    t.mock.timers.tick(60_000);
    assert.deepEqual(tail.update([], false, modes), [cursor], 'thinking between commands keeps the arrow');
    assert.deepEqual(tail.update([], false, new Map()), [], 'leaving the computer removes it at once');
  }
  const modes = new Map([['a', 'foreground']]);
  tail.update([{ sessionId: 'a', eventId: ++eventId, mode: 'foreground' }], false, modes);
  assert.deepEqual(tail.update([], true, modes), [], 'interruption hides immediately');
  assert.equal(changed, 0, 'no deadline is left behind');
});

test('ending sessions immediately clears their tails and timers without accepting late events', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let changes = 0;
  const tail = createCursorTail(() => changes++);
  t.after(() => tail.dispose());
  const cursors = Array.from({ length: 200 }, (_, index) => ({
    sessionId: `session-${index}`,
    eventId: index + 1,
    mode: 'background',
  }));
  const modes = new Map(cursors.map((cursor) => [cursor.sessionId, cursor.mode]));
  assert.equal(tail.update(cursors, false, modes).length, 200);
  tail.update([], false, modes);
  assert.deepEqual(tail.update(cursors, false, new Map()), []);
  t.mock.timers.tick(2000);
  assert.equal(changes, 0, 'ended-session deadlines must be cancelled, not merely hidden');
  assert.deepEqual(tail.update([], false, new Map()), []);
});
