import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

// react-dom reads the DOM at load time (input-event support), so the window must exist first.
const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'MouseEvent', 'Node', 'Element'],
  actEnvironment: false,
});
test.after(restore);
const { createRoot } = await import('react-dom/client');
const { ProvidersPanel } = await import('./provider-panel.tsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function renderWithKeychain(t, keychain) {
  const root = createRoot(document.querySelector('main'));
  t.after(async () => {
    await act(async () => root.unmount());
  });
  await act(async () =>
    root.render(
      React.createElement(ProvidersPanel, {
        api: {},
        data: { providerSetup: { api: [], oauth: [], keychain }, __loadedSections: ['providerSetup'] },
        pending: '',
        run: async () => undefined,
        confirm: () => {},
      })
    )
  );
  return document.querySelector('[role="alert"][data-keychain-state]');
}

test('an unsafe fallback store shows the repair hint and the folder in the keychain alert, without an unlock action', async (t) => {
  const alert = await renderWithKeychain(t, {
    state: 'unsafe-store',
    message: 'Repair the secrets folder permissions (chmod 700 / chmod 600) or save the key again.',
    path: '/home/u/.mixdog/secrets',
  });
  assert.equal(alert.getAttribute('data-keychain-state'), 'unsafe-store');
  assert.ok(alert.textContent.includes('chmod 700'));
  assert.equal(alert.querySelector('code').textContent, '/home/u/.mixdog/secrets');
  assert.equal(alert.querySelector('button'), null);
});

test('no keychain alert is rendered when setup reports no issue', async (t) => {
  assert.equal(await renderWithKeychain(t, undefined), null);
});
