import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { ProviderAccountsList } from './ProviderAccountsList.tsx';
import { OAuthControl, ProvidersPanel } from './settings/provider-panel.tsx';
import { SidebarUsage } from './SidebarUsage.tsx';
import { publishUsageDashboard } from './usage-dashboard-store.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function harness(t) {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'https://mixdog.test/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const root = createRoot(document.querySelector('main'));
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  return async (element) => act(async () => root.render(element));
}

test('inline accounts support click selection, drag-and-drop priority, keyboard reorder and auto toggle', async (t) => {
  const render = harness(t);
  let pool = {
    selectedId: 'a', auto: true,
    accounts: ['a', 'b', 'c'].map((id) => ({ id, label: id, authenticated: true, usage: { windows: [{ usedPct: 12 }] } })),
  };
  const writes = [];
  const api = { async invokeCapability({ capability, args }) {
    if (capability === 'getUsageDashboard') return { value: { rows: [] } };
    if (capability === 'updateProviderAccounts') {
      writes.push(args[1]);
      if (args[1].order) pool = { ...pool, accounts: args[1].order.map((id) => pool.accounts.find((row) => row.id === id)) };
      else pool = { ...pool, ...args[1] };
    }
    return { value: structuredClone(pool) };
  } };
  await render(React.createElement(ProviderAccountsList, { api, provider: 'openai-oauth', listOnly: true }));
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.querySelectorAll('.provider-accounts-list li').length, 3);
  await act(async () => document.querySelector('[data-account-id="b"] .provider-account-choice').click());
  assert.equal(pool.selectedId, 'b');
  assert.equal(document.querySelector('[data-account-id="b"] .provider-account-choice').getAttribute('aria-pressed'), 'true');
  // Pointer reorder against a stubbed 32px row grid: grab row c (y 64..96),
  // lift it past the threshold, drag its center over slot 0, release.
  const ROW = 32;
  const rect = (top, height) => ({ x: 0, y: top, top, left: 0, bottom: top + height, right: 260, width: 260, height, toJSON() { return {}; } });
  const list = document.querySelector('.provider-accounts-list');
  list.getBoundingClientRect = () => rect(0, ROW * 3);
  document.querySelectorAll('.provider-accounts-list > li').forEach((li, i) => {
    li.getBoundingClientRect = () => rect(ROW * i, ROW);
  });
  window.HTMLElement.prototype.setPointerCapture ??= () => {};
  window.HTMLElement.prototype.releasePointerCapture ??= () => {};
  const grip = document.querySelector('[data-account-id="c"] .provider-account-grip');
  // jsdom ships no PointerEvent; a MouseEvent with the pointer fields React
  // reads (pointerId, button, clientY) exercises the same handlers.
  const pointer = (type, clientY) => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientY, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    return event;
  };
  await act(async () => grip.dispatchEvent(pointer('pointerdown', ROW * 2 + 10)));
  await act(async () => grip.dispatchEvent(pointer('pointermove', ROW * 2 + 12)));
  // 2px, under the 4px threshold: nothing lifted yet, no write. Assert on
  // booleans only — a DOM node in a failed assertion makes node:assert walk
  // the whole JSDOM graph.
  assert.equal(document.querySelector('.is-lifted') === null, true);
  await act(async () => grip.dispatchEvent(pointer('pointermove', 10)));
  const lifted = document.querySelector('[data-account-id="c"]');
  assert.ok(lifted.classList.contains('is-lifted'), 'the grabbed row itself lifts');
  assert.match(lifted.style.transform, /translateY\(-?\d+px\)/, 'lifted row follows the pointer');
  assert.match(document.querySelector('[data-account-id="a"]').style.transform, /translateY\(32px\)/, 'displaced row shifts down');
  assert.equal(writes.length, 1, 'no order write until release');
  await act(async () => grip.dispatchEvent(pointer('pointerup', 10)));
  assert.deepEqual(pool.accounts.map((row) => row.id), ['c', 'a', 'b']);
  assert.equal(document.querySelector('.is-lifted') === null, true);
  assert.equal(pool.selectedId, 'b', 'reordering does not unexpectedly change the active account');
  await act(async () => document.querySelector('[data-account-id="b"] .provider-account-grip')
    .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true })));
  assert.deepEqual(pool.accounts.map((row) => row.id), ['c', 'b', 'a']);
  assert.equal(document.querySelector('.provider-account-auto'), null);
  assert.equal(writes.length, 3);
});

test('a rejected reorder keeps the saved order and displays the failure', async (t) => {
  const render = harness(t);
  const api = { async invokeCapability({ capability }) {
    if (capability === 'updateProviderAccounts') throw new Error('Save failed');
    return { value: { selectedId: 'a', auto: true,
      accounts: ['a', 'b'].map((id) => ({ id, label: id, authenticated: true })) } };
  } };
  await render(React.createElement(ProviderAccountsList, { api, provider: 'openai-oauth' }));
  await act(async () => document.querySelector('[data-account-id="b"] .provider-account-grip')
    .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true })));
  assert.deepEqual([...document.querySelectorAll('[data-account-id]')].map((row) => row.dataset.accountId), ['a', 'b']);
  assert.match(document.querySelector('[role="alert"]').textContent, /Save failed/);
});

test('add account starts a separate login instead of reconnecting the existing credential', async (t) => {
  const render = harness(t);
  const calls = [];
  await render(React.createElement(OAuthControl, {
    api: {}, provider: { id: 'openai-oauth', authenticated: true }, disabled: false, addAccount: true,
    run: async (...args) => { calls.push(args); return undefined; },
  }));
  await act(async () => document.querySelector('button').click());
  assert.deepEqual(calls[0][1], ['openai-oauth', { addAccount: true }]);
  assert.equal(document.querySelector('button').getAttribute('aria-label'), 'Add account');
  assert.equal(document.querySelector('input'), null);
});

test('provider popup preserves meters and opens only an account list beside the provider', async (t) => {
  const render = harness(t);
  publishUsageDashboard({ rows: [{ id: 'openai-oauth', group: 'oauth', authenticated: true, windows: [{ label: '7D', usedPct: 39 }] }] });
  let added = 0;
  let pinned = 0;
  const api = { async invokeCapability({ capability, args }) {
    if (capability === 'getUsageDashboard') return { value: { rows: [{ id: 'openai-oauth', group: 'oauth', authenticated: true }] } };
    return { value: { selectedId: 'a', auto: true, accounts: args[0] === 'openai-oauth'
      ? [{ id: 'a', label: 'Personal', authenticated: true }, { id: 'b', label: 'Work', authenticated: true }] : [] } };
  } };
  await render(React.createElement(SidebarUsage, { api, onTogglePin: () => pinned++, onAddProviders: () => added++ }));
  assert.equal(document.querySelector('.sidebar-usage-heading .session-panel-title').textContent, 'Providers');
  const buttons = document.querySelectorAll('.sidebar-usage-heading .session-panel-action');
  assert.equal(buttons.length, 2);
  assert.ok(document.querySelector('.sidebar-usage-heading.session-panel-header'), 'header shares the rail panel title grammar');
  assert.match(buttons[0].getAttribute('aria-label'), /Pin/);
  assert.equal(buttons[1].getAttribute('aria-label'), 'Connect provider');
  await act(async () => { buttons[0].click(); buttons[1].click(); });
  assert.equal(added, 1);
  assert.equal(pinned, 1);
  assert.equal(document.querySelectorAll('[data-account-id]').length, 0);
  assert.ok(document.querySelector('.sidebar-usage-meter'));
  await act(async () => document.querySelector('.provider-account-picker-trigger').click());
  assert.equal(document.querySelectorAll('[data-account-id]').length, 2);
  assert.equal(document.querySelector('[data-account-provider="anthropic-oauth"]'), null);
  assert.equal(document.querySelector('[data-provider-account-overlay] input'), null);
  assert.equal(document.querySelector('[data-provider-account-overlay] .settings-status'), null);
  assert.equal(document.querySelector('[data-provider-account-overlay] .provider-accounts-footer'), null);
  assert.equal(document.querySelector('.provider-account-picker-trigger').getAttribute('aria-expanded'), 'true');
});

test('settings show only removal for healthy accounts, reconnect for expired accounts and a header add action', async (t) => {
  const render = harness(t);
  const calls = [];
  const provider = 'openai-oauth';
  const api = { async invokeCapability() {
    return { value: { selectedId: 'a', auto: true,
      accounts: ['a', 'b'].map((id) => ({ id, label: id, authenticated: true, reauthRequired: id === 'b' })) } };
  } };
  await render(React.createElement(ProvidersPanel, {
    api, data: { providerSetup: { oauth: [{ id: provider, name: 'OpenAI OAuth', authenticated: true }], api: [] } },
    pending: '', run: async (...args) => { calls.push(args); return undefined; },
    confirm: (options) => void options.onConfirm(),
  }));
  const account = document.querySelector('[data-account-id="b"]');
  const buttons = [...account.querySelectorAll('.settings-resource-actions button')];
  assert.deepEqual(buttons.map((button) => button.textContent), ['Reconnect', 'Disconnect']);
  // The account in use offers removal only; a healthy standby adds "Use".
  assert.deepEqual([...document.querySelectorAll('[data-account-id="a"] .settings-resource-actions button')]
    .map((button) => button.textContent), ['Disconnect']);
  // Pills sit inline beside the name, inside the title row.
  assert.equal(document.querySelector('[data-account-id="a"] .provider-account-title .settings-status').textContent, 'In use');
  assert.equal(document.querySelector('[data-account-id="b"] .provider-account-title .settings-status').textContent, 'Reauth required');
  // In-use and reauth rows have no whole-row switch target; a healthy standby does.
  assert.equal(document.querySelector('[data-account-id="a"] .provider-account-select'), null);
  assert.equal(document.querySelector('[data-account-id="b"] .provider-account-select'), null);
  await act(async () => buttons[0].click());
  assert.deepEqual(calls[0][1], [provider, { accountId: 'b' }]);
  await act(async () => buttons[1].click());
  assert.deepEqual(calls.find((call) => call[0] === 'forgetProviderAuth')[1], [provider, 'b']);
  const connect = document.querySelector('.provider-accounts-heading button');
  await act(async () => connect.click());
  assert.deepEqual(calls.at(-1)[1], [provider, { addAccount: true }]);
  assert.equal(document.querySelector('[aria-expanded]'), null);
});

test('account names are edited inline and persisted through the account API', async (t) => {
  const render = harness(t);
  const changes = [];
  const pool = { selectedId: 'a', auto: true, accounts: [{ id: 'a', label: 'Personal', authenticated: true }] };
  const api = { async invokeCapability({ capability, args }) {
    if (capability === 'getUsageDashboard') return { value: { rows: [] } };
    if (capability === 'updateProviderAccounts') {
      changes.push(args[1]);
      pool.accounts[0].label = args[1].rename.label;
    }
    return { value: structuredClone(pool) };
  } };
  await render(React.createElement(ProviderAccountsList, { api, provider: 'openai-oauth' }));
  await act(async () => document.querySelector('.provider-account-name').click());
  const input = document.querySelector('input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'Work');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await act(async () => document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  assert.deepEqual(changes, [{ rename: { id: 'a', label: 'Work' } }]);
  assert.equal(document.querySelector('.provider-account-name').textContent, 'Work');
});
