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
window.mixdogDesktop = {
  setTitleBarDimmed() {},
  rendererDiagnostic() {},
  readSettings: async () => settings,
};

const { UtilitiesPane } = await import('./UtilitiesView.tsx');

const rowLabels = () =>
  [...document.querySelectorAll('.utilities-row b')].map((row) => row.textContent);

test('the Browser utility follows the Browser Use install marker', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(React.createElement(UtilitiesPane, {
        onOpenBrowser() {},
        onOpenStudio() {},
        onOpenTerminal() {},
        onOpenExplorer() {},
      }));
    });
    // Browser Use not installed: the pane offers no agent-driven browser entry.
    assert.deepEqual(rowLabels(), ['Studio', 'Terminal', 'Explorer']);

    // The settings panel announces the install; the entry appears live.
    settings = { browserInstalled: true };
    await act(async () => {
      window.dispatchEvent(new dom.window.Event('mixdog:built-in-features-changed'));
    });
    assert.deepEqual(rowLabels(), ['Browser', 'Studio', 'Terminal', 'Explorer']);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});