import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: {
    url: 'https://mixdog.test/',
  },
  expose: ['HTMLElement'],
  actEnvironment: false,
});
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

// The core's pushed sections, as the window's section store folds them.
const listeners = new Set();
const latest = new Map();
let revision = 0;
const publish = (section, key, value) => {
  const entry = { section, key, revision: ++revision, value };
  latest.set(`${section}\u0000${key}`, entry);
  for (const listener of [...listeners]) listener({ kind: 'sections', changes: [{ section, key, entry }] });
};
window.mixdogDesktop = {
  setTitleBarDimmed() {},
  rendererDiagnostic() {},
  // A one-shot read must play no part: it answers "not installed" for a config that has not arrived.
  readSettings: () => Promise.resolve({ browserInstalled: false }),
  sections: {
    core: async () => false,
    snapshot: async () => ({ status: 'ready', entries: [...latest.values()] }),
    subscribe: (next) => (listeners.add(next), () => void listeners.delete(next)),
  },
};

const { useBrowserFeatureInstalled } = await import('./browser-feature-install.ts');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the Browser toggle follows the pushed desktop section: unknown until it arrives, then every consumer, with no retry cap', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const seenA = [];
  const seenB = [];
  const ProbeA = () => (seenA.push(useBrowserFeatureInstalled()), null);
  const ProbeB = () => (seenB.push(useBrowserFeatureInstalled()), null);
  try {
    await act(async () => {
      root.render(React.createElement(React.Fragment, null, React.createElement(ProbeA), React.createElement(ProbeB)));
      await tick();
    });
    // Nothing arrived (the core is still starting): unknown, never "not installed".
    assert.equal(seenA[seenA.length - 1], null);
    // Other sections arriving, however many, say nothing about this one.
    for (let i = 0; i < 8; i += 1) {
      await act(async () => {
        publish('config', 'agent', {});
        await tick();
      });
    }
    assert.equal(seenA[seenA.length - 1], null);
    // The section arrives late, with no settings announcement: every mounted consumer follows.
    await act(async () => {
      publish('config', 'desktop', { browserControl: true, browserInstalled: true });
      await tick();
    });
    assert.equal(seenA[seenA.length - 1], true);
    assert.equal(seenB[seenB.length - 1], true);
    assert.equal(window.localStorage.getItem('mixdog.desktop.browser-feature-installed.v1'), 'true');
    // An uninstall reaches them too.
    await act(async () => {
      publish('config', 'desktop', { browserInstalled: false });
      await tick();
    });
    assert.equal(seenA[seenA.length - 1], false);
    assert.equal(seenB[seenB.length - 1], false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});