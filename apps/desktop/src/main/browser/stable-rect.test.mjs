import assert from 'node:assert/strict';
import test from 'node:test';
import { BROWSER_STABLE_RECT } from './stable-rect.ts';

const stableRect = new Function(`return (${BROWSER_STABLE_RECT})`)();
function fixture() {
  let rect = { left: 0, top: 0, width: 20, height: 20 };
  let paint;
  const view = {
    setTimeout, clearTimeout,
    requestAnimationFrame: (callback) => { paint = callback; return 1; },
    cancelAnimationFrame: () => { paint = undefined; },
  };
  const target = {
    ownerDocument: { defaultView: view },
    scrollIntoView: ({ behavior }) => {
      assert.equal(behavior, 'instant');
      rect = { ...rect, top: 100 };
    },
    getBoundingClientRect: () => ({ ...rect }),
  };
  return { target, view, move: (change) => { rect = { ...rect, ...change }; }, paint: () => paint?.() };
}

test('scroll layout is sampled before the next paint, and movement or resizing is refused', async () => {
  for (const change of [{ left: 10 }, { top: 110 }, { width: 40 }, { height: 40 }]) {
    const f = fixture();
    const pending = stableRect(f.target);
    f.move(change);
    f.paint();
    assert.equal(await pending, null);
  }
});

test('an instant ancestor scroll is reflected in both samples, without losing the final rectangle', async () => {
  const f = fixture();
  const pending = stableRect(f.target, [{
    scrollIntoView: ({ behavior }) => {
      assert.equal(behavior, 'instant');
      f.move({ left: 50 });
    },
  }]);
  f.paint();
  assert.deepEqual(await pending, { left: 50, top: 100, width: 20, height: 20 });
});

test('a throttled frame still compares geometry and cancels its pending callback', async () => {
  const f = fixture();
  let cancelled = false;
  f.view.cancelAnimationFrame = () => { cancelled = true; };
  const pending = stableRect(f.target);
  f.move({ left: 10 });
  assert.equal(await pending, null);
  assert.equal(cancelled, true);
});
