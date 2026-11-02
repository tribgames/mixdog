import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'CustomEvent', 'navigator'],
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.HTMLElement.prototype.attachEvent = () => {};
window.HTMLElement.prototype.detachEvent = () => {};
window.mixdogDesktop = { setTitleBarDimmed() {}, rendererDiagnostic() {} };
const { CapabilitySettings } = await import('./CapabilitySettings.tsx');
const { preloadCapabilitySettings } = await import('./capability-data.ts');

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

// Goes through the real settings `run` + error toast, not a mocked run.
async function installMemory(install) {
  const toasts = [];
  const onToast = (event) => toasts.push(event.detail);
  window.addEventListener('mixdog:desktop-toast', onToast);
  const api = {
    readCapabilities: async (requests) =>
      requests.map((request) => ({
        ok: true,
        value: request.capability === 'getToolModuleSettings' ? { memory: { installed: false, enabled: false } } : null,
      })),
    invokeCapability: install,
    listProviderModels: async () => [],
    getSnapshot: async () => null,
    readSettings: async () => ({}),
  };
  await preloadCapabilitySettings(api);
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => {
      root.render(React.createElement(CapabilitySettings, { api, category: 'builtins', active: true }));
    });
    await act(async () => {
      document.querySelector('[data-built-in-feature="memory"]').click();
    });
    const button = document.querySelector('[data-feature-id="memory"] button.extensions-action');
    assert.ok(button, 'install button');
    await act(async () => {
      button.click();
      await settle();
    });
  } finally {
    window.removeEventListener('mixdog:desktop-toast', onToast);
    await act(async () => root.unmount());
  }
  return toasts;
}

test('a finished built-in install shows one success toast', async () => {
  const toasts = await installMemory(async () => ({
    value: { memory: { installed: true, enabled: true } },
    snapshot: null,
  }));
  assert.deepEqual(
    toasts.map((toast) => [toast.tone, toast.text]),
    [['success', 'Memory installed.']]
  );
});

test('a failed built-in install shows exactly one error toast', async () => {
  const toasts = await installMemory(async () => {
    throw new Error('network down');
  });
  assert.deepEqual(
    toasts.map((toast) => toast.tone),
    ['error']
  );
});

test('a rejected desktop update install shows exactly one error toast', async () => {
  const toasts = [];
  const onToast = (event) => toasts.push(event.detail);
  window.addEventListener('mixdog:desktop-toast', onToast);
  const api = {
    readCapabilities: async (requests) => requests.map(() => ({ ok: true, value: null })),
    invokeCapability: async () => ({ value: null, snapshot: null }),
    listProviderModels: async () => [],
    getSnapshot: async () => null,
    getUpdaterState: async () => ({ status: 'ready', version: '2.0.0' }),
    showDesktopUpdate: async () => {
      throw new Error('install refused');
    },
  };
  await preloadCapabilitySettings(api);
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => {
      root.render(React.createElement(CapabilitySettings, { api, category: 'system', active: true }));
      await settle();
    });
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent === 'Update to v2.0.0');
    assert.ok(button, 'install button');
    await act(async () => {
      button.click();
      await settle();
    });
  } finally {
    window.removeEventListener('mixdog:desktop-toast', onToast);
    await act(async () => root.unmount());
  }
  assert.deepEqual(
    toasts.map((toast) => toast.tone),
    ['error']
  );
});
