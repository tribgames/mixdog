import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';

const stubApi = {
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

async function openRenamePromptInSettings(t) {
  const { root, document, window } = installTestDom(t, {
    rootId: 'root',
    expose: ['HTMLElement', 'Node', 'Element', 'KeyboardEvent', 'MutationObserver'],
  });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.mixdogDesktop = { setTitleBarDimmed() {}, rendererDiagnostic() {} };
  globalThis.React = React;
  const { SettingsView } = await import('./SettingsView');
  const { SettingsConfirmDialog } = await import('./capability-controls');
  const calls = { settingsClosed: 0, promptClosed: 0 };
  await act(async () =>
    root.render(
      React.createElement(SettingsView, {
        api: stubApi,
        open: true,
        onClose: () => {
          calls.settingsClosed += 1;
        },
      })
    )
  );
  // The prompt mounts inside the settings dialog, as a rename prompt does.
  const slot = document.querySelector('.mixdog-settings').appendChild(document.createElement('div'));
  const promptRoot = createRoot(slot);
  await act(async () =>
    promptRoot.render(
      React.createElement(SettingsConfirmDialog, {
        options: { title: 'Rename', confirmLabel: 'Rename', input: { value: 'old', label: 'Name' }, onConfirm() {} },
        onClose: () => {
          calls.promptClosed += 1;
          promptRoot.render(null);
        },
      })
    )
  );
  const input = document.querySelector('[data-settings-nested-dialog] input');
  assert.ok(input);
  const press = (key, init = {}) =>
    act(async () => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    });
  return { calls, press, document };
}

test('Escape during IME composition keeps a rename prompt inside Settings open', async (t) => {
  const { calls, press, document } = await openRenamePromptInSettings(t);
  await press('Escape', { isComposing: true });
  await press('Escape', { keyCode: 229 });
  assert.equal(calls.promptClosed, 0);
  assert.equal(calls.settingsClosed, 0);
  assert.ok(document.querySelector('[data-settings-nested-dialog]'));
});

test('plain Escape closes only the rename prompt inside Settings', async (t) => {
  const { calls, press, document } = await openRenamePromptInSettings(t);
  await press('Escape');
  assert.equal(calls.promptClosed, 1);
  assert.equal(calls.settingsClosed, 0);
  assert.equal(document.querySelector('[data-settings-nested-dialog]'), null);
});
