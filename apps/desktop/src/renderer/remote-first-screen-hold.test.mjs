import assert from 'node:assert/strict';
import test from 'node:test';
import { createFirstScreenHold } from './remote-first-screen-hold.ts';

const target = (extra = {}) => {
  const bus = new EventTarget();
  return Object.assign(bus, extra, {
    listeners: 0,
    addEventListener(type, fn) {
      this.listeners += 1;
      EventTarget.prototype.addEventListener.call(this, type, fn);
    },
    removeEventListener(type, fn) {
      this.listeners -= 1;
      EventTarget.prototype.removeEventListener.call(this, type, fn);
    },
  });
};
const settledState = async (promise) => (await Promise.race([promise.then(() => 'settled'), Promise.resolve('pending')]));

test('first screen hold: only the page\'s first peer is held, a reconnect\'s peer never is', async () => {
  const win = target();
  const doc = target({ visibilityState: 'visible' });
  const hold = createFirstScreenHold(win, doc);
  const first = hold();
  assert.ok(first, 'the first peer is held');
  assert.equal(await settledState(first), 'pending');
  assert.equal(hold(), undefined, 'the second peer (a reconnect) is not held');
  win.dispatchEvent(new Event('mixdog:startup-settled'));
  await first;
  assert.equal(hold(), undefined, 'nor after the first settled');
});

test('first screen hold: releases at once when the page becomes hidden, and drops its listeners', async () => {
  const win = target();
  const doc = target({ visibilityState: 'visible' });
  const first = createFirstScreenHold(win, doc)();
  assert.equal(win.listeners + doc.listeners, 2);
  doc.visibilityState = 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
  await first;
  assert.equal(win.listeners + doc.listeners, 0, 'nothing stays armed after the release');
});

test('first screen hold: a page already hidden or already settled is not held', async () => {
  await createFirstScreenHold(target(), target({ visibilityState: 'hidden' }))();
  await createFirstScreenHold(target({ __mixdogStartupSettled: true }), target({ visibilityState: 'visible' }))();
});

test('first screen hold: a page that shows its first screen releases through the event, with no timer', async () => {
  const win = target();
  const doc = target({ visibilityState: 'visible' });
  const first = createFirstScreenHold(win, doc)();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await settledState(first), 'pending', 'it waits for the event, not for time');
  win.dispatchEvent(new Event('mixdog:startup-settled'));
  assert.equal(win.listeners + doc.listeners, 0);
  await first;
});
