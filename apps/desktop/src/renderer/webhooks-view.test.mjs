// Stored webhook rows may carry no parser (the column is nullable and the
// store's reader substitutes 'github'). The list sub-line and the editor must
// read that legacy row as the same parser, or the next save silently rewrites
// it.
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
Object.assign(window, {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  mixdogDesktop: { rendererDiagnostic() {} },
});
after(() => {
  dom.window.close();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

const { createRoot } = await import('react-dom/client');
const { WebhooksPane } = await import('./WebhooksView.tsx');
const { resetSidebarReferenceCache, adoptSidebarReferenceHost, updateSidebarReference } = await import(
  './sidebar-reference-cache.ts'
);

test('a legacy webhook without a stored parser lists and opens as the same parser', async (t) => {
  const api = {
    async invokeCapability() {
      return { value: undefined };
    },
  };
  resetSidebarReferenceCache();
  adoptSidebarReferenceHost(api);
  updateSidebarReference('channelSetup', {
    webhook: { publicUrl: 'https://hooks.mixdog.test' },
    webhooks: [{ name: 'legacy', enabled: true, secretSet: true }],
  });
  updateSidebarReference('projects', []);
  updateSidebarReference('workflows', []);
  updateSidebarReference('providerSetup', {});
  updateSidebarReference('quickProviderModels', []);
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    resetSidebarReferenceCache();
  });

  await act(async () => root.render(React.createElement(WebhooksPane, { api, active: true })));
  const row = host.querySelector('.schedules-row');
  assert.ok(row);
  const listed = row.querySelector('small').textContent;

  await act(async () => row.click());
  const edited = document.querySelector('[aria-label="Webhook payload format"] .mx-select-value').textContent;

  assert.match(listed, /^github /);
  assert.equal(edited, 'GitHub');
});

test('without a cryptographic random source, regenerating a signing secret reports an error instead of a weak secret', async (t) => {
  const api = {
    async invokeCapability() {
      return { value: undefined };
    },
  };
  resetSidebarReferenceCache();
  adoptSidebarReferenceHost(api);
  updateSidebarReference('channelSetup', {
    webhook: { publicUrl: 'https://hooks.mixdog.test' },
    webhooks: [{ name: 'legacy', enabled: true, secretSet: true }],
  });
  updateSidebarReference('projects', []);
  updateSidebarReference('workflows', []);
  updateSidebarReference('providerSetup', {});
  updateSidebarReference('quickProviderModels', []);
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    resetSidebarReferenceCache();
  });
  t.mock.method(globalThis.crypto, 'getRandomValues', () => {
    throw new Error('entropy source unavailable');
  });

  await act(async () => root.render(React.createElement(WebhooksPane, { api, active: true })));
  await act(async () => host.querySelector('.schedules-row').click());
  const regenerate = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Regenerate secret'
  );
  assert.ok(regenerate);
  await act(async () => regenerate.click());

  const secrets = [...document.querySelectorAll('.webhook-connection-value code')].filter((code) =>
    /^[0-9a-f]{48}$/.test(code.textContent)
  );
  assert.deepEqual(secrets, []);
  assert.ok(document.querySelector('.schedules-dialog .error-notice'));
});
