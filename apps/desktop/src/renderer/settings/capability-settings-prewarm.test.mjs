import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  jsdom: {
    url: 'https://mixdog.test/',
  },
  expose: ['navigator'],
});

window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { CapabilitySettings, preloadCapabilitySettings } = await import('./CapabilitySettings.tsx');
const { invalidateCapabilitySettings } = await import('./capability-data.ts');

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

// The daemon's tool-module config, answered by both the batched reads and the
// toggle; `hold` parks reads so one can still be in flight across a write.
function toolModuleApi(initial) {
  const modules = structuredClone(initial);
  const held = [];
  const api = {
    hold: false,
    modules,
    release() {
      for (const resume of held.splice(0)) resume();
    },
    async readCapabilities(requests) {
      const answer = requests.map((request) => ({
        ok: true,
        value: request.capability === 'getToolModuleSettings' ? structuredClone(modules) : null,
      }));
      if (api.hold) await new Promise((resume) => held.push(resume));
      return answer;
    },
    async invokeCapability({ capability, args }) {
      if (capability === 'setBuiltinToolEnabled') {
        const [id, enabled] = args;
        modules[id] = { ...modules[id], enabled };
        return { value: structuredClone(modules), snapshot: null };
      }
      return { value: null, snapshot: null };
    },
    async listProviderModels() {
      return [];
    },
    async getSnapshot() {
      return null;
    },
    async gitCliStatus() {
      return { installed: true };
    },
  };
  return api;
}

test('a write invalidates both the cached sweep and one still in flight', async () => {
  const api = toolModuleApi({ visualize: { enabled: true } });
  await preloadCapabilitySettings(api);

  // A sweep that read before the write is still running when the write lands.
  api.hold = true;
  const before = preloadCapabilitySettings(api, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await api.invokeCapability({ capability: 'setBuiltinToolEnabled', args: ['visualize', false] });
  invalidateCapabilitySettings(api, 'setBuiltinToolEnabled');
  api.hold = false;

  // A hidden load (force false) neither joins that sweep nor adopts the cache.
  const after = preloadCapabilitySettings(api);
  assert.notEqual(after, before);
  assert.equal((await after).data.toolModules.visualize.enabled, false);

  // The older sweep landing late never replaces the newer value.
  api.release();
  assert.equal((await before).data.toolModules.visualize.enabled, true);
  assert.equal((await preloadCapabilitySettings(api)).data.toolModules.visualize.enabled, false);

  // Reads are not writes: they keep the cache.
  invalidateCapabilitySettings(api, 'getToolModuleSettings');
  const sweeps = [];
  api.readCapabilities = async (requests) => {
    sweeps.push(requests.length);
    return requests.map(() => ({ ok: true, value: null }));
  };
  await preloadCapabilitySettings(api);
  assert.deepEqual(sweeps, [], 'a read leaves the cached sweep valid');
});

// Live bug: Extensions → Built-in features kept the switch and the row's
// data-enabled on the old value after a saved toggle until a renderer reload.
test('a resolved built-in toggle shows the saved value, shown or hidden', async () => {
  const ids = ['visualize', 'tidy', 'office', 'git', 'localProvider'];
  const api = toolModuleApi(Object.fromEntries(ids.map((id) => [id, { enabled: true, installed: true }])));
  await preloadCapabilitySettings(api);
  const host = document.createElement('section');
  document.body.append(host);
  const root = createRoot(host);
  const render = (active) =>
    act(async () => {
      root.render(React.createElement(CapabilitySettings, { api, category: 'builtins', active }));
    });
  const row = (id) => host.querySelector(`button[data-built-in-feature="${id}"]`);
  const toggleSwitch = (id) => host.ownerDocument.querySelector(`[data-feature-id="${id}"] input[type="checkbox"]`);
  try {
    for (const active of [false, true]) {
      await render(active);
      for (const id of ids) {
        const expected = !api.modules[id].enabled;
        assert.ok(row(id), `${id} row renders`);
        await act(async () => row(id).click());
        const control = toggleSwitch(id);
        assert.ok(control, `${id} dialog shows its switch`);
        // A sweep started before the write is still running when it resolves.
        api.hold = true;
        void preloadCapabilitySettings(api, true);
        await act(async () => control.click());
        api.hold = false;
        api.release();
        await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
        assert.equal(api.modules[id].enabled, expected, `${id} saved`);
        assert.equal(toggleSwitch(id)?.checked, expected, `${id} switch shows the saved value (active=${active})`);
        assert.equal(row(id).getAttribute('data-enabled'), String(expected), `${id} row shows the saved value`);
        await act(async () => host.ownerDocument.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
      }
    }
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
