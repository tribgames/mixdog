import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act, useRef } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const resizeObservers = new Set();
const frames = new Map();
let nextFrameId = 0;

const { dom, restore } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['Node', 'Element', 'HTMLElement', 'Event', 'MutationObserver', 'getComputedStyle', 'navigator'],
  globals: {
    ResizeObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.targets = new Set();
      }
      observe(target) {
        this.targets.add(target);
        resizeObservers.add(this);
      }
      unobserve(target) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
        resizeObservers.delete(this);
      }
    },
  },
});
after(restore);

dom.window.requestAnimationFrame = (callback) => {
  const id = ++nextFrameId;
  frames.set(id, callback);
  return id;
};
dom.window.cancelAnimationFrame = (id) => {
  frames.delete(id);
};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { createRoot } = await import('react-dom/client');
const { useIslandSlotPresence } = await import('./composer-island-layout.ts');

function flushFrames() {
  const due = [...frames.values()];
  frames.clear();
  for (const callback of due) callback(0);
}

function fireResize(entries) {
  for (const observer of [...resizeObservers]) {
    const matching = entries.filter((entry) => observer.targets.has(entry.target));
    if (matching.length > 0) observer.callback(matching, observer);
  }
}

function mountSlotFixture(t, { initialWidth = 600, initialHeight = 46 } = {}) {
  let width = initialWidth;
  let stageHeight = initialHeight;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    frames.clear();
  });

  function Harness() {
    const slotRef = useRef(null);
    const islandRef = useRef(null);
    const heldHeightRef = useRef(0);
    const sessionIdRef = useRef('');
    const carriedHeightRef = useRef(0);
    useIslandSlotPresence(slotRef, islandRef, heldHeightRef, sessionIdRef, carriedHeightRef);
    return React.createElement(
      'div',
      { className: 'composer-region' },
      React.createElement(
        'div',
        {
          className: 'composer-island-slot',
          ref: (node) => {
            slotRef.current = node;
            if (node) {
              Object.defineProperty(node, 'clientWidth', { configurable: true, get: () => width });
            }
          },
        },
        React.createElement(
          'div',
          {
            className: 'composer-island-stage',
            ref: (node) => {
              if (node) {
                Object.defineProperty(node, 'clientWidth', { configurable: true, get: () => width });
                Object.defineProperty(node, 'offsetHeight', { configurable: true, get: () => stageHeight });
              }
            },
          },
          React.createElement(
            'div',
            { className: 'composer-island', 'data-mode': 'pill', ref: islandRef },
            React.createElement(
              'div',
              { className: 'composer-island-pill' },
              React.createElement('button', { type: 'button', className: 'composer-island-seg' }, 'Files')
            )
          )
        )
      )
    );
  }

  return {
    async mount() {
      await act(async () => root.render(React.createElement(Harness)));
      const slot = host.querySelector('.composer-island-slot');
      const island = host.querySelector('.composer-island');
      // Seed initial ResizeObserver measurements as a real browser delivers them on observe.
      fireResize([
        { target: slot, contentRect: { width, height: stageHeight } },
        { target: island, contentRect: { width: 200, height: stageHeight } },
      ]);
      // Arm post-first-frame transitions.
      await act(async () => flushFrames());
    },
    slot: () => host.querySelector('.composer-island-slot'),
    island: () => host.querySelector('.composer-island'),
    setGeometry(next) {
      if (next.width !== undefined) width = next.width;
      if (next.height !== undefined) stageHeight = next.height;
    },
  };
}

test('island slot snaps height immediately on width-induced wrap without 200ms data-motion easing', async (t) => {
  const view = mountSlotFixture(t, { initialWidth: 600, initialHeight: 46 });
  await view.mount();
  const slot = view.slot();
  const island = view.island();
  assert.equal(slot.style.getPropertyValue('--island-slot-height'), '46px');
  assert.equal(slot.hasAttribute('data-motion'), false);

  // Narrowing the dock wraps the island to 72px (ResizeObserver path).
  view.setGeometry({ width: 360, height: 72 });
  await act(async () => {
    fireResize([
      { target: slot, contentRect: { width: 360, height: 46 } },
      { target: island, contentRect: { width: 320, height: 72 } },
    ]);
  });
  assert.equal(slot.style.getPropertyValue('--island-slot-height'), '72px');
  assert.equal(slot.hasAttribute('data-motion'), false, 'width-induced wrap snaps without 200ms easing');

  // Same-frame fit mutation after a width change (e.g. useIslandFit setting data-fit) also snaps.
  view.setGeometry({ width: 300, height: 96 });
  await act(async () => {
    fireResize([{ target: slot, contentRect: { width: 300, height: 72 } }]);
    island.setAttribute('data-fit', 'compact');
  });
  assert.equal(slot.style.getPropertyValue('--island-slot-height'), '96px');
  assert.equal(slot.hasAttribute('data-motion'), false, 'fit mutation after width change snaps without easing');
});

test('island slot snaps height immediately on content height changes at steady width without motion easing', async (t) => {
  const view = mountSlotFixture(t, { initialWidth: 600, initialHeight: 46 });
  await view.mount();
  const slot = view.slot();
  const island = view.island();

  // Width changes without wrapping, then settles after a frame.
  view.setGeometry({ width: 520, height: 46 });
  await act(async () => {
    fireResize([{ target: slot, contentRect: { width: 520, height: 46 } }]);
    flushFrames();
  });
  assert.equal(slot.hasAttribute('data-motion'), false);

  // Content changes height at the new steady width (520px): snaps immediately with no data-motion.
  view.setGeometry({ height: 212 });
  await act(async () => {
    const approval = document.createElement('div');
    approval.className = 'composer-island-approval';
    island.setAttribute('data-mode', 'approval');
    island.append(approval);
  });
  assert.equal(slot.style.getPropertyValue('--island-slot-height'), '212px');
  assert.equal(slot.hasAttribute('data-motion'), false, 'content change at steady width snaps without easing');
});

test('continuous A -> B drag and post-drag content changes all snap without motion easing', async (t) => {
  const view = mountSlotFixture(t, { initialWidth: 600, initialHeight: 46 });
  await view.mount();
  const slot = view.slot();
  const island = view.island();

  view.setGeometry({ width: 500, height: 46 });
  await act(async () => {
    fireResize([{ target: slot, contentRect: { width: 500, height: 46 } }]);
  });

  view.setGeometry({ width: 360, height: 72 });
  await act(async () => {
    flushFrames();
    island.setAttribute('data-fit', 'compact');
  });
  assert.equal(slot.style.getPropertyValue('--island-slot-height'), '72px');
  assert.equal(slot.hasAttribute('data-motion'), false, 'B wrap snaps without transition');

  view.setGeometry({ width: 320, height: 72 });
  await act(async () => {
    fireResize([{ target: slot, contentRect: { width: 320, height: 72 } }]);
  });
  view.setGeometry({ width: 280, height: 96 });
  await act(async () => {
    fireResize([{ target: slot, contentRect: { width: 280, height: 72 } }]);
    island.setAttribute('data-fit', 'tight');
  });
  assert.equal(slot.style.getPropertyValue('--island-slot-height'), '96px');
  assert.equal(slot.hasAttribute('data-motion'), false, 'rescheduled drag width C snaps on wrap');

  await act(async () => flushFrames());
  view.setGeometry({ height: 212 });
  await act(async () => {
    const approval = document.createElement('div');
    approval.className = 'composer-island-approval';
    island.setAttribute('data-mode', 'approval');
    island.append(approval);
  });
  assert.equal(slot.style.getPropertyValue('--island-slot-height'), '212px');
  assert.equal(slot.hasAttribute('data-motion'), false, 'content change after settling snaps without easing');
});
