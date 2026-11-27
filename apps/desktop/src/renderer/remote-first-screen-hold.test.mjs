import assert from 'node:assert/strict';
import test from 'node:test';
import { announceShellPainted, createFirstPaintHold } from './remote-first-screen-hold.ts';

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

/** A window whose frames run only when the test says so. */
const framedWindow = () => {
  const frames = [];
  const win = target({
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
  });
  const frame = () => {
    for (const callback of frames.splice(0)) callback();
  };
  return { win, frame };
};

test('first paint hold: only the page\'s first peer is held, a reconnect\'s peer never is', async () => {
  const win = target();
  const doc = target({ visibilityState: 'visible' });
  const hold = createFirstPaintHold(win, doc);
  const first = hold();
  assert.ok(first, 'the first peer is held');
  assert.equal(await settledState(first), 'pending');
  assert.equal(hold(), undefined, 'the second peer (a reconnect) is not held');
  win.dispatchEvent(new Event('mixdog:shell-painted'));
  await first;
  assert.equal(hold(), undefined, 'nor after the first settled');
});

test('first paint hold: releases at once when the page becomes hidden, and drops its listeners', async () => {
  const win = target();
  const doc = target({ visibilityState: 'visible' });
  const first = createFirstPaintHold(win, doc)();
  assert.equal(win.listeners + doc.listeners, 2);
  doc.visibilityState = 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
  await first;
  assert.equal(win.listeners + doc.listeners, 0, 'nothing stays armed after the release');
});

test('first paint hold: a page already hidden or already painted is not held', async () => {
  await createFirstPaintHold(target(), target({ visibilityState: 'hidden' }))();
  await createFirstPaintHold(target({ __mixdogShellPainted: true }), target({ visibilityState: 'visible' }))();
});

test('first paint hold: the startup restore does not hold the offer; the shell\'s first painted frame releases it', async () => {
  const { win, frame } = framedWindow();
  const doc = target({ visibilityState: 'visible' });
  const first = createFirstPaintHold(win, doc)();
  announceShellPainted(win);
  frame();
  assert.equal(await settledState(first), 'pending', 'the frame that paints the committed shell is not past yet');
  win.dispatchEvent(new Event('mixdog:startup-settled'));
  assert.equal(await settledState(first), 'pending', 'the first screen\'s data is not what the hold waits for');
  frame();
  await first;
  assert.equal(win.__mixdogShellPainted, true, 'a later first peer finds the shell painted');
  assert.equal(win.listeners + doc.listeners, 0, 'nothing stays armed after the release');
});
