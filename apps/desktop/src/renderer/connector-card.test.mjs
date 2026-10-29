// The chat connect card and the connect function: Gmail never takes the Google
// sign-in, a build without the built-in Google client shows the own-client note
// and never starts that sign-in, and the card's status text is not truncated.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

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
let handlers = {};
window.mixdogDesktop = {
  setTitleBarDimmed() {},
  rendererDiagnostic() {},
  openExternal: async () => {},
  async invokeCapability({ capability, args }) {
    calls.push([capability, args]);
    const handler = handlers[capability];
    if (!handler) throw new Error(`unexpected ${capability}`);
    return { value: await handler(...(args || [])) };
  },
};

const { connectCatalogConnector, OPEN_CONNECTORS_EVENT, startConnectorLogin } = await import('./connector-connect.ts');
const { ConnectorChatCard } = await import('./connector-card.tsx');
const { connectorById } = await import('../../../../src/runtime/shared/connector-catalog.mjs');

const started = () =>
  calls.filter(([capability]) => ['addMcpServer', 'beginMcpOAuthLogin'].includes(capability)).length;

async function render(element) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  return {
    host,
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('Gmail never takes the Google sign-in: not from the connect function, not from the chat card', async () => {
  calls.length = 0;
  handlers = { mcpStatus: () => ({ servers: [], googleClient: true }) };
  await assert.rejects(connectCatalogConnector(connectorById('gmail')), /app password only/);
  assert.equal(started(), 0);

  let opened = 0;
  window.addEventListener(OPEN_CONNECTORS_EVENT, () => {
    opened += 1;
  });
  const pane = await render(React.createElement(ConnectorChatCard, { id: 'gmail' }));
  const card = pane.host.querySelector('[data-connector-card="gmail"]');
  assert.match(card.textContent, /app password/);
  assert.doesNotMatch(card.textContent, /Sign in in the browser/);
  await act(async () => {
    [...card.querySelectorAll('button')]
      .find((node) => node.textContent.trim() === 'Connect')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(opened, 1, 'the Connectors tab (app-password dialog) opens');
  assert.equal(started(), 0);
  await pane.unmount();
});

test('a Gmail already on the Google sign-in can still reconnect', async () => {
  calls.length = 0;
  handlers = {
    mcpStatus: () => ({
      servers: [{ name: 'gmail', connector: 'gmail', enabled: true, authRequired: true }],
      googleClient: true,
    }),
    beginMcpOAuthLogin: () => ({ flowId: 'f', state: 'pending', url: 'https://accounts.google.com/x' }),
    getMcpOAuthLoginStatus: () => ({ flowId: 'f', state: 'pending' }),
    cancelMcpOAuthLogin: () => ({ state: 'cancelled' }),
  };
  await connectCatalogConnector(connectorById('gmail'));
  assert.ok(calls.some(([capability]) => capability === 'beginMcpOAuthLogin'));
  const { cancelConnectorLogin } = await import('./connector-connect.ts');
  cancelConnectorLogin('gmail');
});

test('a build without the Google client shows the own-client note and never starts the login', async () => {
  calls.length = 0;
  handlers = { mcpStatus: () => ({ servers: [], googleClient: false }) };
  await assert.rejects(connectCatalogConnector(connectorById('google-calendar')), /your own Google client/);
  assert.equal(started(), 0);

  let opened = 0;
  window.addEventListener(OPEN_CONNECTORS_EVENT, () => {
    opened += 1;
  });
  const pane = await render(React.createElement(ConnectorChatCard, { id: 'google-drive' }));
  const card = pane.host.querySelector('[data-connector-card="google-drive"]');
  assert.match(card.textContent, /needs? your own Google client|Use your own Google client/);
  await act(async () => {
    [...card.querySelectorAll('button')]
      .find((node) => node.textContent.trim() === 'Connect')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(opened, 1);
  assert.equal(started(), 0);
  await pane.unmount();

  // With the user's own client on a server, the sign-in is offered again.
  handlers = {
    mcpStatus: () => ({
      servers: [
        { name: 'google-drive', connector: 'google-drive', enabled: true, authRequired: true, ownClient: true },
      ],
      googleClient: false,
    }),
  };
  const own = await render(React.createElement(ConnectorChatCard, { id: 'google-drive' }));
  assert.match(own.host.textContent, /Sign-in required|Sign in in the browser/);
  assert.doesNotMatch(own.host.textContent, /no built-in Google sign-in/);
  await own.unmount();
});

test('another account is judged on its own client, not on a sibling that has one', async () => {
  const calendar = connectorById('google-calendar');
  const mine = { name: 'google-calendar', connector: 'google-calendar', enabled: true, ownClient: true };
  const other = { name: 'google-calendar-2', connector: 'google-calendar', enabled: true, authRequired: true };
  calls.length = 0;
  handlers = {
    mcpStatus: () => ({ servers: [mine, other], googleClient: false }),
    addMcpServer: () => ({}),
    beginMcpOAuthLogin: () => ({ flowId: 'f', state: 'pending', url: 'https://accounts.google.com/x' }),
    getMcpOAuthLoginStatus: () => ({ flowId: 'f', state: 'pending' }),
    cancelMcpOAuthLogin: () => ({ state: 'cancelled' }),
  };
  await assert.rejects(
    connectCatalogConnector(calendar, '', null, { server: 'google-calendar-2' }),
    /your own Google client/
  );
  await assert.rejects(connectCatalogConnector(calendar, '', null, { add: true }), /your own Google client/);
  assert.equal(started(), 0, 'neither a reconnect of the bare account nor a new account starts a login');
  await connectCatalogConnector(calendar, '', null, { server: 'google-calendar' });
  assert.deepEqual(calls.find(([capability]) => capability === 'beginMcpOAuthLogin')[1], ['google-calendar']);
  const { cancelConnectorLogin } = await import('./connector-connect.ts');
  cancelConnectorLogin('google-calendar');
});

test('the chat card keeps failure text whole: the status is one <small> the CSS lets wrap', async (t) => {
  const long =
    'The connection failed because the server answered with a very long explanation that must stay readable.';
  calls.length = 0;
  handlers = {
    mcpStatus: () => ({
      servers: [{ name: 'notion', connector: 'notion', enabled: true, connected: false, authRequired: true }],
    }),
    beginMcpOAuthLogin: () => {
      throw new Error(long);
    },
  };
  await startConnectorLogin('notion', 'Notion', { connector: 'notion' });
  const pane = await render(React.createElement(ConnectorChatCard, { id: 'notion' }));
  t.after(() => pane.unmount());
  const small = pane.host.querySelector('.connector-chat-copy > small');
  assert.ok(small.textContent.includes('very long explanation'));
  // Rendered: the real stylesheet is injected and jsdom's cascade decides how the status text wraps.
  const style = document.createElement('style');
  t.after(() => style.remove());
  style.textContent = readFileSync(new URL('./connectors.css', import.meta.url), 'utf8');
  document.head.append(style);
  const computed = window.getComputedStyle(small);
  assert.equal(computed.whiteSpace, 'normal');
  assert.notEqual(computed.textOverflow, 'ellipsis');
});
