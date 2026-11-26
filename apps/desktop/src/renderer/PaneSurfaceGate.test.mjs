import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

async function mount(t) {
  const { root, document } = installTestDom(t, { rootId: 'root', globals: {} });
  const { PaneSurfaceCover, SURFACE_HOLD_GRACE_MS } = await import('./PaneSurfaceGate.tsx');
  const render = (props) =>
    act(async () =>
      root.render(React.createElement(PaneSurfaceCover, { label: 'Loading', transitionKey: 'a', ...props }))
    );
  const wait = (ms) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  return { render, wait, document, grace: SURFACE_HOLD_GRACE_MS };
}

test('a latched-revealed cover returns while its transcript stays hidden', async (t) => {
  const view = await mount(t);
  // Already revealed for this key at mount: the stable latch alone would never cover again.
  await view.render({ ready: true });
  assert.equal(view.document.querySelector('.pane-surface-cover'), null);
  await view.render({ ready: true, hold: true });
  await view.wait(view.grace + 40);
  assert.ok(view.document.querySelector('.pane-surface-cover'), 'hidden transcript is never left without feedback');
  assert.ok(view.document.querySelector('.pane-surface-cover [role="status"]'));
  await view.render({ ready: true, hold: false });
  assert.equal(view.document.querySelector('.pane-surface-cover'), null);
});

test('a conversation cover leaves in the commit its settled rows become ready', async (t) => {
  const view = await mount(t);
  await view.render({ ready: false, revealOnReady: true });
  assert.ok(view.document.querySelector('.pane-surface-cover'), 'the cover paints while no rows exist');
  assert.equal(view.document.querySelector('.transcript-skeleton'), null, 'no skeleton, never a fake composer bar');
  assert.equal(view.document.querySelector('.transcript-skeleton-composer'), null);
  await view.render({ ready: true, revealOnReady: true });
  assert.equal(
    view.document.querySelector('.pane-surface-cover'),
    null,
    'no font or composed-frame settle holds the cover over the first messages'
  );
  await view.render({ ready: false, transitionKey: 'b' });
  await view.render({ ready: true, transitionKey: 'b' });
  assert.ok(view.document.querySelector('.pane-surface-cover'), 'a wide pane still settles behind its cover');
});

test('a hold reported through its signal covers without rendering the cover owner', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root', globals: {} });
  const { PaneSurfaceCover, SURFACE_HOLD_GRACE_MS, createSurfaceHoldSignal } = await import('./PaneSurfaceGate.tsx');
  const signal = createSurfaceHoldSignal();
  let ownerRenders = 0;
  function Owner() {
    ownerRenders += 1;
    return React.createElement(PaneSurfaceCover, {
      ready: true,
      label: 'Loading',
      transitionKey: 'a',
      holdSignal: signal,
    });
  }
  const wait = (ms) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  await act(async () => root.render(React.createElement(Owner)));
  const rendered = ownerRenders;
  await act(async () => signal.set(true));
  assert.equal(document.querySelector('.pane-surface-cover'), null, 'a hold inside the grace shows nothing');
  await wait(SURFACE_HOLD_GRACE_MS + 40);
  assert.ok(document.querySelector('.pane-surface-cover'), 'a hold past the grace covers');
  await act(async () => signal.set(false));
  assert.equal(document.querySelector('.pane-surface-cover'), null);
  assert.equal(ownerRenders, rendered, 'the owner never re-renders for the hold');
});

test('saved scroll offsets restore live elements and never keep a dropped one alive', async (t) => {
  const { document } = installTestDom(t, { rootId: 'root', globals: {} });
  const { PersistentScrollOffsets } = await import('./PaneSurfaceGate.tsx');
  const offsets = new PersistentScrollOffsets();
  const staying = document.createElement('div');
  offsets.set(staying, { top: 5, left: 0 });
  offsets.set(staying, { top: 7, left: 0 });
  assert.equal(offsets.size, 1);
  assert.deepEqual(offsets.entries(), [[staying, { top: 7, left: 0 }]]);
  if (typeof globalThis.gc === 'function') {
    offsets.set(document.createElement('div'), { top: 9, left: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    globalThis.gc();
    assert.deepEqual(
      offsets.entries().map(([element]) => element),
      [staying]
    );
    assert.equal(offsets.size, 1);
  }
});

test('a warm revisit that reveals inside the grace never flashes the cover', async (t) => {
  const view = await mount(t);
  await view.render({ ready: true });
  await view.render({ ready: true, hold: true });
  assert.equal(view.document.querySelector('.pane-surface-cover'), null, 'no cover in the hidden frame');
  await view.wait(Math.floor(view.grace / 3));
  assert.equal(view.document.querySelector('.pane-surface-cover'), null);
  await view.render({ ready: true, hold: false });
  await view.wait(view.grace + 40);
  assert.equal(view.document.querySelector('.pane-surface-cover'), null, 'the released hold never fires late');
});

test('cold surface commit waits for layout frame before checking document.fonts.ready even if fonts status was initially loaded', async (t) => {
  const { window, document } = installTestDom(t, { rootId: false, globals: {} });
  const frames = new Map();
  let nextFrameId = 1;
  window.requestAnimationFrame = (callback) => {
    const id = nextFrameId++;
    frames.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  let fontsStatus = 'loaded';
  let fontsReadyRead = 0;
  let resolveFonts;
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
      get status() {
        return fontsStatus;
      },
      get ready() {
        fontsReadyRead += 1;
        return new Promise((resolve) => {
          resolveFonts = resolve;
        });
      },
    },
  });
  const { scheduleStableSurfaceCommit } = await import('./PaneSurfaceGate.tsx');

  let committed = 0;
  const cancel = scheduleStableSurfaceCommit(() => {
    committed += 1;
  });
  assert.equal(frames.size, 1, 'waits for an initial layout frame first');
  assert.equal(fontsReadyRead, 0, 'does not read document.fonts.ready before layout runs');
  assert.equal(committed, 0);

  // Incoming cold surface requests a new font subset during that first layout frame.
  fontsStatus = 'loading';
  const [[firstId, firstCb]] = [...frames.entries()];
  frames.delete(firstId);
  firstCb(16);
  await Promise.resolve();
  assert.equal(fontsReadyRead, 1, 'checks document.fonts.ready after layout has run');
  assert.equal(committed, 0, 'does not commit before newly requested fonts settle');
  assert.equal(frames.size, 0);

  resolveFonts();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(frames.size, 1, 'waits for first composed frame after fonts settle');
  const [[secondId, secondCb]] = [...frames.entries()];
  frames.delete(secondId);
  secondCb(32);
  await Promise.resolve();
  assert.equal(committed, 0);
  assert.equal(frames.size, 1, 'waits for second composed frame before reveal');
  const [[thirdId, thirdCb]] = [...frames.entries()];
  frames.delete(thirdId);
  thirdCb(48);
  await Promise.resolve();
  assert.equal(committed, 1);
  cancel();

  // Cancellation aborts any pending commit cleanly.
  let cancelledCommit = 0;
  const abort = scheduleStableSurfaceCommit(() => {
    cancelledCommit += 1;
  });
  assert.equal(frames.size, 1);
  abort();
  assert.equal(frames.size, 0);
  assert.equal(cancelledCommit, 0);
});
