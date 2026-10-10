import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

const DOM_GLOBALS = ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Event'];
const savedGlobals = DOM_GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mixdog.test/' });
for (const key of DOM_GLOBALS)
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const preflights = [];
let fitFor = () => ({ known: true, fits: true, willCompact: false, percent: 38 });
Object.assign(window, {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  mixdogDesktop: {
    rendererDiagnostic() {},
    async invokeCapability(request) {
      if (request.capability === 'inheritancePreflight') {
        preflights.push(request.args);
        return { value: fitFor(request.args[1]) };
      }
      return { value: undefined };
    },
  },
});
after(() => {
  dom.window.close();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

const { createRoot } = await import('react-dom/client');
const { InheritBody } = await import('./command-surface-inherit.tsx');
const { resetSidebarReferenceCache, adoptSidebarReferenceHost, updateSidebarReference } = await import(
  './sidebar-reference-cache.ts'
);

const snapshot = {
  sessionId: 'source',
  provider: 'anthropic-oauth',
  model: 'claude-opus-5',
  items: [
    { kind: 'user', text: 'hi' },
    { kind: 'assistant', text: 'hello' },
  ],
};

async function mount(t, props = {}) {
  resetSidebarReferenceCache();
  adoptSidebarReferenceHost(window.mixdogDesktop);
  updateSidebarReference('providerSetup', undefined);
  updateSidebarReference('quickProviderModels', [
    { provider: 'anthropic-oauth', model: 'claude-opus-5', display: 'Claude Opus 5', effortOptions: [] },
  ]);
  preflights.length = 0;
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    resetSidebarReferenceCache();
  });
  await act(async () =>
    root.render(React.createElement(InheritBody, { snapshot, sessionId: 'source', onClose() {}, ...props }))
  );
  return host;
}

test('the Model row hosts the route picker and preflights the chosen route', async (t) => {
  fitFor = () => ({ known: true, fits: true, willCompact: false, percent: 38 });
  const host = await mount(t, { onInherit: async () => {} });
  const row = host.querySelector('.command-surface-facts > div');
  assert.equal(row.querySelector('dt').textContent, 'Model');
  assert.ok(row.querySelector('dd button'));
  assert.deepEqual(preflights.at(-1), ['source', { provider: 'anthropic-oauth', model: 'claude-opus-5' }]);
  assert.equal(host.querySelector('.command-surface-facts dd[data-tone]'), null);
});

test('original inheritance is the default and passes { compact: false }', async (t) => {
  fitFor = () => ({ known: true, fits: true, willCompact: false, percent: 38 });
  const calls = [];
  const host = await mount(t, { onInherit: async (...args) => calls.push(args) });
  const radios = [...host.querySelectorAll('input[type="radio"]')];
  assert.equal(radios.length, 2);
  assert.equal(radios[0].checked, true);
  assert.equal(radios[0].disabled, false);
  const primary = host.querySelector('.inherit-surface-actions > button:not(.inherit-surface-cancel)');
  assert.equal(primary.textContent, 'Original inheritance');
  await act(async () => primary.click());
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'source');
  assert.equal(calls[0][1].model, 'claude-opus-5');
  assert.deepEqual(calls[0][2], { compact: false });
});

test('choosing compact relabels the button and passes { compact: true }', async (t) => {
  fitFor = () => ({ known: true, fits: true, willCompact: false, percent: 38 });
  const calls = [];
  const host = await mount(t, { onInherit: async (...args) => calls.push(args) });
  await act(async () => host.querySelectorAll('input[type="radio"]')[1].click());
  const primary = host.querySelector('.inherit-surface-actions > button:not(.inherit-surface-cancel)');
  assert.equal(primary.textContent, 'Compact then inherit');
  await act(async () => primary.click());
  assert.deepEqual(calls[0][2], { compact: true });
});

test('a conversation the model cannot hold disables original inheritance and selects compact', async (t) => {
  fitFor = () => ({ known: true, fits: false, willCompact: true, percent: 142 });
  const calls = [];
  const host = await mount(t, { onInherit: async (...args) => calls.push(args) });
  const radios = [...host.querySelectorAll('input[type="radio"]')];
  assert.equal(radios[0].disabled, true);
  assert.equal(radios[0].checked, false);
  assert.equal(radios[1].checked, true);
  assert.match(host.textContent, /does not fit this model/);
  assert.equal(host.querySelector('dd[data-tone="danger"]').textContent, '142%');
  const primary = host.querySelector('.inherit-surface-actions > button:not(.inherit-surface-cancel)');
  assert.equal(primary.textContent, 'Compact then inherit');
  await act(async () => primary.click());
  assert.deepEqual(calls[0][2], { compact: true });
});
