// The custom provider dialog over the real Settings capability runner: a
// discovery the user stopped waiting for must not hold the Save that follows.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'MouseEvent', 'Node'],
});
test.after(restore);
window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { createRoot } = await import('react-dom/client');
const { CapabilitySettings } = await import('./CapabilitySettings.tsx');
const { preloadCapabilitySettings } = await import('./capability-data.ts');

const button = (label) =>
  [...document.querySelectorAll('button')].find(
    (el) => (el.getAttribute('aria-label') || el.textContent.trim()) === label
  );
const click = (el) => act(async () => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
async function type(el, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}
const field = (label) =>
  document.getElementById([...document.querySelectorAll('label')].find((l) => l.textContent === label).htmlFor);
const submit = () =>
  act(async () =>
    document
      .querySelector('form.settings-custom-provider-form')
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  );

test('Save with a manual model goes out while a stopped discovery is still running', async () => {
  const invoked = [];
  let releaseDiscovery;
  const discovery = new Promise((resolve) => {
    releaseDiscovery = () => resolve({ value: { models: [{ id: 'late' }] }, snapshot: null });
  });
  const api = {
    readCapabilities: async (requests) =>
      requests.map((request) => ({
        ok: true,
        value: request.capability === 'getProviderSetup' ? { api: [], oauth: [] } : null,
      })),
    async invokeCapability(request) {
      invoked.push(request.capability);
      if (request.capability === 'discoverCustomProviderModels') return discovery;
      if (request.capability === 'saveCustomProvider') {
        return { value: { ...request.args[0], id: 'custom:nano' }, snapshot: null };
      }
      return { value: null, snapshot: null };
    },
    listProviderModels: async () => [],
    getSnapshot: async () => null,
  };
  await preloadCapabilitySettings(api);
  const root = createRoot(document.querySelector('main'));
  await act(async () =>
    root.render(React.createElement(CapabilitySettings, { api, category: 'providers', active: true }))
  );
  try {
    await click(button('Add custom provider'));
    await type(field('Display name'), 'NanoGPT');
    await type(field('Base URL'), 'https://nano-gpt.com/api/v1');
    await type(field('API key'), 'sk-test');
    await submit();
    assert.deepEqual(invoked, ['discoverCustomProviderModels']);
    await click(button('Stop waiting'));
    await type(document.querySelector('details input'), 'qwen/qwen3-coder');
    await click(button('Add model'));
    await submit();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    assert.deepEqual(
      invoked,
      ['discoverCustomProviderModels', 'saveCustomProvider'],
      'Save is sent without waiting for the abandoned discovery'
    );
    assert.equal(document.querySelector('form.settings-custom-provider-form'), null, 'the saved dialog closes');
  } finally {
    releaseDiscovery();
    await act(async () => root.unmount());
  }
});
