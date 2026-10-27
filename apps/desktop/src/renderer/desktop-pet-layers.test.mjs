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

test('the published composer follows the card when its box moves without a window resize (side dock, sidebar, dock drag)', async (t) => {
  const frames = manualFrames();
  const observers = [];
  class RecordingResizeObserver {
    targets = new Set();
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe(target) {
      this.targets.add(target);
    }
    unobserve(target) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
    }
  }
  const { window, document, root } = installTestDom(t, {
    rootId: 'root',
    expose: ['MouseEvent', 'Event', 'HTMLElement', 'MutationObserver'],
    globals: {
      ResizeObserver: RecordingResizeObserver,
      requestAnimationFrame: frames.request,
      cancelAnimationFrame: frames.cancel,
    },
  });
  const composers = [];
  window.mixdogDesktop = {
    getDesktopPetConfig: async () => ({ enabled: true, pinned: true, keepAbove: false, collapsed: false, scale: 100 }),
    subscribeDesktopPetConfig: () => () => {},
    publishDesktopPet: () => {},
    publishDesktopPetComposer: (value) => composers.push(value),
    publishDesktopPetTheme: () => {},
    publishDesktopPetLayers: () => {},
  };
  // The conversation column and its card, in a pane.
  const pane = document.createElement('div');
  pane.className = 'pane-cell is-focused';
  const column = document.createElement('div');
  const card = document.createElement('form');
  card.className = 'composer';
  let box = { left: 300, top: 600, width: 700, height: 120 };
  card.getBoundingClientRect = () => box;
  column.append(card);
  pane.append(column);
  document.body.append(pane);

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
  assert.deepEqual(composers.at(-1), { x: 300, y: 600, width: 700, height: 120, island: null }, 'first measure');
  assert.ok(
    observers.some((observer) => observer.targets.has(column)),
    'the column around the card is observed, not only the card'
  );

  // A column resize (no window resize): the card's left moves, its size is the same.
  box = { left: 140, top: 600, width: 700, height: 120 };
  await act(async () => observers.forEach((observer) => observer.callback([])));
  assert.equal(composers.at(-1).x, 140, 'follows the column');

  // A side dock opens without resizing anything the observers watch: its
  // mount and the end of its transition measure the card again.
  const dock = document.createElement('aside');
  dock.className = 'pane-side-dock';
  box = { left: 60, top: 600, width: 700, height: 120 };
  document.body.append(dock);
  await settle();
  assert.equal(composers.at(-1).x, 60, 'dock opened');
  box = { left: 90, top: 600, width: 700, height: 120 };
  dock.dispatchEvent(new window.Event('transitionend', { bubbles: true }));
  await settle();
  assert.equal(composers.at(-1).x, 90, 'dock transition settled');

  // Unchanged: nothing is resent.
  const sent = composers.length;
  dock.dispatchEvent(new window.Event('transitionend', { bubbles: true }));
  await settle();
  assert.equal(composers.length, sent, 'same box, no publish');
});

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

test('an expanded browser/terminal surface and its widened dock header are cut out of the pet like the dock, a parked one is not', async (t) => {
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

  // The dock keeps its narrow column; the expanded surface (a fixed container
  // outside the dock) and the dock's header cover the whole main panel.
  const dock = document.createElement('aside');
  dock.className = 'pane-side-dock';
  dock.getBoundingClientRect = () => ({ left: 900, top: 40, width: 360, height: 700 });
  const header = document.createElement('div');
  header.className = 'pane-side-dock-header';
  header.getBoundingClientRect = () => ({ left: 300, top: 40, width: 960, height: 36 });
  dock.append(header);
  const surface = document.createElement('div');
  surface.className = 'session-browser-surface-container';
  surface.style.position = 'fixed';
  surface.dataset.parked = 'true';
  surface.getBoundingClientRect = () => ({ left: -10000, top: 0, width: 1280, height: 900 });
  document.body.append(dock, surface);
  await settle();
  assert.deepEqual(
    layers.at(-1),
    [{ x: 900, y: 40, width: 360, height: 700 }],
    'collapsed: the dock only, parked is off screen'
  );

  surface.dataset.parked = 'false';
  surface.dataset.expanded = 'true';
  surface.getBoundingClientRect = () => ({ left: 300, top: 76, width: 960, height: 664 });
  header.dataset.surfaceExpanded = 'true';
  header.style.position = 'fixed';
  await settle();
  assert.deepEqual(
    layers.at(-1),
    [
      { x: 900, y: 40, width: 360, height: 700 },
      { x: 300, y: 40, width: 960, height: 36 },
      { x: 300, y: 76, width: 960, height: 664 },
    ],
    'expanded: the whole panel is cut out'
  );

  surface.dataset.parked = 'true';
  delete header.dataset.surfaceExpanded;
  await settle();
  assert.deepEqual(layers.at(-1), [{ x: 900, y: 40, width: 360, height: 700 }], 'folded again');
});

test('a visualize page (HTML, PDF, image, video) shows inside the dock panel, so the dock reports it docked, overlaid at 1160px and expanded', async (t) => {
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

  // The dock host, its embedded panel, and a visualize page inside (an iframe
  // for HTML/PDF/Office pages, an img or video otherwise: all in-flow).
  const dock = document.createElement('aside');
  dock.className = 'pane-side-dock';
  const panel = document.createElement('aside');
  panel.className = 'workbench-side-panel';
  const page = document.createElement('iframe');
  panel.append(page);
  dock.append(panel);
  const place = (host, inner) => {
    dock.getBoundingClientRect = () => host;
    panel.getBoundingClientRect = () => inner;
  };
  place({ left: 940, top: 40, width: 420, height: 700 }, { left: 941, top: 76, width: 419, height: 664 });
  document.body.append(dock);
  await settle();
  assert.deepEqual(
    layers.at(-1),
    [
      { x: 940, y: 40, width: 420, height: 700 },
      { x: 941, y: 76, width: 419, height: 664 },
    ],
    'docked'
  );

  // Wider than the chat (the 1160px cap): the dock floats over the whole pane.
  dock.dataset.overlay = 'true';
  dock.style.position = 'absolute';
  dock.style.zIndex = '30';
  place({ left: 200, top: 40, width: 1160, height: 700 }, { left: 201, top: 76, width: 1159, height: 664 });
  window.dispatchEvent(new window.Event('resize'));
  await settle();
  assert.deepEqual(
    layers.at(-1),
    [
      { x: 200, y: 40, width: 1160, height: 700 },
      { x: 201, y: 76, width: 1159, height: 664 },
    ],
    'overlay at 1160px'
  );

  // Expanded: the host is a fixed sheet over the whole main panel.
  dock.dataset.expanded = 'true';
  dock.style.position = 'fixed';
  place({ left: 0, top: 0, width: 1400, height: 800 }, { left: 1, top: 36, width: 1399, height: 764 });
  window.dispatchEvent(new window.Event('resize'));
  await settle();
  assert.deepEqual(
    layers.at(-1),
    [
      { x: 0, y: 0, width: 1400, height: 800 },
      { x: 1, y: 36, width: 1399, height: 764 },
    ],
    'expanded'
  );
});

test('while no card shows (boot, a session loading), DOM and theme changes read the look once a frame, not per batch', async (t) => {
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
  const themes = [];
  window.mixdogDesktop = {
    getDesktopPetConfig: async () => ({ enabled: true, pinned: true, keepAbove: false, collapsed: false, scale: 100 }),
    subscribeDesktopPetConfig: () => () => {},
    publishDesktopPet: () => {},
    publishDesktopPetComposer: () => {},
    publishDesktopPetTheme: (theme) => themes.push(theme),
    publishDesktopPetLayers: () => {},
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
  // Each look read resolves the whole page's style (a forced style update).
  const getComputedStyle = window.getComputedStyle.bind(window);
  let looks = 0;
  window.getComputedStyle = (element, pseudo) => {
    if (element === document.documentElement) looks += 1;
    return getComputedStyle(element, pseudo);
  };
  t.after(() => {
    window.getComputedStyle = getComputedStyle;
  });
  // A view mounting in several commits, and the root's modes flipping, all
  // inside one frame.
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      document.body.append(document.createElement('div'));
      document.documentElement.setAttribute('data-step', String(index));
    });
  }
  assert.equal(looks, 0, 'nothing read before the frame');
  await act(async () => frames.run());
  assert.equal(looks, 1, 'one read in the frame');
  document.documentElement.style.setProperty('--mx-accent', 'red');
  await settle();
  assert.equal(looks, 2, 'a later theme change still publishes');
});
