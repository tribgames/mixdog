import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

// react-dom reads the DOM at load time (input-event support), so the window must exist first.
const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'HTMLInputElement', 'FormData', 'Event', 'MouseEvent', 'Node', 'Element'],
  actEnvironment: false,
});
test.after(restore);
const { createRoot } = await import('react-dom/client');
const { ProvidersPanel } = await import('./provider-panel.tsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ROSTERS = {
  'layout-full': {
    selectedId: 'a1',
    auto: true,
    accounts: [{ id: 'a1', label: 'Account 1', email: 'one@mixdog.test', authenticated: true }],
  },
  'layout-empty': { selectedId: null, auto: true, accounts: [] },
};
const SETUP = {
  oauth: [
    { id: 'layout-empty', name: 'Empty OAuth' },
    { id: 'layout-full', name: 'Full OAuth' },
  ],
  api: [
    { id: 'deepseek', name: 'DeepSeek', authenticated: false, url: 'https://platform.test/keys' },
    { id: 'gemini', name: 'Gemini', authenticated: false, url: 'https://platform.test/gemini' },
    { id: 'openrouter', name: 'OpenRouter', authenticated: true },
  ],
};

async function mountPanel(t, setup = SETUP) {
  window.mixdogDesktop = { getQuotaAutoResume: async () => true, setQuotaAutoResume: async (next) => next };
  const runs = [];
  let root = null;
  const api = {
    async invokeCapability({ capability, args }) {
      if (capability === 'getProviderAccounts') return { value: structuredClone(ROSTERS[args[0]]) };
      return { value: { rows: [] } };
    },
  };
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const unmount = async () => {
    if (!root) return;
    const current = root;
    root = null;
    await act(async () => current.unmount());
  };
  const mount = async () => {
    root = createRoot(document.querySelector('main'));
    await act(async () =>
      root.render(
        React.createElement(ProvidersPanel, {
          api,
          data: { providerSetup: setup, __loadedSections: ['providerSetup'] },
          pending: '',
          run: async (...args) => {
            runs.push(args);
            return undefined;
          },
          confirm: () => {},
        })
      )
    );
    await settle();
  };
  t.after(unmount);
  await mount();
  return { runs, settle, mount, unmount };
}
const click = (el) => act(async () => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
const buttonIn = (scope, label) => [...scope.querySelectorAll('button')].find((el) => el.textContent.trim() === label);

test('the page runs OAuth, API-key, custom providers and ends with the usage-limits group', async (t) => {
  await mountPanel(t);
  assert.deepEqual(
    [...document.querySelectorAll('section h3')].map((h) => h.textContent),
    ['OAuth providers', 'API-key providers', 'Custom providers', 'Usage limits']
  );
});

test('OAuth providers without an account share one compact card after the connected ones', async (t) => {
  await mountPanel(t);
  assert.ok(document.querySelector('[data-account-provider="layout-full"]'));
  assert.equal(document.querySelector('[data-account-provider="layout-empty"]'), null);
  assert.ok(!document.body.textContent.includes('No connected accounts.'));
  const section = document.querySelector('.settings-provider-cards');
  assert.equal(
    section.querySelector('.provider-accounts-sublabel').textContent,
    'Providers without a connected account'
  );
  const rows = [...section.querySelectorAll('.provider-accounts-empty-row')];
  assert.deepEqual(
    rows.map((row) => row.querySelector('b').textContent),
    ['Empty OAuth']
  );
  assert.ok(rows[0].querySelector('button[aria-label="Add account"]'));
  const children = [...section.children];
  assert.ok(
    children.indexOf(section.querySelector('[data-account-provider="layout-full"]').closest('.settings-group-body')) <
      children.indexOf(section.querySelector('.provider-accounts-sublabel'))
  );
});

test('an account without usage shows the note under its email', async (t) => {
  await mountPanel(t);
  const row = document.querySelector('[data-account-id="a1"]');
  assert.deepEqual(
    [...row.querySelectorAll('.provider-account-copy .provider-account-meta')].map((el) => el.textContent),
    ['one@mixdog.test', 'Usage not checked yet']
  );
  assert.equal(row.querySelector('.provider-account-usage'), null);
});

test('an API-key row reveals its form after Connect, one row at a time, and focus follows', async (t) => {
  const { runs } = await mountPanel(t);
  const api = [...document.querySelectorAll('section')].find(
    (s) => s.querySelector('h3')?.textContent === 'API-key providers'
  );
  const rowOf = (name) => [...api.querySelectorAll('.settings-resource')].find((r) => r.textContent.includes(name));
  assert.equal(api.querySelector('input[type="password"]'), null);
  assert.equal(buttonIn(api, 'Get API key ↗'), undefined);
  const deepseek = rowOf('DeepSeek');
  const gemini = rowOf('Gemini');

  await click(buttonIn(deepseek, 'Connect'));
  assert.ok(deepseek.querySelector('input[type="password"]'));
  assert.ok(buttonIn(deepseek, 'Save'));
  assert.ok(buttonIn(deepseek, 'Get API key ↗'));
  assert.equal(buttonIn(deepseek, 'Connect'), undefined);
  assert.equal(document.activeElement, deepseek.querySelector('input[type="password"]'));

  // Opening another row closes the first; focus lands in the new key input.
  await click(buttonIn(gemini, 'Connect'));
  assert.equal(deepseek.querySelector('input[type="password"]'), null);
  assert.ok(buttonIn(deepseek, 'Connect'));
  assert.equal(api.querySelectorAll('input[type="password"]').length, 1);
  assert.equal(document.activeElement, gemini.querySelector('input[type="password"]'));

  // Cancel closes the form and returns focus to that row's Connect button.
  await click(buttonIn(gemini, 'Cancel'));
  assert.equal(api.querySelector('input[type="password"]'), null);
  assert.equal(document.activeElement, buttonIn(gemini, 'Connect'));

  // Submitting saves the key for that row only, closes the form and restores focus.
  await click(buttonIn(deepseek, 'Connect'));
  const input = deepseek.querySelector('input[type="password"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'sk-test');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => input.form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  const saves = runs.filter(([capability]) => capability === 'saveProviderApiKey');
  assert.deepEqual(saves, [['saveProviderApiKey', ['deepseek', 'sk-test'], 'provider-key-deepseek']]);
  assert.equal(api.querySelector('input[type="password"]'), null);
  assert.equal(document.activeElement, buttonIn(deepseek, 'Connect'));
});

test('a provider moves between the groups when its accounts change, also across a remount', async (t) => {
  ROSTERS['layout-flip-a'] = {
    selectedId: 'x1',
    auto: true,
    accounts: [{ id: 'x1', label: 'X', authenticated: true }],
  };
  ROSTERS['layout-flip-b'] = { selectedId: null, auto: true, accounts: [] };
  const flipSetup = {
    oauth: [
      { id: 'layout-flip-a', name: 'Flip A' },
      { id: 'layout-flip-b', name: 'Flip B' },
    ],
    api: [],
  };
  const { settle, mount, unmount } = await mountPanel(t, flipSetup);
  const emptyNames = () => [...document.querySelectorAll('.provider-accounts-empty-row b')].map((el) => el.textContent);
  const connected = (id) => document.querySelector(`[data-account-provider="${id}"]`) !== null;
  assert.deepEqual(emptyNames(), ['Flip B']);
  assert.ok(connected('layout-flip-a') && !connected('layout-flip-b'));

  // Live: A loses its account, B gains one.
  ROSTERS['layout-flip-a'] = { selectedId: null, auto: true, accounts: [] };
  ROSTERS['layout-flip-b'] = {
    selectedId: 'y1',
    auto: true,
    accounts: [{ id: 'y1', label: 'Y', authenticated: true }],
  };
  await act(async () => window.dispatchEvent(new window.Event('mixdog:provider-accounts-changed')));
  await settle();
  assert.deepEqual(emptyNames(), ['Flip A']);
  assert.ok(connected('layout-flip-b') && !connected('layout-flip-a'));

  // While another category is open (panel unmounted), A gets an account again.
  await unmount();
  ROSTERS['layout-flip-a'] = {
    selectedId: 'x2',
    auto: true,
    accounts: [{ id: 'x2', label: 'X2', authenticated: true }],
  };
  await mount();
  assert.ok(connected('layout-flip-a'), 'a remount revalidates the cached empty roster');
  assert.deepEqual(emptyNames(), []);
});
test('the custom provider add action sits in the header and an empty list says so', async (t) => {
  await mountPanel(t);
  const section = document.querySelector('.settings-custom-providers');
  const add = buttonIn(section, 'Add custom provider');
  assert.equal(add.closest('.settings-group-head').querySelector('h3').textContent, 'Custom providers');
  assert.ok(add.querySelector('svg'));
  assert.equal(section.querySelector('.settings-empty').textContent, 'No custom providers yet.');
});
