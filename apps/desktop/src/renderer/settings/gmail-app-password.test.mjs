// Extensions → 커넥터 → Gmail → 앱 비밀번호로 연결: the dialog sends the
// address and the space-stripped password to the host once, shows Gmail's
// refusal in words, empties the password field after it, and closes once the
// host reports the connection.
import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'Event', 'CustomEvent'],
  actEnvironment: false,
});
globalThis.React = React;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.HTMLElement.prototype.attachEvent = () => {};
window.HTMLElement.prototype.detachEvent = () => {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const calls = [];
const opened = [];
let handlers = {};
window.mixdogDesktop = {
  setTitleBarDimmed() {},
  rendererDiagnostic() {},
  openExternal: async (url) => {
    opened.push(url);
  },
  async invokeCapability({ capability, args }) {
    calls.push([capability, args]);
    const handler = handlers[capability];
    if (!handler) throw new Error(`unexpected ${capability}`);
    return { value: await handler(...(args || [])) };
  },
};

const { CategoryPanel } = await import('./capability-panels.tsx');
const { cancelConnectorLogin } = await import('../connector-connect.ts');

const PASSWORD = 'abcdwxyzabcdwxyz';

function panelContext(servers) {
  return {
    api: {},
    data: { mcp: { servers }, plugins: { plugins: [] }, __loadedSections: ['mcp'] },
    snapshot: null,
    pending: '',
    async run() {
      return {};
    },
    async refreshExtensions() {},
    async route() {},
    async setFast() {},
    confirm() {},
    notice() {},
    updaterState: { status: 'disabled' },
    async checkDesktopUpdate() {},
    async installDesktopUpdate() {},
  };
}

const settle = (ms = 0) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
const button = (scope, label) =>
  [...scope.querySelectorAll('button')].find((node) => node.textContent.trim() === label);
async function click(node) {
  assert.ok(node, 'button exists');
  await act(async () => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}
function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

test('the app-password dialog verifies on the host, explains a refusal, then connects', async () => {
  let live = [];
  let refuse = true;
  handlers = {
    mcpStatus: () => ({ servers: live }),
    addMcpServer: (input) => {
      if (refuse) throw new Error('GMAIL_APP_PASSWORD_REJECTED: Google did not accept this address and app password.');
      live = [
        {
          name: input.name,
          connector: 'gmail',
          enabled: true,
          connected: true,
          appPassword: { account: 'me@gmail.com' },
        },
      ];
      return { name: input.name };
    },
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(React.createElement(CategoryPanel, { category: 'connectors', context: panelContext([]) }))
  );
  // Gmail's 연결 goes straight to the app-password dialog: no detail, no chooser, no Google sign-in.
  await click(host.querySelector('[data-connector-row="gmail"] .extensions-row-open'));
  assert.equal(document.body.querySelector('.connectors-detail-dialog'), null, 'no detail dialog first');
  const dialog =
    document.body.querySelector('[aria-labelledby="connectors-gmail-app-password-title"]') ?? document.body;
  const address = dialog.querySelector('input[name="gmail-address"]');
  const password = dialog.querySelector('input[name="gmail-app-password"]');
  assert.ok(address && password, 'address and app password fields');
  assert.equal(password.type, 'password');
  assert.deepEqual(opened, ['https://myaccount.google.com/apppasswords'], 'the page opens with the dialog');
  assert.match(dialog.textContent, /The Google app password page was opened in your browser\./);
  assert.equal(dialog.querySelectorAll('ol > li').length, 2, 'two numbered steps');
  await click(button(dialog, 'Open the app password page ↗'));
  assert.deepEqual(opened, Array(2).fill('https://myaccount.google.com/apppasswords'));

  type(address, ' Me@Gmail.com ');
  type(password, 'abcd wxyz abcd wxyz');
  await click(button(dialog, 'Connect'));
  await settle();
  const sent = calls.find(([capability]) => capability === 'addMcpServer')[1][0];
  assert.equal(sent.appPassword, PASSWORD, 'spaces are stripped');
  assert.deepEqual(sent.headers, { 'X-Mixdog-Gmail-Account': 'me@gmail.com' });
  assert.equal(sent.connector, 'gmail');
  assert.match(
    document.body.textContent,
    /Google did not accept this address and app password\. Check both and try again\./
  );
  assert.equal(password.value, '', 'the password field is emptied after a refusal');
  assert.equal(address.value.trim(), 'Me@Gmail.com', 'the address stays');

  refuse = false;
  type(password, PASSWORD);
  await click(button(dialog, 'Connect'));
  await settle();
  assert.equal(document.body.querySelector('input[name="gmail-app-password"]'), null, 'the dialog closed');
  assert.ok(calls.filter(([capability]) => capability === 'mcpStatus').length >= 2, 'the host confirmed it');
  assert.ok(!calls.some(([capability]) => capability === 'beginMcpOAuthLogin'), 'no Google sign-in');

  // The row then names the account; its detail offers a password change, not the Google key.
  await act(async () =>
    root.render(React.createElement(CategoryPanel, { category: 'connectors', context: panelContext(live) }))
  );
  const row = host.querySelector('[data-connector-row="gmail"]');
  assert.match(row.textContent, /me@gmail\.com/);
  await click(row.querySelector('.extensions-row-open'));
  const detail = document.body.querySelector('.connectors-detail-dialog');
  assert.match(detail.textContent, /Connected with an app password/);
  assert.doesNotMatch(detail.textContent, /search, read/i);
  assert.match(detail.textContent, /Searches, reads and organizes your mail\./);
  assert.match(detail.textContent, /Sending and Trash ask first\./);
  assert.ok(detail.querySelector('.row-overflow-trigger'), 'the account row has a ⋯ menu');
  assert.ok(button(detail, '+ Add account'));
  assert.equal(button(detail, 'Change app password'), undefined, 'no stacked link');
  assert.equal(button(detail, 'Disconnect'), undefined, 'no footer disconnect for Gmail');
  assert.equal(button(detail, 'Use my Google key'), undefined);
  cancelConnectorLogin('gmail');
  await act(async () => root.unmount());
  host.remove();
});
