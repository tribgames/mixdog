import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mixdog.test/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Event = dom.window.Event;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.React = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Windows' } });
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.mixdogDesktop = { setTitleBarDimmed() {}, rendererDiagnostic() {} };

const { BuiltInFeaturesPanel } = await import('./built-in-features-panel.tsx');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function status(overrides = {}) {
  return {
    available: true, installed: false, enabled: false,
    runtime: { installed: false }, hardware: { gpu: { name: 'RTX 3090' } },
    models: [{ id: 'test-model', name: 'Test model', compatible: true, installed: false }],
    ...overrides,
  };
}

async function mount(api, initial, run) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const render = async (localProvider) => act(async () => root.render(React.createElement(BuiltInFeaturesPanel, {
    api, data: { toolModules: { localProvider } }, snapshot: {}, pending: '', run,
  })));
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
      if (firstRead) { firstRead = false; return read.promise; }
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

test('reopened settings recover model progress from runtime state without issuing another install', async () => {
  const current = status({
    installed: true, enabled: true, runtime: { installed: true },
    installations: [{ phase: 'model', modelId: 'test-model', state: 'running', stage: 'verifying', percent: 99 }],
  });
  const mounted = await mount({
    readCapabilities: async () => [{ ok: true, value: { localProvider: current } }],
  }, status(), () => assert.fail('must not restart the installation'));
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
  await act(async () => read.resolve([{ ok: true, value: { localProvider: status({
    installations: [{ phase: 'runtime', state: 'running', percent: 60 }],
  }) } }]));
  assert.equal(document.querySelector('[data-feature-id="localProvider"]'), null);
});

test('detail lists installed models and running state, not the uninstalled catalog', async () => {
  const current = status({
    installed: true, enabled: true, runtime: { installed: true },
    running: true, activeModel: 'installed',
    models: [
      { id: 'installed', name: 'Installed Qwen', installed: true, sizeBytes: 19e9, contextWindow: 32768 },
      { id: 'catalog-only', name: 'Catalog-only model', installed: false, compatible: true },
    ],
  });
  const mounted = await mount({
    readCapabilities: async () => [{ ok: true, value: { localProvider: current } }],
  }, current, () => assert.fail('must not install from detail'));
  try {
    const text = document.querySelector('[data-feature-id="localProvider"]').textContent;
    assert.match(text, /Installed Qwen/);
    assert.match(text, /19.0 GB/);
    assert.match(text, /32K context/);
    assert.match(text, /Running/);
    assert.doesNotMatch(text, /Catalog-only model/);
    assert.match(text, /ask in chat/);
  } finally {
    await mounted.dispose();
  }
});

test('detail can stop the shared download, resume retained files and change idle release without reinstalling', async () => {
  let current = status({
    installed: true, runtime: { installed: true }, idleTtlSeconds: 3600,
    installations: [{ jobId: 'download-job', phase: 'model', modelId: 'test-model', state: 'running', percent: 35 }],
  });
  const calls = [];
  const api = { readCapabilities: async () => [{ ok: true, value: { localProvider: current } }] };
  const mounted = await mount(api, current, async (capability, args) => {
    calls.push([capability, args]);
    return { localProvider: current };
  });
  try {
    const button = (label) => [...document.querySelectorAll('[data-feature-id="localProvider"] button')]
      .find((entry) => entry.textContent === label);
    await act(async () => button('Stop download').click());
    assert.deepEqual(calls[0], ['cancelLocalProviderInstallation', ['download-job']]);
    current = { ...current, installations: [{ phase: 'model', modelId: 'test-model', state: 'paused', percent: 35 }] };
    await mounted.render(current);
    await act(async () => button('Resume installation').click());
    assert.deepEqual(calls[1], ['startLocalProviderInstallation', ['model', 'test-model']]);
    const selector = document.querySelector('[data-feature-id="localProvider"] [role="combobox"]');
    assert.match(selector.textContent, /After 1 hour/);
    await act(async () => selector.click());
    await act(async () => [...document.querySelectorAll('[role="option"]')]
      .find((option) => option.textContent === 'Never').click());
    assert.deepEqual(calls[2], ['setLocalProviderIdleTtl', [0]]);
  } finally {
    await mounted.dispose();
  }
});

test('installed model exposes measured diagnostics and deletion waits for an exact-path confirmation', async () => {
  const current = status({
    installed: true, runtime: { installed: true }, running: false,
    models: [{ id: 'installed', name: 'Managed model', installed: true, sizeBytes: 1e9,
      supportsFunctionCalling: true, loadTimeMs: 1200,
      inference: { firstResponseMs: 250, tokensPerSecond: 24.5 } }],
  });
  const calls = [];
  const mounted = await mount({
    readCapabilities: async () => [{ ok: true, value: { localProvider: current } }],
  }, current, async (capability, args) => {
    calls.push([capability, args]);
    if (capability === 'getLocalProviderModelDetails') return { confirmationToken: 'confirmed-file',
      files: [{ path: 'C:\\Managed\\installed.gguf', size: 1e9 }] };
    return { localProvider: current };
  });
  try {
    const detail = () => document.querySelector('[data-feature-id="localProvider"]');
    assert.match(detail().textContent, /1.20s/);
    assert.match(detail().textContent, /0.25s/);
    assert.match(detail().textContent, /24.5 tok\/s/);
    const button = (name) => [...detail().querySelectorAll('button')].find((entry) => entry.textContent === name);
    await act(async () => button('Verify integrity').click());
    assert.deepEqual(calls[0], ['startLocalProviderModelMaintenance', ['installed', 'verify']]);
    await act(async () => button('Delete').click());
    assert.equal(calls.filter(([name]) => name === 'deleteLocalProviderModel').length, 0);
    const confirmation = document.querySelector('[role="alertdialog"]');
    assert.match(confirmation.textContent, /C:\\Managed\\installed.gguf/);
    assert.match(confirmation.textContent, /Permanently deletes/);
    await act(async () => confirmation.querySelector('button.danger').click());
    assert.deepEqual(calls.at(-1), ['deleteLocalProviderModel', ['confirmed-file']]);
  } finally { await mounted.dispose(); }
});

test('a damaged existing model remains repairable without showing uninstalled search candidates', async () => {
  const current = status({
    installed: true, runtime: { installed: true },
    models: [
      { id: 'damaged', name: 'Damaged model', installed: false, present: true },
      { id: 'candidate', name: 'Uninstalled candidate', installed: false, present: false },
    ],
  });
  const mounted = await mount({
    readCapabilities: async () => [{ ok: true, value: { localProvider: current } }],
  }, current, async () => ({}));
  try {
    const detail = document.querySelector('[data-feature-id="localProvider"]');
    assert.match(detail.textContent, /Damaged model/);
    assert.match(detail.textContent, /Needs repair/);
    assert.doesNotMatch(detail.textContent, /Uninstalled candidate/);
    assert.equal([...detail.querySelectorAll('button')].find((button) => button.textContent === 'Repair').disabled, false);
  } finally { await mounted.dispose(); }
});

test('background hardware checks stay silent while real hardware failures remain visible', async () => {
  let current = status({ hardware: { checking: true, gpu: { name: 'RTX 3090' } } });
  const mounted = await mount({
    readCapabilities: async () => [{ ok: true, value: { localProvider: current } }],
  }, current, async () => ({}));
  try {
    const detail = () => document.querySelector('[data-feature-id="localProvider"]');
    assert.doesNotMatch(detail().textContent, /Checking hardware/);
    current = status({ hardware: { checking: false, error: 'GPU driver unavailable' } });
    await mounted.render(current);
    assert.match(detail().textContent, /GPU driver unavailable/);
  } finally { await mounted.dispose(); }
});
