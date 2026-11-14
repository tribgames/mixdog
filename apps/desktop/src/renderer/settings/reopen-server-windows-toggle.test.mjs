import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { useConnectionsCore } from '../test-support/connections-core-mock.mjs';
import { installTestDom } from '../test-support/test-dom.mjs';

const { ReopenServerWindowsToggle } = await import('./reopen-server-windows-toggle.tsx');

const DOM = { rootId: 'root', expose: ['HTMLElement', 'Node', 'Event'] };
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

async function mount(t, core) {
  useConnectionsCore(core);
  const dom = installTestDom(t, DOM);
  await act(async () => dom.root.render(React.createElement(ReopenServerWindowsToggle)));
  await settle();
  return dom;
}

const checkbox = (document) => document.querySelector('input[type="checkbox"], [role="switch"]');
const isOn = (el) => (el.type === 'checkbox' ? el.checked : el.getAttribute('aria-checked') === 'true');

test('the toggle shows the stored setting and nothing until it is read', async (t) => {
  const pending = Promise.withResolvers();
  const dom = await mount(t, { getReopenServerWindows: () => pending.promise });
  assert.equal(dom.document.querySelector('.mixdog-settings__row'), null);
  await act(async () => pending.resolve(true));
  assert.match(dom.document.body.textContent, /Reopen server windows when the app starts/);
  assert.equal(isOn(checkbox(dom.document)), true);
});

test('a setting that cannot be read leaves no toggle', async (t) => {
  const dom = await mount(t, { getReopenServerWindows: () => Promise.reject(new Error('down')) });
  assert.equal(dom.document.querySelector('.mixdog-settings__row'), null);
});

test('turning it off stores the choice and shows what the core read back', async (t) => {
  const stored = [];
  const dom = await mount(t, {
    getReopenServerWindows: () => Promise.resolve(true),
    setReopenServerWindows: (value) => {
      stored.push(value);
      return Promise.resolve(value);
    },
  });
  await act(async () => checkbox(dom.document).click());
  await settle();
  assert.deepEqual(stored, [false]);
  assert.equal(isOn(checkbox(dom.document)), false);
});

test('a choice the core could not store goes back to the previous state', async (t) => {
  const dom = await mount(t, {
    getReopenServerWindows: () => Promise.resolve(true),
    setReopenServerWindows: () => Promise.reject(new Error('disk')),
  });
  await act(async () => checkbox(dom.document).click());
  await settle();
  assert.equal(isOn(checkbox(dom.document)), true);
});
