import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

function settingsApi() {
  const snapshots = new Set();
  const updates = new Set();
  const api = {
    title: 'Before',
    readBatches: 0,
    updater: { status: 'idle' },
    async readCapabilities(requests) {
      api.readBatches++;
      return requests.map(({ capability }) => ({
        ok: true,
        value: capability === 'getProfile' ? { title: api.title } : null,
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
    async getUpdaterState() {
      return api.updater;
    },
    async checkForDesktopUpdate() {
      return api.updater;
    },
    subscribeState(listener) {
      snapshots.add(listener);
      return () => snapshots.delete(listener);
    },
    subscribeUpdaterState(listener) {
      updates.add(listener);
      return () => updates.delete(listener);
    },
    publish(index) {
      for (const listener of snapshots) listener({ sessionId: 'background', busy: index % 2 === 0 });
      api.updater = { status: 'ready', version: `9.0.${index}` };
      for (const listener of updates) listener(api.updater);
    },
    subscribers() {
      return [snapshots.size, updates.size];
    },
  };
  return api;
}

test('hidden settings retain subscriptions without rendering and show the latest update on reopening', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root' });
  const { CapabilitySettings, preloadCapabilitySettings } = await import('./CapabilitySettings');
  const api = settingsApi();
  await preloadCapabilitySettings(api);
  let commits = 0;
  const render = (active) =>
    act(async () =>
      root.render(
        React.createElement(
          React.Profiler,
          { id: 'settings', onRender: () => commits++ },
          React.createElement(CapabilitySettings, { api, active, category: 'system' })
        )
      )
    );
  await render(true);
  await render(false);
  const before = commits;
  for (let index = 0; index < 5; index++) await act(async () => api.publish(index));
  assert.equal(commits, before, 'background notifications must not redraw a hidden panel');
  assert.deepEqual(api.subscribers(), [1, 1], 'hidden panels keep receiving their data');
  await render(true);
  assert.match(document.body.textContent, /Update to v9\.0\.4/);
  await act(async () => api.publish(5));
  assert.match(document.body.textContent, /Update to v9\.0\.5/);
  await render(false);
  await act(async () => root.render(null));
  assert.deepEqual(api.subscribers(), [0, 0]);
});

test('an immediate reopen refreshes settings without a cache grace period and preserves unchanged drafts', async (t) => {
  t.mock.method(Date, 'now', () => 1_000_000);
  const { root, document } = installTestDom(t, { rootId: 'root' });
  const { CapabilitySettings, preloadCapabilitySettings } = await import('./CapabilitySettings');
  const api = settingsApi();
  await preloadCapabilitySettings(api);
  const render = (active) =>
    act(async () => root.render(React.createElement(CapabilitySettings, { api, active, category: 'general' })));
  await render(true);
  const input = document.querySelector('input[name="title"]');
  input.value = 'Unsubmitted draft';
  await render(false);
  await act(async () => api.publish(0));
  await render(true);
  assert.equal(document.querySelector('input[name="title"]'), input);
  assert.equal(input.value, 'Unsubmitted draft');
  input.value = 'Before';
  await render(false);
  const reads = api.readBatches;
  api.title = 'Changed while hidden';
  await render(true);
  assert.ok(api.readBatches > reads);
  assert.equal(document.querySelector('input[name="title"]').value, api.title);
});
