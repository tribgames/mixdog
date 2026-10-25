import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

// A list mounting its running marks starts many loops in one frame. Each
// lock writes a start time, which invalidates style: a loop list read after
// such a write forced another full style update, so a burst of N starts cost
// N style updates in one task (a long task after every reload and reconnect).
test('a burst of loop starts locks in one pass that reads every loop before writing any', async (t) => {
  const { window } = installTestDom(t, { expose: ['Element', 'MutationObserver'] });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const frames = [];
  globalThis.requestAnimationFrame = window.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame = () => {};
  t.after(() => {
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  });
  const { installDecorativeMotionSync } = await import('./decorative-motion-sync.ts');
  let written = false;
  let readsAfterWrite = 0;
  const loops = [];
  const host = window.document.createElement('section');
  window.document.body.append(host);
  for (let index = 0; index < 4; index += 1) {
    const mark = window.document.createElement('span');
    let startTime = 120 + index;
    const loop = {
      animationName: 'live-activity-logo-spin',
      playState: 'running',
      get startTime() {
        return startTime;
      },
      set startTime(value) {
        written = true;
        startTime = value;
      },
    };
    loops.push(loop);
    mark.getAnimations = () => {
      if (written) readsAfterWrite += 1;
      return [loop];
    };
    host.append(mark);
  }
  const stop = installDecorativeMotionSync(window.document.documentElement);
  t.after(stop);
  for (const mark of host.children) {
    const event = new window.Event('animationstart', { bubbles: true });
    event.animationName = 'live-activity-logo-spin';
    mark.dispatchEvent(event);
  }
  for (const frame of frames.splice(0)) frame(0);
  assert.deepEqual(
    loops.map((loop) => loop.startTime),
    [0, 0, 0, 0]
  );
  assert.equal(readsAfterWrite, 0);
});
