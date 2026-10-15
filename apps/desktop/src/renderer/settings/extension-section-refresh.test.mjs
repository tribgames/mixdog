import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['navigator'],
});

window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { CapabilitySettings } = await import('./CapabilitySettings.tsx');
const { preloadCapabilitySettings, refreshCapabilitySections, getCachedCapabilitySettings, EXTENSION_SECTIONS } =
  await import('./capability-data.ts');

const EXTENSION = ['pluginsStatus', 'skillsStatus', 'getDisabledSkills', 'mcpStatus'];

function pluginStatus(skillCount) {
  return { plugins: [{ id: 'p1', name: 'p1', enabled: true, skillCount }] };
}

function settingsApi(state, hooks = {}) {
  const reads = [];
  const read = async (request) => {
    reads.push(request.capability);
    await hooks.beforeRead?.(request);
    if (request.capability === 'pluginsStatus') return { ok: true, value: pluginStatus(state.skillCount) };
    return { ok: true, value: null };
  };
  return {
    reads,
    readCapabilities: async (requests) => Promise.all(requests.map(read)),
    async invokeCapability(request) {
      state.invoked?.push(request.capability);
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

const fullSweepReads = (api) => api.reads.filter((capability) => !EXTENSION.includes(capability));
const cachedSkillCount = (api) => getCachedCapabilitySettings(api).data.plugins.plugins[0].skillCount;

async function mount(api, category) {
  const root = createRoot(document.querySelector('main'));
  await act(async () => {
    root.render(React.createElement(CapabilitySettings, { api, category, active: true }));
  });
  return root;
}

test('window focus re-reads only the extension sections', async () => {
  const state = { skillCount: 0 };
  const api = settingsApi(state);
  await preloadCapabilitySettings(api);
  const root = await mount(api, 'plugins');
  try {
    const sweepReads = fullSweepReads(api).length;
    api.reads.length = 0;
    state.skillCount = 3;
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'));
    });
    assert.deepEqual([...api.reads].sort(), [...EXTENSION].sort());
    assert.equal(fullSweepReads(api).length, 0, `no full sweep (initial ${sweepReads})`);
    assert.equal(cachedSkillCount(api), 3);
  } finally {
    await act(async () => root.unmount());
  }
});

test('visibilitychange to visible re-reads; a non-extension category does not', async () => {
  const state = { skillCount: 0 };
  const api = settingsApi(state);
  await preloadCapabilitySettings(api);
  const root = await mount(api, 'general');
  try {
    api.reads.length = 0;
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'));
    });
    assert.equal(api.reads.length, 0);
    await act(async () => root.unmount());
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    const other = await mount(api, 'skills');
    try {
      state.skillCount = 2;
      await act(async () => {
        document.dispatchEvent(new window.Event('visibilitychange'));
      });
      assert.equal(cachedSkillCount(api), 2);
    } finally {
      await act(async () => other.unmount());
    }
  } finally {
    /* first root already unmounted */
  }
});

test('opening a plugin detail re-reads the extension sections', async () => {
  const state = { skillCount: 1 };
  const api = settingsApi(state);
  await preloadCapabilitySettings(api);
  const root = await mount(api, 'plugins');
  try {
    api.reads.length = 0;
    state.skillCount = 4;
    const row = [...document.querySelectorAll('button, [role="button"]')].find((node) =>
      node.textContent.includes('p1')
    );
    assert.ok(row, 'plugin row rendered');
    await act(async () => {
      row.click();
    });
    assert.ok(api.reads.includes('pluginsStatus'));
    assert.equal(fullSweepReads(api).length, 0);
    assert.equal(cachedSkillCount(api), 4);
  } finally {
    await act(async () => root.unmount());
  }
});

test('a late full sweep does not overwrite newer section data', async () => {
  const state = { skillCount: 0 };
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let hold = true;
  const api = settingsApi(state, {
    beforeRead: async (request) => {
      if (hold && request.capability === 'pluginsStatus') await gate;
    },
  });
  const sweep = preloadCapabilitySettings(api, true);
  // The sweep's pluginsStatus read answered before the change is still parked.
  await Promise.resolve();
  hold = false;
  state.skillCount = 5;
  await refreshCapabilitySections(api, ['plugins']);
  release();
  const result = await sweep;
  assert.equal(result.data.plugins.plugins[0].skillCount, 5);
});

test('a mutation refreshes extension sections before the full sweep finishes', async () => {
  const state = { skillCount: 0, invoked: [] };
  let hold = false;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const api = settingsApi(state, {
    beforeRead: async (request) => {
      if (hold && request.capability === 'getProfile') await gate;
    },
  });
  await preloadCapabilitySettings(api);
  const root = await mount(api, 'plugins');
  try {
    const row = [...document.querySelectorAll('button')].find((node) => node.textContent.includes('p1'));
    await act(async () => {
      row.click();
    });
    hold = true;
    state.skillCount = 7;
    api.invokeCapability = async () => ({ value: { ok: true }, snapshot: null });
    const button =
      document.querySelector('.extensions-plugin-detail-dialog input[type=checkbox]') ||
      document.querySelector('input[type=checkbox]');
    assert.ok(button, 'plugin toggle rendered');
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // The full sweep is still parked on getProfile; the list already moved.
    assert.equal(cachedSkillCount(api), 7);
    release();
  } finally {
    release();
    await act(async () => root.unmount());
  }
});

test('an older section read finishing after a newer full sweep does not overwrite it', async () => {
  let current = 1;
  let releaseOld;
  const gate = new Promise((resolve) => {
    releaseOld = resolve;
  });
  let delayNext = false;
  const api = {
    async readCapabilities(requests) {
      const delay = delayNext;
      delayNext = false;
      const snapshot = current;
      if (delay) await gate;
      return requests.map((request) => ({
        ok: true,
        value: request.capability === 'pluginsStatus' ? pluginStatus(snapshot) : null,
      }));
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
  await preloadCapabilitySettings(api);
  delayNext = true;
  const oldRefresh = refreshCapabilitySections(api, EXTENSION_SECTIONS);
  current = 2;
  await preloadCapabilitySettings(api, true);
  assert.equal(cachedSkillCount(api), 2);
  releaseOld();
  await oldRefresh;
  assert.equal(cachedSkillCount(api), 2);
});
