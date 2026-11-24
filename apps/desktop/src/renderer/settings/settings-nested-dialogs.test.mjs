import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

const settingsApi = {
  async readCapabilities(requests) {
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
  async getUpdaterState() {
    return { status: 'idle' };
  },
  async checkForDesktopUpdate() {
    return { status: 'idle' };
  },
  subscribeState: () => () => {},
  subscribeUpdaterState: () => () => {},
};

// The saved logins the panel reads when it is shown: the test answers the read.
const vault = Promise.withResolvers();
const authApi = {
  browserVaultLogins: () => vault.promise,
  browserSignedInSites: async () => [],
  browserClearSignIns: async () => {},
  readSettings: async () => ({ browserAutoSignIn: true, saveChatLogins: true }),
};

test('Escape and Tab stay with a dialog portaled out of Settings and with a Connection dialog inside it', async (t) => {
  const { root, document, window } = installTestDom(t, {
    rootId: 'root',
    expose: [
      'HTMLElement',
      'HTMLInputElement',
      'Node',
      'Element',
      'KeyboardEvent',
      'MouseEvent',
      'Event',
      'CustomEvent',
    ],
  });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.mixdogDesktop = { setTitleBarDimmed() {}, rendererDiagnostic() {} };
  globalThis.React = React;
  // react-dom reads the DOM's input-event support once at load, so it loads after the test DOM exists.
  const { createRoot } = await import('react-dom/client');
  const { SettingsView } = await import('./SettingsView');
  const { AuthPanel } = await import('./auth-panel');
  const { ConfirmDialog } = await import('./connection-dialogs');
  let settingsClosed = 0;
  await act(async () =>
    root.render(
      React.createElement(SettingsView, {
        api: settingsApi,
        open: true,
        onClose: () => {
          settingsClosed += 1;
        },
      })
    )
  );
  const settings = document.querySelector('.mixdog-settings');
  const slots = [];
  const slot = async (element) => {
    const slotRoot = createRoot(settings.appendChild(document.createElement('div')));
    slots.push(slotRoot);
    await act(async () => slotRoot.render(element));
  };
  const press = (key) =>
    act(async () => {
      (document.activeElement || document.body).dispatchEvent(
        new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      );
    });
  await slot(React.createElement(AuthPanel, { api: authApi }));
  await act(async () =>
    vault.resolve([
      {
        id: 'a'.repeat(24),
        origin: 'https://github.com',
        username: 'sample',
        hasPassword: true,
        hasTotp: false,
        source: 'csv',
        note: '',
        autoSignIn: true,
      },
    ])
  );

  // 로그인 추가 is portaled to document.body, outside the Settings dialog.
  const add = [...document.querySelectorAll('.auth-tools button')].find((node) => node.textContent.trim() === 'Add');
  await act(async () => add.click());
  const login = document.querySelector('body > .settings-oauth-layer [role="dialog"]');
  assert.ok(login);
  assert.equal(settings.contains(login), false);
  login.querySelector('input').focus();
  await press('Tab');
  assert.ok(login.contains(document.activeElement), 'Tab stays in the login dialog');
  await press('Escape');
  assert.equal(document.querySelector('.settings-oauth-layer'), null, 'Escape closes the login dialog');

  const clear = [...document.querySelectorAll('button')].find((node) => node.textContent === 'Clear all saved logins');
  await act(async () => clear.click());
  assert.ok(document.querySelector('body > .settings-confirm-layer [data-settings-nested-dialog]'));
  await press('Escape');
  assert.equal(document.querySelector('.settings-confirm-layer'), null, 'Escape closes the clear-all confirmation');

  let connectionClosed = 0;
  await slot(
    React.createElement(ConfirmDialog, {
      title: 'Disconnect?',
      description: 'The device is signed out.',
      confirmLabel: 'Disconnect',
      onConfirm() {},
      onClose() {
        connectionClosed += 1;
      },
    })
  );
  await press('Escape');
  assert.equal(connectionClosed, 1, 'Escape closes the Connection dialog');

  assert.equal(settingsClosed, 0, 'Settings stayed open underneath every dialog');
  for (const slotRoot of slots) await act(async () => slotRoot.unmount());
});
