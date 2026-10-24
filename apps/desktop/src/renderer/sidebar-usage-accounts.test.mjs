import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { ActivityRail } from './ActivityRail.tsx';
import i18next from './i18n.ts';
import { SidebarUsage } from './SidebarUsage.tsx';
import { peekQuotaFocus, clearQuotaFocus } from './usage-surface-mode.ts';
import { press } from './test-support/pointer-press.mjs';
import { installTestDom } from './test-support/test-dom.mjs';
import { ACCOUNT_REREAD_WINDOW_MS, useUsageAccountPools } from './usage-account-pools.ts';
import { publishUsageDashboard } from './usage-dashboard-store.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 86_400_000;
const dashboard = {
  rows: [
    {
      id: 'openai-oauth',
      group: 'oauth',
      authenticated: true,
      windows: [{ label: '7D', usedPct: 5 }],
    },
    {
      id: 'anthropic-oauth',
      group: 'oauth',
      authenticated: true,
      windows: [
        { label: '5H', usedPct: 31 },
        { label: '7D', usedPct: 8 },
      ],
    },
  ],
};

// Provider settings order: Personal (in use), an email-only account that hit
// its limit, and an account known only by its id.
function pools() {
  return {
    'anthropic-oauth': {
      selectedId: 'p',
      auto: true,
      accounts: [
        {
          id: 'p',
          label: 'Personal',
          email: 'me@example.test',
          usage: {
            windows: [
              { label: '5H', usedPct: 31 },
              { label: '7D', usedPct: 8 },
            ],
          },
        },
        {
          id: 'd',
          label: '',
          email: 'dev@example.test',
          blockedUntil: Date.now() + 2 * DAY + 5_400_000,
          limit: { scope: 'account' },
          usage: {
            windows: [
              { label: '5H', usedPct: 0 },
              { label: '7D', usedPct: 97, resetAt: Date.now() + 2 * DAY + 5_400_000 },
            ],
          },
        },
        { id: 'z', label: '', email: '', usage: { windows: [{ label: '7D', usedPct: 50 }] } },
      ],
    },
    'openai-oauth': {
      selectedId: 'o',
      auto: true,
      accounts: [{ id: 'o', label: 'Default', usage: { windows: [{ label: '7D', usedPct: 5 }] } }],
    },
  };
}

const usageApi = {
  async invokeCapability({ capability, args }) {
    assert.equal(capability, 'getProviderAccounts');
    return { value: pools()[args[0]] ?? { selectedId: null, accounts: [] } };
  },
};

async function waitFor(check) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  }
  assert.ok(check(), 'condition not reached');
}

const text = (node) => node?.textContent ?? null;
const claudeRow = () => document.querySelector('[data-usage-provider="claude"]');

async function mountPanel(t, props = {}) {
  const { root } = installTestDom(t, { expose: ['HTMLElement', 'Node', 'Element'], rootId: 'root' });
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  publishUsageDashboard(dashboard);
  await act(async () => root.render(React.createElement(SidebarUsage, { api: usageApi, ...props })));
  return root;
}

test('collapsed: the picker trigger reads "name · N accounts" and single-account providers stay unchanged', async (t) => {
  await mountPanel(t);
  await waitFor(() => claudeRow().querySelector('.provider-account-picker-trigger.has-label'));
  assert.equal(text(claudeRow().querySelector('.provider-account-picker-trigger.has-label')), 'Personal · 3 accounts');
  assert.equal(claudeRow().querySelector('.sidebar-usage-account-count'), null);
  assert.equal(document.querySelectorAll('.sidebar-usage-account').length, 0);
  assert.equal(claudeRow().querySelectorAll('.sidebar-usage-meter').length, 2);
  const codex = document.querySelector('[data-usage-provider="codex"]');
  assert.equal(codex.querySelector('.sidebar-usage-account-count'), null);
  assert.equal(codex.querySelector('.provider-account-picker-trigger.has-label'), null);
});

test('expanded: one block per account with no index badge, name, email, in-use dot and red reset', async (t) => {
  await mountPanel(t, { accountsExpanded: true });
  await waitFor(() => claudeRow().querySelectorAll('.sidebar-usage-account').length === 3);
  const accounts = [...claudeRow().querySelectorAll('.sidebar-usage-account')];
  assert.equal(document.querySelector('.sidebar-usage-account-index'), null);
  assert.equal(text(claudeRow().querySelector('.sidebar-usage-account-count')), '3 accounts');
  assert.equal(claudeRow().querySelector('.provider-account-picker-trigger.has-label'), null);
  // The email follows the name only when a label exists.
  assert.deepEqual(
    accounts.map((account) => text(account.querySelector('.sidebar-usage-account-email'))),
    ['me@example.test', null, null]
  );
  // Registered label, then email, then id.
  assert.deepEqual(
    accounts.map((account) => text(account.querySelector('.sidebar-usage-account-name'))),
    ['Personal', 'dev@example.test', 'z']
  );
  assert.deepEqual(
    accounts.map((account) => account.querySelector('.sidebar-usage-account-inuse') !== null),
    [true, false, false]
  );
  assert.deepEqual(
    accounts.map((account) => text(account.querySelector('.sidebar-usage-account-limit'))),
    [null, 'Resets in 2d 2h', null]
  );
  // Each account repeats the existing meter grammar for its own windows.
  assert.deepEqual(
    accounts.map((account) =>
      [...account.querySelectorAll('.sidebar-usage-meter')].map((meter) => text(meter.querySelector('b')))
    ),
    [['31%', '8%'], ['0%', '97%'], ['50%']]
  );
  // The provider's own meter list is replaced, and single-account providers are unchanged.
  assert.equal(claudeRow().querySelector(':scope > .sidebar-usage-meters'), null);
  const codex = document.querySelector('[data-usage-provider="codex"]');
  assert.equal(codex.querySelectorAll('.sidebar-usage-account').length, 0);
  assert.equal(codex.querySelectorAll('.sidebar-usage-meter').length, 1);
});

const roster = (accounts) => ({ selectedId: accounts[0]?.id ?? null, auto: true, accounts });
const oauthDashboard = (id, usedPct) => ({
  rows: [{ id, group: 'oauth', authenticated: true, windows: [{ label: '7D', usedPct }] }],
});

// An account the runtime does not hold under a limit (credit-enabled, `limit: null`)
// is not red at 100%; one whose block and reset have both passed shows no reset.
test('expanded: only the runtime limit state turns an account red, and only with a pending reset', async (t) => {
  const future = Date.now() + 2 * DAY + 5_400_000;
  const exhausted = (resetAt) => ({ usage: { windows: [{ label: '7D', usedPct: 100, resetAt }] } });
  const api = {
    async invokeCapability({ args }) {
      return {
        value:
          args[0] === 'anthropic-oauth'
            ? roster([
                { id: 'credit', label: 'Credits', limit: null, ...exhausted(future) },
                { id: 'held', label: 'Held', limit: { scope: 'account' }, ...exhausted(future) },
                {
                  id: 'stale',
                  label: 'Stale',
                  limit: { scope: 'account' },
                  blockedUntil: Date.now() - 1_000,
                  ...exhausted(Date.now() - 1_000),
                },
              ])
            : roster([{ id: 'o', label: 'Default', usage: { windows: [] } }]),
      };
    },
  };
  await mountPanel(t, { accountsExpanded: true, api });
  await waitFor(() => claudeRow().querySelectorAll('.sidebar-usage-account').length === 3);
  assert.deepEqual(
    [...claudeRow().querySelectorAll('.sidebar-usage-account')].map((account) =>
      text(account.querySelector('.sidebar-usage-account-limit'))
    ),
    [null, 'Resets in 2d 2h', null]
  );
});

// ── Shared account reads ────────────────────────────────────────────────

function Probe({ api, providers, label }) {
  const pools = useUsageAccountPools(api, providers, true);
  return React.createElement(
    'output',
    { 'data-probe': label },
    providers.map((provider) => (pools.get(provider)?.accounts ?? []).map((account) => account.id).join(',')).join('|')
  );
}

test('account reads: a response from a retired request never overwrites newer state', async (t) => {
  const { root } = installTestDom(t, { expose: ['HTMLElement', 'Node', 'Element'], rootId: 'root' });
  const pending = [];
  const slowApi = {
    invokeCapability: () => new Promise((resolve) => pending.push(resolve)),
  };
  const freshApi = {
    invokeCapability: async () => ({ value: roster([{ id: 'new' }]) }),
  };
  const provider = ['cursor-oauth'];
  await act(async () => root.render(React.createElement(Probe, { api: slowApi, providers: provider, label: 'a' })));
  assert.equal(pending.length, 1);
  // The watcher goes away (retiring its request); a new one reads fresh state.
  await act(async () => root.render(null));
  await act(async () => root.render(React.createElement(Probe, { api: freshApi, providers: provider, label: 'a' })));
  await waitFor(() => text(document.querySelector('[data-probe]')) === 'new');
  // The retired request resolves last with older data.
  await act(async () => pending[0]({ value: roster([{ id: 'old' }]) }));
  assert.equal(text(document.querySelector('[data-probe]')), 'new');
});

test('account reads: users share one request per provider and only account providers are asked', async (t) => {
  const { root } = installTestDom(t, { expose: ['HTMLElement', 'Node', 'Element'], rootId: 'root' });
  const asked = [];
  let release;
  const api = {
    invokeCapability: ({ args }) => {
      asked.push(args[0]);
      return new Promise((resolve) => {
        release = () => resolve({ value: roster([{ id: `${args[0]}#${asked.length}` }]) });
      });
    },
  };
  const providers = ['mimo-oauth', 'plain-api'];
  await act(async () =>
    root.render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Probe, { api, providers, label: 'rail' }),
        React.createElement(Probe, { api, providers, label: 'panel' })
      )
    )
  );
  // Two users, one provider that has accounts: a single read in flight.
  assert.deepEqual(asked, ['mimo-oauth']);
  await act(async () => release());
  // Watchers that joined the first read do not cause a follow-up read.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(asked, ['mimo-oauth']);
  assert.deepEqual([...document.querySelectorAll('[data-probe]')].map(text), ['mimo-oauth#1|', 'mimo-oauth#1|']);
  // A new quota result for the provider rereads once for everyone.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await act(async () => {
    publishUsageDashboard(oauthDashboard('mimo-oauth', 10));
  });
  assert.deepEqual(asked, ['mimo-oauth', 'mimo-oauth']);
  await act(async () => release());
  assert.deepEqual([...document.querySelectorAll('[data-probe]')].map(text), ['mimo-oauth#2|', 'mimo-oauth#2|']);
});

test('account reads: each new quota result of the provider rereads once, even two within the same millisecond', async (t) => {
  const { root } = installTestDom(t, { expose: ['HTMLElement', 'Node', 'Element'], rootId: 'root' });
  const asked = [];
  const api = {
    invokeCapability: async ({ args }) => {
      asked.push(args[0]);
      return { value: roster([{ id: `n${asked.length}` }]) };
    },
  };
  await act(async () => root.render(React.createElement(Probe, { api, providers: ['antigravity-oauth'], label: 'a' })));
  await waitFor(() => asked.length === 1);
  const now = Date.now;
  t.after(() => {
    Date.now = now;
  });
  Date.now = () => now() + 1000;
  await act(async () => {
    publishUsageDashboard(oauthDashboard('antigravity-oauth', 10));
  });
  await waitFor(() => asked.length === 2);
  // Same millisecond, new quota result.
  await act(async () => {
    publishUsageDashboard(oauthDashboard('antigravity-oauth', 20));
  });
  await waitFor(() => asked.length === 3);
  await waitFor(() => text(document.querySelector('[data-probe]')) === 'n3');
  assert.equal(asked.length, 3);
});

test("account reads: a dashboard publication that leaves the provider's own row alone does not reread", async (t) => {
  const { root } = installTestDom(t, { expose: ['HTMLElement', 'Node', 'Element'], rootId: 'root' });
  const asked = [];
  const api = {
    invokeCapability: async ({ args }) => {
      asked.push(args[0]);
      return { value: roster([{ id: `n${asked.length}` }]) };
    },
  };
  const both = (otherPct) => ({
    rows: [...oauthDashboard('antigravity-oauth', 10).rows, ...oauthDashboard('other-oauth', otherPct).rows],
  });
  await act(async () => {
    publishUsageDashboard(both(1));
  });
  await act(async () => root.render(React.createElement(Probe, { api, providers: ['antigravity-oauth'], label: 'a' })));
  await waitFor(() => asked.length === 1);
  // Publications about other providers (a phone's boot makes many) cost no roster read.
  for (const pct of [2, 3, 4, 5]) {
    await act(async () => {
      publishUsageDashboard(both(pct));
    });
  }
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  assert.equal(asked.length, 1);
  // A window later the next publication rereads even with its row unchanged:
  // accounts changed on another device show up only in the roster.
  const now = Date.now;
  t.after(() => {
    Date.now = now;
  });
  Date.now = () => now() + ACCOUNT_REREAD_WINDOW_MS + 1000;
  await act(async () => {
    publishUsageDashboard(both(6));
  });
  await waitFor(() => asked.length === 2);
  await act(async () => {
    publishUsageDashboard(both(7));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  assert.equal(asked.length, 2, 'once per window');
  // Its own row changing still rereads.
  await act(async () => {
    publishUsageDashboard({
      rows: [...oauthDashboard('antigravity-oauth', 11).rows, ...oauthDashboard('other-oauth', 5).rows],
    });
  });
  await waitFor(() => asked.length === 3);
});

test("an account name opens that account's usage chart", async (t) => {
  let opened = 0;
  await mountPanel(t, { accountsExpanded: true, onOpenStats: () => opened++ });
  await waitFor(() => claudeRow().querySelectorAll('.sidebar-usage-account').length === 3);
  clearQuotaFocus();
  await press(claudeRow().querySelectorAll('.sidebar-usage-account-name')[1]);
  assert.equal(opened, 1);
  assert.deepEqual(peekQuotaFocus(), { provider: 'anthropic-oauth', window: '', account: 'd' });
});

// ── Rail ────────────────────────────────────────────────────────────────

async function mountRail(t, { stored = {}, railHeight = 2000, api = usageApi } = {}) {
  const { root } = installTestDom(t, { expose: ['HTMLElement', 'Node', 'Element'], rootId: 'root' });
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => railHeight });
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  const settings = { usagePinned: true, usageRailShortLong: false, ...stored };
  window.mixdogDesktop = {
    readActivityRailPins: async () => null,
    subscribeActivityRailPins: () => () => {},
    readSettings: async () => ({ ...settings }),
    updateSetting: async (key, value) => {
      settings[key] = value;
      return { ...settings };
    },
  };
  publishUsageDashboard({
    rows: [...dashboard.rows, { id: 'opencode-go-oauth', authenticated: true, windows: [{ label: 'M', usedPct: 10 }] }],
  });
  const props = {
    settingsOpen: false,
    onOpenSettings() {},
    usageApi: api,
    navigationItems: [],
    activeNavigationId: null,
    onSelectNavigation() {},
  };
  await act(async () => root.render(React.createElement(ActivityRail, props)));
  return settings;
}

const pinKeys = () =>
  [...document.querySelectorAll('[data-usage-pin]')].map((node) => node.getAttribute('data-usage-pin'));
const step = (direction) => document.querySelector(`[data-rail-step="${direction}"]`);

test('rail: expanded accounts get their own slot with an index badge, the slot limit scrolls without a scrollbar', async (t) => {
  const settings = await mountRail(t, {
    stored: { usageAccountsExpanded: true, usageRailSlotsThree: true, usageRailSlotsAll: false },
  });
  // codex (1 account) + three claude accounts + opencode = 5 slots; limit 3.
  await waitFor(() => pinKeys().length === 3 && document.querySelector('.rail-usage-pin-mark'));
  assert.deepEqual(pinKeys(), ['codex', 'claude:p', 'claude:d']);
  // Single-account providers draw no badge; accounts draw their roster index.
  const badges = [...document.querySelectorAll('.rail-usage-pin-mark > sup')];
  assert.deepEqual(badges.map(text), ['1', '2']);
  assert.deepEqual(
    badges.map((badge) => badge.classList.contains('is-selected')),
    [true, false]
  );
  assert.match(
    document.querySelector('[data-usage-pin="claude:d"]').getAttribute('data-tooltip'),
    /^Claude · 2 dev@example\.test · 5-hour 0% · weekly 97%/
  );
  // Chevrons only on the side that has more.
  assert.equal(step(-1), null);
  assert.ok(step(1));
  await press(step(1));
  assert.deepEqual(pinKeys(), ['claude:p', 'claude:d', 'claude:z']);
  assert.ok(step(-1));
  assert.ok(step(1));
  // The wheel moves one slot too.
  await act(async () => {
    document
      .querySelector('.sidebar-usage-toggle')
      .dispatchEvent(new window.WheelEvent('wheel', { deltaY: 120, bubbles: true }));
  });
  assert.deepEqual(pinKeys(), ['claude:d', 'claude:z', 'opencode-go-oauth']);
  assert.equal(step(1), null);
  assert.equal(settings.usageRailSlotsThree, true);
});

test('rail: scrolling without a data change does not rebuild entries or tooltips', async (t) => {
  await mountRail(t, {
    stored: { usageAccountsExpanded: true, usageRailSlotsThree: true, usageRailSlotsAll: false },
  });
  await waitFor(() => pinKeys().length === 3 && document.querySelector('.rail-usage-pin-mark'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
  // Tooltips name each window ('weekly'): every entry built formats them.
  const original = i18next.t;
  let weekly = 0;
  i18next.t = function counted(key, ...rest) {
    if (key === 'weekly') weekly += 1;
    return original.call(this, key, ...rest);
  };
  t.after(() => {
    i18next.t = original;
  });
  const before = pinKeys();
  await press(step(1));
  await press(step(1));
  assert.notDeepEqual(pinKeys(), before);
  assert.equal(weekly, 0);
});

test('rail: keyboard stepping to either end keeps focus on a mounted step control', async (t) => {
  await mountRail(t, {
    stored: { usageAccountsExpanded: true, usageRailSlotsThree: true, usageRailSlotsAll: false },
  });
  await waitFor(() => pinKeys().length === 3 && document.querySelector('.rail-usage-pin-mark'));
  // Five slots, three visible: two steps reach the end.
  step(1).focus();
  while (step(1)) {
    assert.equal(document.activeElement, step(1));
    await act(async () => step(1).click());
  }
  assert.deepEqual(pinKeys(), ['claude:d', 'claude:z', 'opencode-go-oauth']);
  assert.ok(step(-1));
  assert.equal(document.activeElement, step(-1));
  // And back to the start: the earlier control leaves, focus moves to more.
  while (step(-1)) {
    assert.equal(document.activeElement, step(-1));
    await act(async () => step(-1).click());
  }
  assert.deepEqual(pinKeys(), ['codex', 'claude:p', 'claude:d']);
  assert.equal(document.activeElement, step(1));
});

const wheel = (init) =>
  act(async () => {
    for (const one of Array.isArray(init) ? init : [init]) {
      document
        .querySelector('.sidebar-usage-toggle')
        .dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, ...one }));
    }
  });

test('rail wheel: horizontal and zero deltas never step, rapid notches each step, smooth deltas accumulate', async (t) => {
  await mountRail(t, { stored: { usageAccountsExpanded: true, usageRailSlotsThree: true } });
  await waitFor(() => pinKeys().length === 3 && document.querySelector('.rail-usage-pin-mark'));
  const first = ['codex', 'claude:p', 'claude:d'];
  assert.deepEqual(pinKeys(), first);
  // Sideways scrolling and a zero vertical delta do nothing (not a step back).
  await wheel([{ deltaX: 120, deltaY: 0 }, { deltaY: 0 }, { deltaX: 200, deltaY: 20 }]);
  assert.deepEqual(pinKeys(), first);
  // Small trackpad deltas add up to one notch before they step.
  await wheel([{ deltaY: 40 }, { deltaY: 40 }]);
  assert.deepEqual(pinKeys(), first);
  await wheel({ deltaY: 40 });
  assert.deepEqual(pinKeys(), ['claude:p', 'claude:d', 'claude:z']);
  // Two fast discrete notches in one frame are two steps.
  await wheel([{ deltaY: 100 }, { deltaY: 100 }]);
  assert.deepEqual(pinKeys(), ['claude:d', 'claude:z', 'opencode-go-oauth']);
  // Scrolling up is one notch back, not dropped.
  await wheel({ deltaY: -100 });
  assert.deepEqual(pinKeys(), ['claude:p', 'claude:d', 'claude:z']);
});

// Seven claude accounts + codex + opencode = nine slots, so All differs from the default five.
const manyAccounts = {
  async invokeCapability({ args }) {
    const ids = Array.from({ length: 7 }, (_, index) => `a${index + 1}`);
    return {
      value:
        args[0] === 'anthropic-oauth'
          ? roster(ids.map((id) => ({ id, label: id, usage: { windows: [{ label: '7D', usedPct: 10 }] } })))
          : roster([{ id: 'x', label: 'x', usage: { windows: [{ label: '7D', usedPct: 10 }] } }]),
    };
  },
};
const allNine = ['codex', ...Array.from({ length: 7 }, (_, index) => `claude:a${index + 1}`), 'opencode-go-oauth'];

test('rail: All shows every one of nine slots with no chevrons', async (t) => {
  await mountRail(t, { stored: { usageAccountsExpanded: true, usageRailSlotsAll: true }, api: manyAccounts });
  await waitFor(() => pinKeys().length === 9);
  assert.deepEqual(pinKeys(), allNine);
  assert.equal(step(-1), null);
  assert.equal(step(1), null);
});

test('rail: the default limit shows five of the same nine slots with a chevron for the rest', async (t) => {
  await mountRail(t, { stored: { usageAccountsExpanded: true }, api: manyAccounts });
  await waitFor(() => pinKeys().length === 5 && document.querySelector('.rail-usage-pin-mark'));
  assert.deepEqual(pinKeys(), allNine.slice(0, 5));
  assert.equal(step(-1), null);
  assert.ok(step(1));
});

test('rail: collapsed (default) is one slot per provider without badges', async (t) => {
  await mountRail(t);
  await waitFor(() => pinKeys().length === 3);
  assert.deepEqual(pinKeys(), ['codex', 'claude', 'opencode-go-oauth']);
  assert.equal(document.querySelector('.rail-usage-pin-mark'), null);
  assert.equal(step(1), null);
});

test('rail: a short rail shows fewer slots, and the pie icon when not even one fits', async (t) => {
  // 5 slots, limit 5: one slot needs 17 + 40 + two 12px chevrons = 81px.
  await mountRail(t, { stored: { usageAccountsExpanded: true }, railHeight: 140 });
  await waitFor(() => pinKeys().length > 0 && document.querySelector('.rail-usage-pin-mark'));
  // 17 + 2×40 + 12 + 24 = 133 fits two slots; three need 185.
  assert.equal(pinKeys().length, 2);
  assert.ok(step(1));
});

test('rail: no room for even one slot falls back to the pie icon', async (t) => {
  await mountRail(t, { stored: { usageAccountsExpanded: true }, railHeight: 60 });
  await waitFor(() => document.querySelector('.codicon-pie-chart'));
  assert.equal(pinKeys().length, 0);
});

// ── Menu ────────────────────────────────────────────────────────────────

test('the usage menu lists Expand all accounts under Pin to rail and persists it and the slot choice', async (t) => {
  const settings = await mountRail(t);
  await waitFor(() => pinKeys().length > 0);
  await press(document.querySelector('.sidebar-usage-toggle'));
  await waitFor(() => document.querySelector('.sidebar-usage-menu'));
  await press(document.querySelector('.sidebar-usage-menu'));
  const checkboxes = [...document.querySelectorAll('.usage-menu [role="menuitemcheckbox"]')];
  assert.deepEqual(checkboxes.map(text), ['Pin to rail', 'Expand all accounts']);
  assert.equal(checkboxes[1].getAttribute('aria-checked'), 'false');
  await press(checkboxes[1]);
  await waitFor(() => settings.usageAccountsExpanded === true);
  assert.equal(document.querySelector('[data-usage-accounts-expand]').getAttribute('aria-checked'), 'true');

  const slots = () => [...document.querySelectorAll('[data-rail-slots]')];
  assert.deepEqual(slots().map(text), ['3 slots', '5 slots', 'All slots']);
  assert.deepEqual(
    slots().map((radio) => radio.getAttribute('aria-checked')),
    ['false', 'true', 'false']
  );
  await press(slots()[0]);
  await waitFor(() => settings.usageRailSlotsThree === true);
  assert.equal(settings.usageRailSlotsAll, false);
  await press(slots()[2]);
  await waitFor(() => settings.usageRailSlotsAll === true);
  assert.equal(settings.usageRailSlotsThree, false);
  assert.equal(window.localStorage.getItem('mixdog.desktop.usage-rail-prefs.v2').includes('"slots":"all"'), true);
});
