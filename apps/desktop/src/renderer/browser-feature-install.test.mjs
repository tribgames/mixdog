import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://mixdog.test/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.React = React;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
});

let settings = { browserInstalled: false };
let pendingSettingsRead = null;
window.mixdogDesktop = {
  setTitleBarDimmed() {},
  rendererDiagnostic() {},
  readSettings: () => pendingSettingsRead ?? Promise.resolve(settings),
};

const { useBrowserFeatureInstalled } = await import('./browser-feature-install.ts');

test('the Browser launcher follows the Browser Use install marker', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const seen = [];
  const Probe = () => {
    seen.push(useBrowserFeatureInstalled());
    return null;
  };
  try {
    let resolveSettings;
    pendingSettingsRead = new Promise((resolve) => { resolveSettings = resolve; });
    await act(async () => {
      root.render(React.createElement(Probe));
    });
    // Unknown marker: the caller hides the launcher rather than flash an icon
    // that vanishes a frame later.
    assert.equal(seen[0], null);

    await act(async () => {
      resolveSettings(settings);
      await pendingSettingsRead;
    });
    pendingSettingsRead = null;
    assert.equal(seen[seen.length - 1], false);

    // The settings panel announces the install; the launcher appears live.
    settings = { browserInstalled: true };
    await act(async () => {
      window.dispatchEvent(new dom.window.Event('mixdog:built-in-features-changed'));
    });
    assert.equal(seen[seen.length - 1], true);
  } finally {
    pendingSettingsRead = null;
    await act(async () => root.unmount());
    host.remove();
  }
});