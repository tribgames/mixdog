// Where the route sheet opens: above the composer's pill (it sits at the
// bottom of the screen), below a dialog field like every other popup.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['Node', 'HTMLElement', 'Event', 'KeyboardEvent', 'navigator'],
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
window.HTMLElement.prototype.scrollIntoView = () => {};
window.mixdogDesktop = {
  routeAutoEffort: true,
  async invokeCapability() {
    return { value: { autoEffort: { installed: true, enabled: true, supported: true } } };
  },
};
after(restore);

const { createRoot } = await import('react-dom/client');
const { RouteEditor } = await import('./RouteEditor.tsx');
const { ModelRouteEditor } = await import('./ModelRouteEditor.tsx');

const opus = {
  provider: 'anthropic',
  model: 'opus',
  display: 'Opus',
  effortOptions: [],
  fastCapable: false,
  fastPreferred: false,
};
// Like a DOMRect, the edges are prototype getters (a spread copies none of them).
class Rect {
  #left;
  #top;
  constructor(left, top) {
    this.#left = left;
    this.#top = top;
  }
  get left() {
    return this.#left;
  }
  get top() {
    return this.#top;
  }
  get right() {
    return this.#left + 160;
  }
  get bottom() {
    return this.#top + 28;
  }
  get width() {
    return 160;
  }
  get height() {
    return 28;
  }
}
const rect = (left, top) => new Rect(left, top);

async function openAt(t, element, trigger) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () => root.render(element));
  const button = host.querySelector('.model-trigger');
  button.getBoundingClientRect = () => trigger;
  await act(async () => button.click());
  return document.querySelector('.route-sheet');
}

test('the composer route sheet still opens above its pill, left edges aligned', async (t) => {
  const noop = () => {};
  const sheet = await openAt(
    t,
    React.createElement(RouteEditor, {
      models: [opus],
      provider: 'anthropic',
      model: 'opus',
      triggerModel: 'Opus',
      effort: '',
      effortOptions: [],
      fast: false,
      fastVisible: false,
      fastAvailable: false,
      contextVisible: false,
      contextPercent: 100,
      contextDefaultPercent: 100,
      contextTokens: 0,
      catalogLoaded: true,
      catalogRefreshing: false,
      catalogError: '',
      providerSetupError: '',
      modelDisabled: false,
      tuningDisabled: false,
      onSelectModel: noop,
      onChangeEffort: noop,
      onChangeSpeed: noop,
      onChangeContext: noop,
    }),
    rect(100, 700)
  );
  // One Model row: 36px + 4px padding on each side.
  assert.equal(sheet.dataset.placement, 'above');
  assert.equal(sheet.style.top, `${700 - 6 - 44}px`);
  assert.equal(sheet.style.left, '100px');
});

test('a dialog route field opens its sheet below, even with room above', async (t) => {
  const sheet = await openAt(
    t,
    React.createElement(ModelRouteEditor, {
      models: [opus],
      value: { provider: 'anthropic', model: 'opus' },
      onChange() {},
    }),
    rect(100, 300)
  );
  assert.equal(sheet.dataset.placement, 'below');
  assert.equal(sheet.style.top, `${300 + 28 + 6}px`);
  assert.equal(sheet.style.left, '100px');
});
