import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: {
    url: 'https://mixdog.test/',
    pretendToBeVisual: true,
  },
  expose: ['HTMLElement', 'Event'],
  actEnvironment: false,
});
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.React = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Windows' } });
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.mixdogDesktop = { setTitleBarDimmed() {}, rendererDiagnostic() {} };

const { createRoot } = await import('react-dom/client');
const { BuiltInFeaturesPanel } = await import('./built-in-features-panel.tsx');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function status(overrides = {}) {
  return {
    available: true,
    installed: false,
    enabled: false,
    runtime: { installed: false },
    hardware: { gpu: { name: 'RTX 3090' } },
    models: [{ id: 'test-model', name: 'Test model', compatible: true, installed: false }],
    ...overrides,
  };
}

async function mount(api, initial, run) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const render = async (localProvider) =>
    act(async () =>
      root.render(
        React.createElement(BuiltInFeaturesPanel, {
          api,
          data: { toolModules: { localProvider } },
          snapshot: {},
          pending: '',
          run,
        })
      )
    );
  await render(initial);
  await act(async () => document.querySelector('[data-built-in-feature="localProvider"]').click());
  return {
    render,
    async dispose() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('runtime progress from a chat installation stays live without a UI install command', async () => {
  const read = deferred();
  let current = status();
  let firstRead = true;
  const api = {
    readCapabilities: async () => {
      if (firstRead) {
        firstRead = false;
        return read.promise;
      }
      return [{ ok: true, value: { localProvider: current } }];
    },
  };
  const calls = [];
  const mounted = await mount(api, current, async (capability, args) => {
    calls.push([capability, args]);
    assert.fail('installation belongs to chat');
  });
  try {
    assert.match(document.querySelector('[data-feature-id="localProvider"]').textContent, /Install through chat/);
    assert.deepEqual(calls, []);
    current = status({ installations: [{ phase: 'runtime', state: 'running', percent: 42 }] });
    await act(async () => read.resolve([{ ok: true, value: { localProvider: current } }]));
    const progress = document.querySelector('[data-feature-id="localProvider"] [role="progressbar"]');
    assert.equal(progress?.getAttribute('aria-valuenow'), '42');
    assert.equal(document.querySelector('[data-feature-id="localProvider"] input'), null);
    current = status({ installed: true, enabled: true, runtime: { installed: true } });
    await mounted.render(current);
    assert.ok(document.querySelector('[data-feature-id="localProvider"] input'));
    assert.equal(document.querySelector('[data-feature-id="localProvider"] [role="progressbar"]'), null);
  } finally {
    await mounted.dispose();
  }
});

const contextPicker = (name) => document.querySelector(`[role="combobox"][aria-label="${name} · Context size"]`);
const pickOption = async (trigger, label) => {
  await act(async () => trigger.click());
  const options = [...document.querySelectorAll('[role="option"]')];
  const choice = options.find((option) => option.textContent === label);
  await act(async () => choice.click());
  return options.map((option) => option.textContent);
};
const actionButton = (label) =>
  document.querySelector(`[data-feature-id="localProvider"] button[aria-label="${label}"]`);

test('context picker offers supported sizes from the agent minimum and applies or resets at once', async () => {
  const current = status({
    installed: true,
    enabled: true,
    runtime: { installed: true },
    running: true,
    activeModel: 'installed',
    models: [
      {
        id: 'installed',
        name: 'Managed model',
        installed: true,
        contextWindow: 16384,
        configuredContextWindow: 16384,
        defaultContextWindow: 32768,
        minContextWindow: 16384,
        maxContextWindow: 65536,
      },
    ],
  });
  const calls = [];
  const mounted = await mount(
    { readCapabilities: async () => [{ ok: true, value: { localProvider: current } }] },
    current,
    async (capability, args) => {
      calls.push([capability, args]);
      return {};
    }
  );
  try {
    assert.match(contextPicker('Managed model').textContent, /16K/);
    const offered = await pickOption(contextPicker('Managed model'), '64K');
    assert.deepEqual(offered, ['Default (32K)', '16K', '32K · recommended', '64K']);
    assert.deepEqual(calls[0], ['setLocalProviderContext', ['installed', 65536]]);
    await pickOption(contextPicker('Managed model'), 'Default (32K)');
    assert.deepEqual(calls[1], ['setLocalProviderContext', ['installed', null]]);
  } finally {
    await mounted.dispose();
  }
});

test('changing idle release keeps context controls stable while the request is pending', async () => {
  const request = deferred();
  const current = status({
    installed: true,
    runtime: { installed: true },
    idleTtlSeconds: 3600,
    models: [
      {
        id: 'installed',
        name: 'Managed model',
        installed: true,
        contextWindow: 16384,
        configuredContextWindow: 16384,
        maxContextWindow: 32768,
      },
    ],
  });
  const calls = [];
  const mounted = await mount(
    {
      readCapabilities: async () => [{ ok: true, value: { localProvider: current } }],
    },
    current,
    async (capability, args) => {
      calls.push([capability, args]);
      return request.promise;
    }
  );
  try {
    const row = document.querySelector('[data-extension-item="Managed model"]');
    const picker = contextPicker('Managed model');
    const remove = actionButton('Delete');
    const originalText = row.textContent;
    const idle = document.querySelector('[role="combobox"][aria-label="Auto-unload when idle"]');
    await pickOption(idle, 'After 30 minutes');
    assert.deepEqual(calls, [['setLocalProviderIdleTtl', [1800]]]);
    assert.equal(picker.disabled, true);
    assert.equal(remove.disabled, true);
    assert.equal(row.textContent, originalText);
    await act(async () => request.resolve({ localProvider: { ...current, idleTtlSeconds: 1800 } }));
    assert.equal(picker.disabled, false);
    assert.equal(remove.disabled, false);
    assert.equal(row.textContent, originalText);
  } finally {
    await act(async () => request.resolve({}));
    await mounted.dispose();
  }
});

test('reopened settings recover model progress from runtime state without issuing another install', async () => {
  const current = status({
    installed: true,
    enabled: true,
    runtime: { installed: true },
    installations: [{ phase: 'model', modelId: 'test-model', state: 'running', stage: 'verifying', percent: 99 }],
  });
  const mounted = await mount(
    {
      readCapabilities: async () => [{ ok: true, value: { localProvider: current } }],
    },
    status(),
    () => assert.fail('must not restart the installation')
  );
  try {
    const progress = document.querySelector('[data-feature-id="localProvider"] [role="progressbar"]');
    assert.equal(progress?.getAttribute('aria-valuenow'), '99');
    assert.match(progress?.getAttribute('aria-valuetext'), /Test model/);
  } finally {
    await mounted.dispose();
  }
});

test('late status responses do not resurrect an unmounted settings panel', async () => {
  const read = deferred();
  const mounted = await mount({ readCapabilities: async () => read.promise }, status(), async () => ({}));
  await mounted.dispose();
  await act(async () =>
    read.resolve([
      {
        ok: true,
        value: {
          localProvider: status({
            installations: [{ phase: 'runtime', state: 'running', percent: 60 }],
          }),
        },
      },
    ])
  );
  assert.equal(document.querySelector('[data-feature-id="localProvider"]'), null);
});

test('detail lists installed models and running state, not the uninstalled catalog', async () => {
  const current = status({
    installed: true,
    enabled: true,
    runtime: { installed: true },
    running: true,
    activeModel: 'installed',
    models: [
      { id: 'installed', name: 'Installed Qwen', installed: true, sizeBytes: 19e9, contextWindow: 32768 },
      { id: 'catalog-only', name: 'Catalog-only model', installed: false, compatible: true },
    ],
  });
  const mounted = await mount(
    {
      readCapabilities: async () => [{ ok: true, value: { localProvider: current } }],
    },
    current,
    () => assert.fail('must not install from detail')
  );
  try {
    const text = document.querySelector('[data-feature-id="localProvider"]').textContent;
    assert.match(text, /Installed Qwen/);
    assert.match(text, /19.0 GB/);
    assert.match(text, /32K/);
    assert.match(text, /Running/);
    assert.doesNotMatch(text, /Catalog-only model/);
  } finally {
    await mounted.dispose();
  }
});

test('detail can stop the shared download, resume retained files and change idle release without reinstalling', async () => {
  let current = status({
    installed: true,
    runtime: { installed: true },
    idleTtlSeconds: 3600,
    installations: [{ jobId: 'download-job', phase: 'model', modelId: 'test-model', state: 'running', percent: 35 }],
  });
  const calls = [];
  const api = { readCapabilities: async () => [{ ok: true, value: { localProvider: current } }] };
  const mounted = await mount(api, current, async (capability, args) => {
    calls.push([capability, args]);
    return { localProvider: current };
  });
  try {
    // An installing model sits in the same table as installed ones, marked by its status.
    const row = () => document.querySelector('[data-extension-item="Test model"]');
    assert.match(row().textContent, /Installing 35%/);
    await act(async () => actionButton('Stop download').click());
    assert.deepEqual(calls[0], ['cancelLocalProviderInstallation', ['download-job']]);
    current = { ...current, installations: [{ phase: 'model', modelId: 'test-model', state: 'paused', percent: 35 }] };
    await mounted.render(current);
    assert.match(row().textContent, /Paused/);
    await act(async () => actionButton('Resume installation').click());
    assert.deepEqual(calls[1], ['startLocalProviderInstallation', ['model', 'test-model']]);
    await act(async () => actionButton('Discard').click());
    assert.equal(calls.length, 2);
    await act(async () => document.querySelector('[role="alertdialog"] button.danger').click());
    assert.deepEqual(calls.splice(2), [['discardLocalProviderInstallation', ['model', 'test-model']]]);
    current = {
      ...current,
      installations: [
        { phase: 'model', modelId: 'test-model', state: 'failed', error: '[local-provider] network connection lost' },
      ],
    };
    await mounted.render(current);
    // The failure reads as its status; the raw message waits in the pill's tooltip.
    assert.match(row().textContent, /Installation failed/);
    assert.doesNotMatch(row().textContent, /network connection lost/);
    assert.equal(row().querySelector('.local-provider-status').dataset.tooltip, 'network connection lost');
    assert.ok(actionButton('Retry'));
    const selector = document.querySelector('[role="combobox"][aria-label="Auto-unload when idle"]');
    assert.match(selector.textContent, /After 1 hour/);
    await act(async () => selector.click());
    await act(async () =>
      [...document.querySelectorAll('[role="option"]')].find((option) => option.textContent === 'Never').click()
    );
    assert.deepEqual(calls[2], ['setLocalProviderIdleTtl', [0]]);
    await act(async () => selector.click());
    await act(async () =>
      [...document.querySelectorAll('[role="option"]')]
        .find((option) => option.textContent === 'After 30 minutes')
        .click()
    );
    assert.deepEqual(calls[3], ['setLocalProviderIdleTtl', [1800]]);
  } finally {
    await mounted.dispose();
  }
});

test('installed model lists its facts and deletion waits for an exact-path confirmation', async () => {
  const current = status({
    installed: true,
    runtime: { installed: true },
    running: false,
    models: [
      {
        id: 'installed',
        name: 'Managed model',
        installed: true,
        sizeBytes: 1e9,
        supportsFunctionCalling: true,
        loadTimeMs: 1200,
        inference: { firstResponseMs: 250, tokensPerSecond: 24.5 },
      },
    ],
  });
  const calls = [];
  const mounted = await mount(
    {
      readCapabilities: async () => [{ ok: true, value: { localProvider: current } }],
    },
    current,
    async (capability, args) => {
      calls.push([capability, args]);
      if (capability === 'getLocalProviderModelDetails')
        return { confirmationToken: 'confirmed-file', files: [{ path: 'C:\\Managed\\installed.gguf', size: 1e9 }] };
      return { localProvider: current };
    }
  );
  try {
    const detail = () => document.querySelector('[data-feature-id="localProvider"]');
    // Repair and verification are chat-driven (local-provider skill): the
    // row carries its facts and one Delete control, no maintenance clutter.
    assert.match(detail().textContent, /Managed model/);
    assert.match(detail().textContent, /1.0 GB/);
    assert.equal(actionButton('Verify integrity'), null);
    await act(async () => actionButton('Delete').click());
    assert.equal(calls.filter(([name]) => name === 'deleteLocalProviderModel').length, 0);
    const confirmation = document.querySelector('[role="alertdialog"]');
    assert.match(confirmation.textContent, /C:\\Managed\\installed.gguf/);
    assert.match(confirmation.textContent, /Permanently deletes/);
    await act(async () => confirmation.querySelector('button.danger').click());
    assert.deepEqual(calls.at(-1), ['deleteLocalProviderModel', ['confirmed-file']]);
  } finally {
    await mounted.dispose();
  }
});

test('a loaded model can be deleted while idle but not while it answers a request', async () => {
  const model = { id: 'installed', name: 'Managed model', installed: true, sizeBytes: 1e9 };
  const loaded = (requests) =>
    status({
      installed: true,
      runtime: { installed: true },
      running: true,
      activeModel: 'installed',
      activeRequests: requests,
      models: [model],
    });
  let current = loaded(0);
  const mounted = await mount(
    { readCapabilities: async () => [{ ok: true, value: { localProvider: current } }] },
    current,
    async () => ({ confirmationToken: 'token', files: [{ path: 'C:\\Managed\\installed.gguf', size: 1e9 }] })
  );
  try {
    const remove = () => actionButton('Delete');
    assert.equal(remove().disabled, false);
    await act(async () => remove().click());
    assert.match(document.querySelector('[role="alertdialog"]').textContent, /unloaded first/);
    current = loaded(1);
    await mounted.render(current);
    assert.equal(remove().disabled, true);
  } finally {
    await mounted.dispose();
  }
});

test('a damaged existing model is flagged for chat repair without showing uninstalled search candidates', async () => {
  const current = status({
    installed: true,
    runtime: { installed: true },
    models: [
      { id: 'damaged', name: 'Damaged model', installed: false, present: true },
      { id: 'candidate', name: 'Uninstalled candidate', installed: false, present: false },
    ],
  });
  const mounted = await mount(
    {
      readCapabilities: async () => [{ ok: true, value: { localProvider: current } }],
    },
    current,
    async () => ({})
  );
  try {
    const detail = document.querySelector('[data-feature-id="localProvider"]');
    assert.match(detail.textContent, /Damaged model/);
    assert.match(detail.textContent, /Needs repair/);
    assert.doesNotMatch(detail.textContent, /Uninstalled candidate/);
    assert.equal(
      [...detail.querySelectorAll('button')].find((button) => button.textContent === 'Repair'),
      undefined
    );
  } finally {
    await mounted.dispose();
  }
});

test('background hardware checks stay silent while real hardware failures remain visible', async () => {
  let current = status({ hardware: { checking: true, gpu: { name: 'RTX 3090' } } });
  const mounted = await mount(
    {
      readCapabilities: async () => [{ ok: true, value: { localProvider: current } }],
    },
    current,
    async () => ({})
  );
  try {
    const detail = () => document.querySelector('[data-feature-id="localProvider"]');
    assert.doesNotMatch(detail().textContent, /Checking hardware/);
    current = status({ hardware: { checking: false, error: 'GPU driver unavailable' } });
    await mounted.render(current);
    assert.match(detail().textContent, /GPU driver unavailable/);
  } finally {
    await mounted.dispose();
  }
});
