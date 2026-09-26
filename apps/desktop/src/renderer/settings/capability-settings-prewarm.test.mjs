import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', {
  url: 'https://mixdog.test/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { CapabilitySettings, preloadCapabilitySettings } = await import('./CapabilitySettings.tsx');

function settingsApi() {
  const sweeps = [];
  return {
    sweeps,
    async readCapabilities(requests) {
      sweeps.push(requests.map((request) => request.capability));
      return requests.map(() => ({ ok: true, value: null }));
    },
    async invokeCapability() {
      return { value: null, snapshot: null };
    },
    async listProviderModels() {
      return [];
    },
    async getSnapshot() {
      return null;
    },
  };
}

// Boot: the idle preload sweeps once, then the kept-mounted settings dialog
// is prewarmed hidden a few seconds later. It must adopt that sweep instead
// of re-reading every section (and the model catalog) a second time.
test('a hidden prewarmed settings panel re-reads only once it is shown', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const api = settingsApi();
  await preloadCapabilitySettings(api);
  const bootSweeps = api.sweeps.length;
  assert.ok(bootSweeps > 0);
  t.mock.timers.tick(4_000);

  const root = createRoot(document.querySelector('main'));
  const render = async (active) => {
    await act(async () => {
      root.render(React.createElement(CapabilitySettings, { api, category: 'general', active }));
    });
  };
  try {
    await render(false);
    assert.equal(api.sweeps.length, bootSweeps, 'a hidden panel adopts the cached sweep');

    await render(true);
    assert.equal(api.sweeps.length, bootSweeps * 2, 'showing a stale panel re-reads it once');

    await render(false);
    assert.equal(api.sweeps.length, bootSweeps * 2, 'hiding it again reads nothing');
  } finally {
    await act(async () => root.unmount());
  }
});
