import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mixdog.test/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, React, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { ComputerAuthorizationPanel } = await import('./computer-authorization-panel.tsx');

test('authorization form submits selected exact process, actions and bounded expiry only after save', async () => {
  const element = document.createElement('main'); document.body.append(element);
  const root = createRoot(element);
  const writes = [];
  const api = {
    computerReadAuthorization: async () => ({ policy: null, externallyRestricted: true, updating: false }),
    computerAuthorizationWindows: async () => [{ id: 'hwnd:0x42', pid: 42, app: 'fixture.exe', title: 'fixture' }],
    computerUpdateAuthorization: async (value) => {
      writes.push(value);
      return { policy: value, externallyRestricted: true, updating: false };
    },
  };
  const button = (text) => [...element.querySelectorAll('button')].find((button) => button.textContent.includes(text));
  try {
    await act(async () => root.render(React.createElement(ComputerAuthorizationPanel, { api, enabled: true })));
    await act(async () => button('Refresh windows').click());
    await act(async () => element.querySelector('input[type=checkbox]').click());
    assert.equal(writes.length, 0);
    await act(async () => button('Save authorization').click());
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].windows, [{ id: 'hwnd:0x42', pid: 42 }]);
    assert.deepEqual(writes[0].actions, ['list', 'capture', 'diagnose', 'verify']);
    assert.equal(writes[0].allowElevatedInput, false);
    assert.ok(Date.parse(writes[0].expiresAt) > Date.now());
    assert.ok(Date.parse(writes[0].expiresAt) <= Date.now() + 30 * 60_000);
    await act(async () => root.render(React.createElement(ComputerAuthorizationPanel, { api: {}, enabled: true })));
    assert.equal(element.querySelector('fieldset'), null);
  } finally { await act(async () => root.unmount()); element.remove(); }
});
