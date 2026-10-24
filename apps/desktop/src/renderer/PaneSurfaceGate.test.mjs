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
  await view.render({ ready: false, skeleton: true, revealOnReady: true });
  assert.ok(view.document.querySelector('.transcript-skeleton'), 'the skeleton paints while no rows exist');
  await view.render({ ready: true, skeleton: true, revealOnReady: true });
  assert.equal(
    view.document.querySelector('.pane-surface-cover'),
    null,
    'no font or composed-frame settle holds the skeleton over the first messages'
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
