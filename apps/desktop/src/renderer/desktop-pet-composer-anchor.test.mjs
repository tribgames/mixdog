import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

// No size notification ever arrives: the card moves under observers that only
// hear size changes of the boxes they watch.
class QuietResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

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

test('the overlay re-anchors when the composer flips between the one-line bar and the card, with no resize or transition event', async (t) => {
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
  const composers = [];
  window.mixdogDesktop = {
    getDesktopPetConfig: async () => ({ enabled: true, pinned: true, keepAbove: false, collapsed: false, scale: 100 }),
    subscribeDesktopPetConfig: () => () => {},
    publishDesktopPet: () => {},
    publishDesktopPetComposer: (value) => composers.push(value),
    publishDesktopPetTheme: () => {},
    publishDesktopPetLayers: () => {},
  };
  const pane = document.createElement('div');
  pane.className = 'pane-cell is-focused';
  const region = document.createElement('div');
  region.className = 'composer-region';
  const card = document.createElement('form');
  card.className = 'composer';
  // The one-line bar, bottom-anchored in the window.
  let box = { left: 300, top: 640, width: 700, height: 48 };
  card.getBoundingClientRect = () => box;
  region.append(card);
  pane.append(region);
  document.body.append(pane);

  const publisher = await import('./desktop-pet-publisher');
  publisher.resetDesktopPetConfigForTests();
  t.after(() => publisher.resetDesktopPetConfigForTests());
  await act(async () => root.render(React.createElement(publisher.DesktopPetPublisher)));
  const tick = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const settle = async () => {
    await tick();
    await act(async () => {
      while (frames.size) frames.run();
    });
  };
  await settle();
  assert.deepEqual(composers.at(-1), { x: 300, y: 640, width: 700, height: 48, island: null }, 'one-line bar');

  // Only an attribute flips (data-card): the card grows upward.
  box = { left: 300, top: 600, width: 700, height: 88 };
  card.setAttribute('data-card', '');
  await settle();
  assert.deepEqual(composers.at(-1), { x: 300, y: 600, width: 700, height: 88, island: null }, 'two-row card');

  // The layout settles over a few frames (a follow-up render): each is measured.
  box = { left: 300, top: 610, width: 700, height: 78 };
  card.setAttribute('data-example-flip', '');
  await tick();
  await act(async () => frames.run());
  assert.equal(composers.at(-1).y, 610, 'first frame');
  box = { left: 300, top: 620, width: 700, height: 68 };
  await act(async () => frames.run());
  assert.deepEqual(composers.at(-1), { x: 300, y: 620, width: 700, height: 68, island: null }, 'next frame');

  // Back to the bar; a box that holds still stops the measuring.
  box = { left: 300, top: 640, width: 700, height: 48 };
  card.removeAttribute('data-card');
  await settle();
  assert.equal(composers.at(-1).y, 640, 'one-line bar again');
  assert.equal(frames.size, 0, 'settled: no frame left pending');

  // A sibling in the dock replaced (a child list change) moves the card too.
  box = { left: 300, top: 612, width: 700, height: 48 };
  region.append(document.createElement('div'));
  await settle();
  assert.equal(composers.at(-1).y, 612, 'dock member added');
});

test('a member that leaves the composer dock is no longer watched', async (t) => {
  const frames = manualFrames();
  const watched = new Set();
  class RecordingResizeObserver {
    observe(target) {
      watched.add(target);
    }
    unobserve(target) {
      watched.delete(target);
    }
    disconnect() {
      watched.clear();
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
  window.mixdogDesktop = {
    getDesktopPetConfig: async () => ({ enabled: true, pinned: true, keepAbove: false, collapsed: false, scale: 100 }),
    subscribeDesktopPetConfig: () => () => {},
    publishDesktopPet: () => {},
    publishDesktopPetComposer: () => {},
    publishDesktopPetTheme: () => {},
    publishDesktopPetLayers: () => {},
  };
  const pane = document.createElement('div');
  pane.className = 'pane-cell is-focused';
  const region = document.createElement('div');
  region.className = 'composer-region';
  const card = document.createElement('form');
  card.className = 'composer';
  card.getBoundingClientRect = () => ({ left: 300, top: 640, width: 700, height: 48 });
  region.append(card);
  pane.append(region);
  document.body.append(pane);

  const publisher = await import('./desktop-pet-publisher');
  publisher.resetDesktopPetConfigForTests();
  t.after(() => publisher.resetDesktopPetConfigForTests());
  await act(async () => root.render(React.createElement(publisher.DesktopPetPublisher)));
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      while (frames.size) frames.run();
    });
  };
  await settle();

  const approval = document.createElement('div');
  region.append(approval);
  await settle();
  assert.ok(watched.has(approval), 'a new dock member is watched');
  approval.remove();
  await settle();
  assert.ok(!watched.has(approval), 'the removed member is released');
  assert.ok(watched.has(card), 'the card is still watched');
});

test('the overlay follows the presented session composer when the previous one stays connected, retained', async (t) => {
  const frames = manualFrames();
  const watched = new Set();
  class RecordingResizeObserver {
    observe(target) {
      watched.add(target);
    }
    unobserve(target) {
      watched.delete(target);
    }
    disconnect() {
      watched.clear();
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
  const pane = document.createElement('div');
  pane.className = 'pane-cell is-focused';
  const surfaces = ['a', 'b'].map((name, index) => {
    const host = document.createElement('div');
    host.className = 'persistent-pane-surface';
    const region = document.createElement('div');
    region.className = 'composer-region';
    const card = document.createElement('form');
    card.className = 'composer';
    const box =
      index === 0 ? { left: 300, top: 600, width: 700, height: 88 } : { left: 300, top: 640, width: 700, height: 48 };
    card.getBoundingClientRect = () => box;
    region.append(card);
    host.append(region);
    pane.append(host);
    return { name, host, card };
  });
  const [a, b] = surfaces;
  b.host.setAttribute('data-retained', '');
  b.host.setAttribute('inert', '');
  document.body.append(pane);

  const publisher = await import('./desktop-pet-publisher');
  publisher.resetDesktopPetConfigForTests();
  t.after(() => publisher.resetDesktopPetConfigForTests());
  await act(async () => root.render(React.createElement(publisher.DesktopPetPublisher)));
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      while (frames.size) frames.run();
    });
  };
  await settle();
  assert.equal(composers.at(-1).y, 600, 'the presented session A composer, not the retained one');

  // Switch A -> B in the same pane: A is retained but stays connected.
  a.host.setAttribute('data-retained', '');
  a.host.setAttribute('inert', '');
  b.host.removeAttribute('data-retained');
  b.host.removeAttribute('inert');
  await settle();
  assert.ok(a.card.isConnected, 'A stays connected');
  assert.deepEqual(composers.at(-1), { x: 300, y: 640, width: 700, height: 48, island: null }, 'follows B');
  assert.ok(watched.has(b.card) && !watched.has(a.card), 'B is watched, A released');
});
