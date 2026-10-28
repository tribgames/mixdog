import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { ProviderAccountsList } from './ProviderAccountsList.tsx';
import { OAuthControl, ProvidersPanel } from './settings/provider-panel.tsx';
import { SidebarUsage, usagePinEntries } from './SidebarUsage.tsx';
import { getUsageDashboardSnapshot, publishUsageDashboard } from './usage-dashboard-store.ts';
import { useUsageAccountPools } from './usage-account-pools.ts';
import { filterConfiguredModels } from './model-catalog.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test('SSH provider settings display PC availability without account or credential controls', async (t) => {
  const render = harness(t);
  const show = (setup) =>
    render(
      React.createElement(ProvidersPanel, {
        api: {
          invokeCapability() {
            assert.fail('must not read the server account roster');
          },
        },
        pending: '',
        run: async () => {},
        confirm: () => assert.fail('no remote credential mutations'),
        data: { providerSetup: setup },
      })
    );
  const setup = {
    managedByClient: true,
    oauth: [
      { id: 'openai-oauth', name: 'OpenAI OAuth', authenticated: true, usable: true, status: 'Connected' },
      { id: 'cursor-oauth', name: 'Cursor OAuth', authenticated: true, usable: true, status: 'Connected' },
    ],
    api: [{ id: 'openai', name: 'OpenAI API', authenticated: false, status: 'Not connected' }],
  };
  await show(setup);
  const models = [
    { provider: 'openai-oauth', model: 'gpt-test' },
    { provider: 'cursor-oauth', model: 'auto' },
    { provider: 'openai', model: 'gpt-test' },
  ];
  assert.deepEqual(filterConfiguredModels(models, setup), models.slice(0, 2));
  assert.deepEqual(
    [...document.querySelectorAll('.settings-status')].map((el) => el.textContent),
    ['Connected', 'Connected', 'Not connected']
  );
  assert.match(document.querySelector('main').textContent, /Manage sign-ins and accounts in the local window/);
  assert.equal(document.querySelector('button, input[type="password"], form, .provider-accounts-list'), null);
  await show({ ...setup, oauth: [{ ...setup.oauth[0], authenticated: false, status: 'Not connected' }] });
  assert.equal(document.querySelector('.settings-status').textContent, 'Not connected');
  await show({ managedByClient: true, unavailable: true, oauth: [], api: [], local: [] });
  assert.deepEqual(filterConfiguredModels(models, { managedByClient: true, oauth: [], api: [], local: [] }), []);
  assert.match(document.querySelector('main').textContent, /Connect the desktop to view its providers/);
  assert.equal(document.querySelector('.settings-status'), null);
});

function harness(t) {
  const { dom } = installTestDom(null, {
    html: '<!doctype html><html><body><main></main></body></html>',
    jsdom: { url: 'https://mixdog.test/' },
    expose: ['HTMLElement'],
    actEnvironment: false,
  });
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  const root = createRoot(document.querySelector('main'));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  return async (element) => act(async () => root.render(element));
}

test('an account reserves its remembered usage rows and repaints its last meters while the read is pending', async (t) => {
  const render = harness(t);
  const windows = [
    { label: '5H', usedPct: 10 },
    { label: '7D', usedPct: 20 },
    { label: '7D Opus', usedPct: 30 },
  ];
  let withUsage = true;
  const api = {
    async invokeCapability() {
      return {
        value: {
          selectedId: 'a',
          auto: true,
          accounts: [{ id: 'reserve-a', label: 'a', authenticated: true, usage: withUsage ? { windows } : null }],
        },
      };
    },
  };
  await render(React.createElement(ProviderAccountsList, { api, provider: 'reserve-oauth' }));
  assert.equal(document.querySelectorAll('.provider-account-usage > span').length, 3);
  withUsage = false;
  await render(React.createElement(ProviderAccountsList, { api, provider: 'reserve-oauth-2' }));
  const usage = document.querySelector('.provider-account-usage');
  assert.equal(usage.style.getPropertyValue('--usage-rows'), '3');
  assert.equal(usage.querySelectorAll(':scope > span').length, 3);
});

for (const listOnly of [true, false]) {
  test(`usage updates synchronize automatic account selection in ${listOnly ? 'popup' : 'settings'}`, async (t) => {
    const render = harness(t);
    let selectedId = 'a';
    const api = {
      async invokeCapability({ capability }) {
        assert.equal(capability, 'getProviderAccounts');
        return {
          value: {
            selectedId,
            auto: true,
            accounts: ['a', 'b'].map((id) => ({ id, label: id, authenticated: true })),
          },
        };
      },
    };
    await render(React.createElement(ProviderAccountsList, { api, provider: 'anthropic-oauth', listOnly }));
    assert.equal(document.querySelector('.provider-accounts-list .is-selected').dataset.accountId, 'a');
    selectedId = 'b';
    await act(async () => {
      publishUsageDashboard({
        rows: [{ id: 'anthropic-oauth', authenticated: true, windows: [{ label: '7D Fable', usedPct: 8 }] }],
      });
    });
    assert.equal(document.querySelector('.provider-accounts-list .is-selected').dataset.accountId, 'b');
  });
}

test('inline accounts support click selection, drag-and-drop priority, keyboard reorder and auto toggle', async (t) => {
  const render = harness(t);
  let pool = {
    selectedId: 'a',
    auto: true,
    accounts: ['a', 'b', 'c'].map((id) => ({
      id,
      label: id,
      authenticated: true,
      usage: { windows: [{ usedPct: 12 }] },
    })),
  };
  const writes = [];
  const api = {
    async invokeCapability({ capability, args }) {
      if (capability === 'getUsageDashboard') return { value: { rows: [] } };
      if (capability === 'updateProviderAccounts') {
        writes.push(args[1]);
        if (args[1].order)
          pool = { ...pool, accounts: args[1].order.map((id) => pool.accounts.find((row) => row.id === id)) };
        else pool = { ...pool, ...args[1] };
      }
      return { value: structuredClone(pool) };
    },
  };
  await render(React.createElement(ProviderAccountsList, { api, provider: 'openai-oauth', listOnly: true }));
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.querySelectorAll('.provider-accounts-list li').length, 3);
  await act(async () => document.querySelector('[data-account-id="b"] .provider-account-choice').click());
  assert.equal(pool.selectedId, 'b');
  assert.equal(
    document.querySelector('[data-account-id="b"] .provider-account-choice').getAttribute('aria-pressed'),
    'true'
  );
  // Pointer reorder against a stubbed 32px row grid: grab row c (y 64..96),
  // lift it past the threshold, drag its center over slot 0, release.
  const ROW = 32;
  const rect = (top, height) => ({
    x: 0,
    y: top,
    top,
    left: 0,
    bottom: top + height,
    right: 260,
    width: 260,
    height,
    toJSON() {
      return {};
    },
  });
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
  assert.match(
    document.querySelector('[data-account-id="a"]').style.transform,
    /translateY\(32px\)/,
    'displaced row shifts down'
  );
  assert.equal(writes.length, 1, 'no order write until release');
  await act(async () => grip.dispatchEvent(pointer('pointerup', 10)));
  assert.deepEqual(
    pool.accounts.map((row) => row.id),
    ['c', 'a', 'b']
  );
  assert.equal(document.querySelector('.is-lifted') === null, true);
  assert.equal(pool.selectedId, 'b', 'reordering does not unexpectedly change the active account');
  await act(async () =>
    document
      .querySelector('[data-account-id="b"] .provider-account-grip')
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }))
  );
  assert.deepEqual(
    pool.accounts.map((row) => row.id),
    ['c', 'b', 'a']
  );
  assert.equal(document.querySelector('.provider-account-auto'), null);
  assert.equal(writes.length, 3);
});

test('a rejected reorder keeps the saved order and displays the failure', async (t) => {
  const render = harness(t);
  const api = {
    async invokeCapability({ capability }) {
      if (capability === 'updateProviderAccounts') throw new Error('Save failed');
      return {
        value: {
          selectedId: 'a',
          auto: true,
          accounts: ['a', 'b'].map((id) => ({ id, label: id, authenticated: true })),
        },
      };
    },
  };
  await render(React.createElement(ProviderAccountsList, { api, provider: 'openai-oauth' }));
  await act(async () =>
    document
      .querySelector('[data-account-id="b"] .provider-account-grip')
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }))
  );
  assert.deepEqual(
    [...document.querySelectorAll('[data-account-id]')].map((row) => row.dataset.accountId),
    ['a', 'b']
  );
  assert.match(document.querySelector('[role="alert"]').textContent, /Save failed/);
});

test('add account starts a separate login instead of reconnecting the existing credential', async (t) => {
  const render = harness(t);
  const calls = [];
  await render(
    React.createElement(OAuthControl, {
      api: {},
      provider: { id: 'openai-oauth', authenticated: true },
      disabled: false,
      addAccount: true,
      run: async (...args) => {
        calls.push(args);
        return undefined;
      },
    })
  );
  await act(async () => document.querySelector('button').click());
  assert.deepEqual(calls[0][1], ['openai-oauth', { addAccount: true }]);
  assert.equal(document.querySelector('button').getAttribute('aria-label'), 'Add account');
  assert.equal(document.querySelector('input'), null);
});

test('provider popup preserves meters and opens only an account list beside the provider', async (t) => {
  const render = harness(t);
  publishUsageDashboard({
    rows: [{ id: 'openai-oauth', group: 'oauth', authenticated: true, windows: [{ label: '7D', usedPct: 39 }] }],
  });
  let added = 0;
  let pinned = 0;
  const api = {
    async invokeCapability({ capability, args }) {
      if (capability === 'getUsageDashboard')
        return { value: { rows: [{ id: 'openai-oauth', group: 'oauth', authenticated: true }] } };
      return {
        value: {
          selectedId: 'a',
          auto: true,
          accounts:
            args[0] === 'openai-oauth'
              ? [
                  { id: 'a', label: 'Personal', authenticated: true },
                  { id: 'b', label: 'Work', authenticated: true },
                ]
              : [],
        },
      };
    },
  };
  await render(React.createElement(SidebarUsage, { api, onTogglePin: () => pinned++, onAddProviders: () => added++ }));
  assert.equal(document.querySelector('.sidebar-usage-heading .session-panel-title').textContent, 'Usage');
  const buttons = document.querySelectorAll('.sidebar-usage-heading .session-panel-action');
  assert.equal(buttons.length, 2);
  assert.ok(
    document.querySelector('.sidebar-usage-heading.session-panel-header'),
    'header shares the rail panel title grammar'
  );
  // The rail pin lives in the heading's usage menu.
  assert.equal(buttons[0].getAttribute('aria-label'), 'Usage menu');
  assert.equal(buttons[1].getAttribute('aria-label'), 'Connect provider');
  await act(async () => buttons[0].click());
  await act(async () => document.querySelector('.usage-menu [role="menuitemcheckbox"]').click());
  await act(async () => buttons[1].click());
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

test('switching accounts repaints that provider at once and confirms it with a scoped refresh', async (t) => {
  const render = harness(t);
  publishUsageDashboard({
    rows: [{ id: 'openai-oauth', group: 'oauth', authenticated: true, windows: [{ label: '7D', usedPct: 80 }] }],
  });
  const pool = {
    selectedId: 'a',
    auto: true,
    accounts: [
      { id: 'a', label: 'Personal', authenticated: true, usage: { windows: [{ label: '7D', usedPct: 80 }] } },
      { id: 'b', label: 'Work', authenticated: true, usage: { windows: [{ label: '7D', usedPct: 12 }] } },
    ],
  };
  const dashboardArgs = [];
  const api = {
    async invokeCapability({ capability, args }) {
      if (capability === 'getUsageDashboard') {
        dashboardArgs.push(args[0]);
        // The confirming request stays outstanding: the meters must already show
        // the account the user just picked.
        return await new Promise(() => {});
      }
      if (capability === 'updateProviderAccounts') pool.selectedId = args[1].selectedId;
      return { value: structuredClone(pool) };
    },
  };
  await render(React.createElement(SidebarUsage, { api }));
  assert.equal(document.querySelector('.sidebar-usage-meter b').textContent, '80%');
  await act(async () => document.querySelector('.provider-account-picker-trigger').click());
  await act(async () => document.querySelector('[data-account-id="b"] .provider-account-choice').click());
  assert.equal(pool.selectedId, 'b');
  assert.equal(document.querySelector('.sidebar-usage-meter b').textContent, '12%');
  assert.equal(dashboardArgs.length, 1);
  assert.deepEqual(dashboardArgs[0].refreshProviders, ['openai-oauth']);
  assert.equal(dashboardArgs[0].refresh, true);
});

test('switching to an account without usage clears old meters and reset credits until its live result arrives', async (t) => {
  const render = harness(t);
  const other = { id: 'anthropic-oauth', group: 'oauth', authenticated: true, windows: [{ label: '7D', usedPct: 3 }] };
  publishUsageDashboard({
    rows: [
      {
        id: 'openai-oauth',
        group: 'oauth',
        authenticated: true,
        windows: [{ label: '7D', usedPct: 39 }],
        resetCredits: { availableCount: 1, offerRevision: 'account-a:offer', availableCredits: [{ id: 'old-credit' }] },
      },
      other,
    ],
  });
  const pool = {
    selectedId: 'a',
    auto: true,
    accounts: [
      { id: 'a', label: 'Personal', authenticated: true },
      { id: 'b', label: 'Work', authenticated: true },
    ],
  };
  const dashboardArgs = [];
  let resolveUsage;
  const api = {
    async invokeCapability({ capability, args }) {
      if (capability === 'getUsageDashboard') {
        dashboardArgs.push(args[0]);
        return await new Promise((resolve) => {
          resolveUsage = resolve;
        });
      }
      if (capability === 'updateProviderAccounts') pool.selectedId = args[1].selectedId;
      return { value: structuredClone(pool) };
    },
  };
  await render(React.createElement(SidebarUsage, { api }));
  assert.equal(document.querySelector('[data-usage-provider="codex"] .sidebar-usage-meter b').textContent, '39%');
  assert.ok(document.querySelector('[data-usage-provider="codex"] .sidebar-usage-reset-credit'));
  await act(async () =>
    document.querySelector('[data-usage-provider="codex"] .provider-account-picker-trigger').click()
  );
  await act(async () => document.querySelector('[data-account-id="b"] .provider-account-choice').click());
  const codex = () => document.querySelector('[data-usage-provider="codex"]');
  assert.equal(codex().querySelector('.sidebar-usage-meter b'), null);
  assert.match(codex().querySelector('.sidebar-usage-meter-empty').textContent, /Loading usage/);
  assert.equal(codex().getAttribute('aria-busy'), 'true');
  assert.equal(document.querySelector('.sidebar-usage-reset-credit'), null);
  assert.equal(document.querySelector('[data-usage-provider="claude"] .sidebar-usage-meter b').textContent, '3%');
  assert.deepEqual(
    usagePinEntries(getUsageDashboardSnapshot().dashboard).map((row) => [row.key, row.percent]),
    [['claude', 3]]
  );
  assert.deepEqual(dashboardArgs, [{ refresh: true, refreshSetup: false, refreshProviders: ['openai-oauth'] }]);

  await act(async () =>
    resolveUsage({
      value: {
        rows: [
          { id: 'openai-oauth', group: 'oauth', authenticated: true, windows: [{ label: '7D', usedPct: 12 }] },
          other,
        ],
      },
    })
  );
  assert.equal(codex().querySelector('.sidebar-usage-meter b').textContent, '12%');
  assert.equal(codex().querySelector('.sidebar-usage-meter-empty'), null);
  assert.equal(codex().getAttribute('aria-busy'), 'false');
  assert.equal(document.querySelector('.sidebar-usage-reset-credit'), null);
  assert.deepEqual(
    usagePinEntries(getUsageDashboardSnapshot().dashboard).map((row) => [row.key, row.percent]),
    [
      ['codex', 12],
      ['claude', 3],
    ]
  );
});

test('settings omit the separate OpenCode Go card when the provider is unavailable', async (t) => {
  const render = harness(t);
  await render(
    React.createElement(ProvidersPanel, {
      api: {},
      pending: '',
      run: async () => {},
      confirm: () => {},
      data: { providerSetup: { oauth: [], api: [{ id: 'openai-api', name: 'OpenAI API' }] } },
    })
  );
  const sections = [...document.querySelectorAll('main > section')];
  assert.deepEqual(
    sections.map((section) => section.querySelector('h3').textContent),
    ['OAuth providers', 'API-key providers', 'Custom providers']
  );
  assert.doesNotMatch(document.querySelector('main').textContent, /OpenCode Go|Usage sign-in/);
});

test('settings expose Vertex AI service-account file, location and project override controls', async (t) => {
  const render = harness(t);
  await render(
    React.createElement(ProvidersPanel, {
      api: {},
      pending: '',
      run: async () => {},
      confirm: () => {},
      data: {
        providerSetup: {
          oauth: [],
          api: [
            {
              id: 'vertex-ai',
              name: 'Vertex AI',
              authenticated: false,
              location: 'us-east5',
              projectId: 'override-project',
            },
          ],
        },
      },
    })
  );
  assert.equal(document.querySelector('input[aria-label="Vertex AI service-account JSON key"]'), null);
  const connect = document.querySelector('[data-provider-connect="vertex-ai"]');
  await act(async () => connect.click());
  const file = document.querySelector('input[aria-label="Vertex AI service-account JSON key"]');
  assert.equal(document.activeElement, file);
  assert.equal(file?.getAttribute('type'), 'file');
  assert.equal(file?.getAttribute('accept'), 'application/json,.json');
  assert.equal(document.querySelector('input[aria-label="Vertex AI location"]')?.value, 'us-east5');
  assert.equal(document.querySelector('input[aria-label="Vertex AI project ID override"]')?.value, 'override-project');
  assert.equal(document.querySelector('input[type="password"]'), null);
});

test('settings show only removal for healthy accounts, reconnect for expired accounts and a header add action', async (t) => {
  const render = harness(t);
  const calls = [];
  const provider = 'openai-oauth';
  const api = {
    async invokeCapability() {
      return {
        value: {
          selectedId: 'a',
          auto: true,
          accounts: ['a', 'b'].map((id) => ({ id, label: id, authenticated: true, reauthRequired: id === 'b' })),
        },
      };
    },
  };
  await render(
    React.createElement(ProvidersPanel, {
      api,
      data: { providerSetup: { oauth: [{ id: provider, name: 'OpenAI OAuth', authenticated: true }], api: [] } },
      pending: '',
      run: async (...args) => {
        calls.push(args);
        return undefined;
      },
      confirm: (options) => void options.onConfirm(),
    })
  );
  const account = document.querySelector('[data-account-id="b"]');
  const buttons = [...account.querySelectorAll('.settings-resource-actions button')];
  assert.deepEqual(
    buttons.map((button) => button.textContent),
    ['Reconnect', 'Disconnect']
  );
  // The account in use offers removal only; a healthy standby adds "Use".
  assert.deepEqual(
    [...document.querySelectorAll('[data-account-id="a"] .settings-resource-actions button')].map(
      (button) => button.textContent
    ),
    ['Disconnect']
  );
  // Pills sit inline beside the name, inside the title row.
  assert.equal(
    document.querySelector('[data-account-id="a"] .provider-account-title .settings-status').textContent,
    'In use'
  );
  assert.equal(
    document.querySelector('[data-account-id="b"] .provider-account-title .settings-status').textContent,
    'Reauth required'
  );
  // In-use and reauth rows have no whole-row switch target; a healthy standby does.
  assert.equal(document.querySelector('[data-account-id="a"] .provider-account-select'), null);
  assert.equal(document.querySelector('[data-account-id="b"] .provider-account-select'), null);
  await act(async () => buttons[0].click());
  assert.deepEqual(calls[0][1], [provider, { accountId: 'b' }]);
  await act(async () => buttons[1].click());
  assert.deepEqual(calls.find((call) => call[0] === 'forgetProviderAuth')[1], [provider, 'b']);
  const connect = document.querySelector('.provider-accounts-heading button[aria-label="Add account"]');
  await act(async () => connect.click());
  assert.deepEqual(calls.at(-1)[1], [provider, { addAccount: true }]);
  assert.equal(document.querySelector('[aria-expanded="true"]'), null);
});

test('account rows show every usage window, the limit holding them and the switching policy', async (t) => {
  const render = harness(t);
  const now = Date.now();
  const at = (hours, minutes = 0) => now + hours * 3_600_000 + minutes * 60_000 - 1_000;
  let pool = {
    selectedId: 'codex',
    auto: true,
    accounts: [
      {
        id: 'codex',
        label: 'Work',
        authenticated: true,
        usage: { checkedAt: now - 120_000, windows: [{ label: '7D', usedPct: 61, resetAt: at(74) }] },
      },
      {
        id: 'claude',
        label: 'Personal',
        authenticated: true,
        limit: { scope: 'model', families: ['Fable'] },
        usage: {
          checkedAt: now,
          windows: [
            { label: '5H', usedPct: 92, resetAt: at(1, 12) },
            { label: '7D', usedPct: 75, resetAt: at(50) },
            { label: '7D Fable', usedPct: 100, resetAt: at(50) },
          ],
        },
      },
      { id: 'fresh', label: 'Spare', authenticated: true },
      { id: 'expired', label: 'Old', authenticated: true, reauthRequired: true },
      {
        id: 'spent',
        label: 'Spent',
        authenticated: true,
        limit: { scope: 'account' },
        usage: { checkedAt: now, windows: [{ label: '5H', usedPct: 100, resetAt: at(2) }] },
      },
    ],
  };
  const writes = [];
  const api = {
    async invokeCapability({ capability, args }) {
      if (capability === 'getUsageDashboard') return { value: { rows: [] } };
      if (capability === 'updateProviderAccounts') {
        writes.push(args[1]);
        if (args[1].policy) pool = { ...pool, policy: args[1].policy, auto: args[1].policy !== 'manual' };
      }
      return { value: structuredClone(pool) };
    },
  };
  await render(React.createElement(ProviderAccountsList, { api, provider: 'anthropic-oauth', title: 'Anthropic' }));
  const row = (id) => document.querySelector(`[data-account-id="${id}"]`);
  const meters = (id) =>
    [...row(id).querySelectorAll('.provider-account-usage > span')].map((line) => [
      line.className,
      line.querySelector('small').textContent,
      line.querySelector('em').textContent,
      line.querySelector('b').textContent,
    ]);
  assert.deepEqual(meters('codex'), [['', '7D', 'Resets in 3d 2h', '61%']]);
  assert.deepEqual(meters('claude'), [
    ['tone-danger', '5H', 'Resets in 1h 12m', '92%'],
    ['tone-warning', '7D', 'Resets in 2d 2h', '75%'],
    ['tone-danger', '7D FABLE', 'Resets in 2d 2h', '100%'],
  ]);
  assert.equal(row('claude').querySelector('.provider-account-usage i > i').style.width, '92%');
  assert.deepEqual(meters('fresh'), []);
  // The empty note is secondary text under the account name, not a usage block.
  assert.equal(row('fresh').querySelector('.provider-account-usage'), null);
  assert.equal(row('fresh').querySelector('.provider-account-meta').textContent, 'Usage not checked yet');
  assert.equal(row('expired').querySelector('.provider-account-meta').textContent, 'Shown after signing in again');
  assert.equal(row('expired').classList.contains('is-dim'), true);
  assert.equal(row('codex').classList.contains('is-dim'), false);
  const pills = (id) => [...row(id).querySelectorAll('.settings-status')].map((pill) => pill.textContent);
  assert.deepEqual(pills('codex'), ['In use']);
  assert.deepEqual(pills('claude'), ['Fable limit']);
  assert.deepEqual(pills('spent'), ['Limit reached']);
  assert.deepEqual(pills('expired'), ['Reauth required']);
  assert.ok(row('spent').querySelector('.provider-account-use'), 'a spent account can still be picked');
  // The usage block sits between the identity and the actions.
  assert.deepEqual(
    [...row('codex').querySelector('.provider-account-row').children].map((cell) => cell.className),
    ['provider-account-grip', 'provider-account-identity', 'provider-account-usage', 'settings-resource-actions']
  );

  const policy = () => document.querySelector('.provider-accounts-policy');
  assert.equal(policy().textContent, 'SwitchSwitch at limit');
  assert.equal(document.querySelector('[role="menu"]'), null);
  await act(async () => policy().click());
  const menu = document.querySelector('[role="menu"]');
  assert.deepEqual(
    [...menu.querySelectorAll('[role="menuitemradio"]')].map((item) => [
      item.dataset.accountPolicy,
      item.getAttribute('aria-checked'),
    ]),
    [
      ['manual', 'false'],
      ['limit', 'true'],
      ['headroom', 'false'],
    ]
  );
  assert.match(menu.querySelector('[role="menuitem"]').textContent, /^Refresh usage/);
  // A streaming turn pins the transcript on every token: a programmatic scroll
  // elsewhere must not close the open menu.
  await act(async () => document.body.dispatchEvent(new window.Event('scroll')));
  assert.ok(document.querySelector('[role="menu"]'), 'a programmatic scroll closed the policy menu');
  await act(async () => menu.querySelector('[data-account-policy="headroom"]').click());
  assert.deepEqual(writes.at(-1), { policy: 'headroom' });
  assert.equal(document.querySelector('[role="menu"]'), null);
  assert.equal(policy().textContent, 'SwitchMost headroom first');

  await act(async () => document.querySelector('.provider-accounts-refresh').click());
  assert.deepEqual(writes.at(-1), { refreshUsage: true });
  assert.equal(writes.length, 2);
  assert.equal(document.querySelector('[role="alert"]'), null);
});

test('refreshing usage re-measures through the dashboard; a single account keeps a standalone refresh', async (t) => {
  const render = harness(t);
  const dashboardArgs = [];
  const pool = { selectedId: 'a', auto: true, accounts: [{ id: 'a', label: 'a', authenticated: true }] };
  const api = {
    async invokeCapability({ capability, args }) {
      if (capability === 'getUsageDashboard') {
        dashboardArgs.push(args[0]);
        return { value: { rows: [] } };
      }
      return { value: structuredClone(pool) };
    },
  };
  await render(React.createElement(ProviderAccountsList, { api, provider: 'openai-oauth', title: 'OpenAI' }));
  const button = document.querySelector('.provider-accounts-refresh');
  assert.ok(button, 'one account has a refresh action');
  assert.equal(button.classList.contains('is-in-menu'), false, 'not hidden by the narrow-card rule');
  dashboardArgs.length = 0;
  await act(async () => button.click());
  assert.deepEqual(dashboardArgs, [{ refresh: true, refreshSetup: false, refreshProviders: ['openai-oauth'] }]);
});

test('refreshing usage also refreshes the rosters the sidebar and rail show under Expand all accounts', async (t) => {
  const render = harness(t);
  let measured = false;
  const pool = () => ({
    selectedId: 'a',
    auto: true,
    accounts: [
      { id: 'a', label: 'a', authenticated: true },
      { id: 'b', label: 'b', authenticated: true, usage: { windows: [{ label: '7D', usedPct: measured ? 70 : 10 }] } },
    ],
  });
  const api = {
    async invokeCapability({ capability, args }) {
      if (capability === 'getUsageDashboard') return { value: { rows: [] } };
      if (capability === 'updateProviderAccounts' && args[1].refreshUsage) measured = true;
      return { value: pool() };
    },
  };
  function Sidebar() {
    const accounts = useUsageAccountPools(api, ['openai-oauth'], true).get('openai-oauth')?.accounts ?? [];
    return React.createElement('output', { 'data-sidebar': '' }, accounts[1]?.windows[0]?.usedPct ?? '');
  }
  await render(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(Sidebar),
      React.createElement(ProviderAccountsList, { api, provider: 'openai-oauth', title: 'OpenAI' })
    )
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(document.querySelector('[data-sidebar]').textContent, '10');
  await act(async () => document.querySelector('.provider-accounts-refresh').click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(document.querySelector('[data-sidebar]').textContent, '70');
});

test('a roster saved before switching policies shows auto off as Manual', async (t) => {
  const render = harness(t);
  const api = {
    async invokeCapability() {
      return {
        value: {
          selectedId: 'a',
          auto: false,
          accounts: ['a', 'b'].map((id) => ({ id, label: id, authenticated: true })),
        },
      };
    },
  };
  await render(React.createElement(ProviderAccountsList, { api, provider: 'openai-oauth', title: 'OpenAI' }));
  assert.equal(document.querySelector('.provider-accounts-policy').textContent, 'SwitchManual');
});

test('account names are edited inline and persisted through the account API', async (t) => {
  const render = harness(t);
  const changes = [];
  const pool = { selectedId: 'a', auto: true, accounts: [{ id: 'a', label: 'Personal', authenticated: true }] };
  const api = {
    async invokeCapability({ capability, args }) {
      if (capability === 'getUsageDashboard') return { value: { rows: [] } };
      if (capability === 'updateProviderAccounts') {
        changes.push(args[1]);
        pool.accounts[0].label = args[1].rename.label;
      }
      return { value: structuredClone(pool) };
    },
  };
  await render(React.createElement(ProviderAccountsList, { api, provider: 'openai-oauth' }));
  await act(async () => document.querySelector('.provider-account-name').click());
  const input = document.querySelector('input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'Work');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await act(async () =>
    document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  );
  assert.deepEqual(changes, [{ rename: { id: 'a', label: 'Work' } }]);
  assert.equal(document.querySelector('.provider-account-name').textContent, 'Work');
});

test('credit line renders only with credits, formats Codex count vs Claude USD, and the switch persists', async (t) => {
  const render = harness(t);
  const soon = Date.now() + 2 * 24 * 3_600_000;
  publishUsageDashboard({
    rows: [
      {
        id: 'openai-oauth',
        group: 'oauth',
        authenticated: true,
        windows: [{ label: '5H', usedPct: 100 }],
        credits: { unit: 'credits', balance: 62500 },
        useCredits: false,
        resetCredits: {
          availableCount: 1,
          offerRevision: 'o',
          availableCredits: [{ id: 'c1', expiresAt: soon }],
        },
      },
      {
        id: 'anthropic-oauth',
        group: 'oauth',
        authenticated: true,
        windows: [{ label: '7D', usedPct: 3 }],
      },
    ],
  });
  const calls = [];
  const api = {
    async invokeCapability({ capability, args }) {
      calls.push([capability, args]);
      return { value: {} };
    },
  };
  await render(React.createElement(SidebarUsage, { api }));
  const codex = () => document.querySelector('[data-usage-provider="codex"]');
  assert.equal(codex().querySelector('.sidebar-usage-credit .sidebar-usage-credit-value > b').textContent, '62,500');
  assert.equal(document.querySelector('[data-usage-provider="claude"] .sidebar-usage-credit'), null);
  const toggle = codex().querySelector('[role="switch"]');
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  await act(async () => toggle.click());
  assert.ok(
    calls.some(([c, a]) => c === 'updateProviderAccounts' && a[0] === 'openai-oauth' && a[1].useCredits === true)
  );
  await act(async () => document.querySelector('.sidebar-usage-reset-info').click());
  const items = [...document.querySelectorAll('.sidebar-usage-reset-popover li')];
  assert.equal(items.length, 1);
  assert.match(items[0].textContent, /Reset credit 1/);
  assert.ok(items[0].querySelector('small.is-soon'));
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
  assert.equal(document.querySelector('.sidebar-usage-reset-popover'), null);

  publishUsageDashboard({
    rows: [
      {
        id: 'anthropic-oauth',
        group: 'oauth',
        authenticated: true,
        windows: [{ label: '7D', usedPct: 3 }],
        credits: { unit: 'usd', balance: 25, monthlyLimit: 10 },
        useCredits: true,
      },
    ],
  });
  await act(async () => {});
  const line = document.querySelector('[data-usage-provider="claude"] .sidebar-usage-credit');
  assert.equal(line.querySelector('b').textContent, '$25.00');
  assert.match(line.textContent, /Monthly limit \$10/);
  assert.equal(line.querySelector('[role="switch"]').getAttribute('aria-checked'), 'true');
});

test('model filtering accepts every advertised provider kind and removes disabled entries', () => {
  const groups = {
    api: [
      'openai',
      'anthropic',
      'gemini',
      'deepseek',
      'xai',
      'opencode-go',
      'openrouter',
      'custom-00000000-0000-4000-8000-000000000001',
    ],
    oauth: [
      'openai-oauth',
      'anthropic-oauth',
      'grok-oauth',
      'muse-code-oauth',
      'command-code-oauth',
      'mimo-oauth',
      'cursor-oauth',
      'antigravity-oauth',
    ],
    local: ['mixdog-local'],
  };
  const models = Object.values(groups)
    .flat()
    .map((provider) => ({ provider, model: 'test-model' }));
  for (const enabled of [true, false]) {
    const setup = {
      managedByClient: true,
      ...Object.fromEntries(
        Object.entries(groups).map(([group, ids]) => [
          group,
          ids.map((id) => ({ id, enabled, authenticated: enabled, usable: enabled, detected: enabled })),
        ])
      ),
    };
    assert.deepEqual(filterConfiguredModels(models, setup), enabled ? models : []);
  }
});
