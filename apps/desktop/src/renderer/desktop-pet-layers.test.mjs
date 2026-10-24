import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

class QuietResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** Animation frames the test runs by hand: what is pending is what was scheduled. */
function manualFrames() {
  const pending = new Map();
  let next = 0;
  return {
    request: (callback) => {
      next += 1;
      pending.set(next, callback);
      return next;
    },
    cancel: (id) => {
      pending.delete(id);
    },
    get size() {
      return pending.size;
    },
    run() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback(0);
    },
  };
}

test('scroll and animationend move a layer: one publish, coalesced into one frame however many events arrive', async (t) => {
  const frames = manualFrames();
  const { window, document, root } = installTestDom(t, {
    rootId: 'root',
    expose: ['MouseEvent', 'Event', 'HTMLElement', 'MutationObserver'],
    globals: {
      ResizeObserver: QuietResizeObserver,
      requestAnimationFrame: frames.request,
      cancelAnimationFrame: frames.cancel,
    },
  });
  const layers = [];
  window.mixdogDesktop = {
    getDesktopPetConfig: async () => ({ enabled: true, pinned: true, keepAbove: false, collapsed: false, scale: 100 }),
    subscribeDesktopPetConfig: () => () => {},
    publishDesktopPet: () => {},
    publishDesktopPetComposer: () => {},
    publishDesktopPetTheme: () => {},
    publishDesktopPetLayers: (value) => layers.push(value.rects),
  };
  const publisher = await import('./desktop-pet-publisher');
  publisher.resetDesktopPetConfigForTests();
  t.after(() => publisher.resetDesktopPetConfigForTests());
  await act(async () => root.render(React.createElement(publisher.DesktopPetPublisher)));
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      while (frames.size) frames.run();
    });
  await settle();
  assert.deepEqual(layers.at(-1), [], 'mounted, nothing open');

  const scroller = document.createElement('div');
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  menu.style.position = 'fixed';
  let box = { left: 100, top: 200, width: 160, height: 80 };
  menu.getBoundingClientRect = () => box;
  scroller.append(menu);
  document.body.append(scroller);
  await settle();
  assert.deepEqual(layers.at(-1), [{ x: 100, y: 200, width: 160, height: 80 }], 'opened');
  const sent = layers.length;

  // A scroll carries it (no DOM change): scroll events do not bubble, the
  // capture listener still hears them; several arrive before the frame.
  box = { left: 100, top: 140, width: 160, height: 80 };
  for (let index = 0; index < 4; index += 1) scroller.dispatchEvent(new window.Event('scroll'));
  assert.equal(frames.size, 1, 'four scrolls, one frame');
  await act(async () => frames.run());
  assert.equal(layers.length, sent + 1, 'one publish');
  assert.deepEqual(layers.at(-1), [{ x: 100, y: 140, width: 160, height: 80 }], 'the moved rect');

  // Its entrance animation settles it elsewhere; with a scroll in the same frame.
  box = { left: 120, top: 150, width: 160, height: 80 };
  menu.dispatchEvent(new window.Event('animationend', { bubbles: true }));
  menu.dispatchEvent(new window.Event('animationend', { bubbles: true }));
  scroller.dispatchEvent(new window.Event('scroll'));
  assert.equal(frames.size, 1, 'animation ends and a scroll, one frame');
  await act(async () => frames.run());
  assert.equal(layers.length, sent + 2);
  assert.deepEqual(layers.at(-1), [{ x: 120, y: 150, width: 160, height: 80 }]);

  // Nothing moved: the frame runs, nothing is resent.
  scroller.dispatchEvent(new window.Event('scroll'));
  await act(async () => frames.run());
  assert.equal(layers.length, sent + 2, 'unchanged layers are not resent');

  // Unmounted: the listeners are gone.
  await act(async () => root.render(null));
  scroller.dispatchEvent(new window.Event('scroll'));
  menu.dispatchEvent(new window.Event('animationend', { bubbles: true }));
  assert.equal(frames.size, 0, 'no frame after unmount');
  scroller.remove();
});
