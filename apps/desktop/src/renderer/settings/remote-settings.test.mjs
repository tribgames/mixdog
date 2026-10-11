import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

function api() {
  return {
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
}

async function renderSettings(t, { remote }) {
  const { root, document, window } = installTestDom(t, {
    rootId: 'root',
    expose: ['HTMLElement', 'Node', 'Element', 'KeyboardEvent', 'MutationObserver'],
  });
  if (remote) {
    window.mixdogRemoteServer = 'relay';
    window.mixdogRemoteWindow = { hostId: 'a', hostName: 'Home PC' };
    window.mixdogRemoteWindowSwitcher = {
      listHosts: () => Promise.resolve([{ id: 'a', name: 'Home PC', online: true, lastConnectedAt: 1, current: true }]),
      openHost: () => Promise.resolve(true),
      manageConnections: () => Promise.resolve(true),
    };
  }
  const { SettingsView } = await import('./SettingsView');
  await act(async () => root.render(React.createElement(SettingsView, { api: api(), open: true, onClose: () => {} })));
  return document;
}

const railLabels = (document) =>
  [...document.querySelectorAll('.mixdog-settings__rail-group button')].map((button) =>
    button.getAttribute('aria-label')
  );

test('remote settings: This device group holds Display, the PC group holds the rest, pages carry a where badge', async (t) => {
  const document = await renderSettings(t, { remote: true });
  const groups = [...document.querySelectorAll('.mixdog-settings__rail-group')];
  assert.equal(groups.length, 2);
  assert.match(groups[0].querySelector('.mixdog-settings__rail-group-label').textContent, /This device/);
  assert.deepEqual(
    [...groups[0].querySelectorAll('button')].map((button) => button.getAttribute('aria-label')),
    ['Display']
  );
  assert.match(groups[1].querySelector('.mixdog-settings__rail-group-label').textContent, /Home PC/);
  assert.ok(railLabels(document).includes('General'));
  // General (a PC page): badge names the PC and the device-local settings are gone.
  assert.match(document.querySelector('.mixdog-settings__where').textContent, /Home PC/);
  assert.equal(document.querySelector('.mixdog-settings__where').dataset.settingsWhere, 'pc');
  assert.equal(document.body.textContent.includes('Display language'), false);
  await act(async () => groups[0].querySelector('button').click());
  assert.equal(document.querySelector('#mixdog-settings-title').textContent, 'Display');
  assert.equal(document.querySelector('.mixdog-settings__where').dataset.settingsWhere, 'device');
  assert.match(document.querySelector('.mixdog-settings__where').textContent, /This device/);
  for (const title of ['Display language', 'Theme', 'Link preview', 'Side panels']) {
    assert.ok(document.body.textContent.includes(title), title);
  }
});

test('main PC settings keep one flat nav with no group labels, badge or Display page', async (t) => {
  const document = await renderSettings(t, { remote: false });
  assert.equal(document.querySelectorAll('.mixdog-settings__rail-group').length, 1);
  assert.equal(document.querySelector('.mixdog-settings__rail-group-label'), null);
  assert.equal(document.querySelector('.mixdog-settings__where'), null);
  assert.equal(railLabels(document).includes('Display'), false);
  for (const title of ['Display language', 'Theme', 'Side panels']) {
    assert.ok(document.body.textContent.includes(title), title);
  }
});
