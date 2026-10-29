import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { ComposerDock } from './ComposerDock.tsx';
import { defaultSessionLaneStore } from './session-lane-store.ts';
import { t as translate } from './i18n.ts';
import * as quotaContinue from './quota-continue.ts';
import { useConversationQuotaCard, rosterOffersOtherAccount } from './use-conversation-quota-card.ts';
import { inheritSessionDirectly } from './session-inheritance.ts';
import { DESKTOP_TOAST_EVENT } from './desktop-toasts.tsx';
import { transcriptTurnKeys } from '../../../../src/tui/session/quota-resume.mjs';

const { latestQuotaFailure, quotaDismissKey, quotaPanelVisible, quotaRemainingLabel, quotaResetLabel } = quotaContinue;
const quota = { provider: 'anthropic', model: 'claude-opus', resetAt: null };
const failed = (extra = {}) => ({ kind: 'turndone', status: 'failed', quota, ...extra });
const keysFor = (items) => items.map(() => 'turn:u1');

test('quota failure: only the latest failed turndone with quota and no later turn', () => {
  const base = [{ kind: 'user', id: 'u1', text: 'hi' }];
  assert.deepEqual(latestQuotaFailure([...base, failed()], keysFor([...base, failed()])), {
    turnKey: 'turn:u1',
    kind: 'quota_exhausted',
    quota,
  });
  for (const kind of ['overloaded', 'rate_limited', 'auth', 'policy', 'context_overflow']) {
    const other = [...base, failed({ errorKind: { kind } })];
    assert.equal(latestQuotaFailure(other, keysFor(other)), null, `${kind} has no usage banner`);
  }
  const plan = [...base, failed({ errorKind: { kind: 'entitlement' } })];
  assert.equal(latestQuotaFailure(plan, keysFor(plan))?.kind, 'entitlement');
  const described = [...base, failed({ quota: { ...quota }, errorKind: { kind: 'quota_exhausted', resetAt: 5_000 } })];
  assert.equal(latestQuotaFailure(described, keysFor(described))?.quota.resetAt, 5_000, 'reset from the descriptor');
  const noQuota = [...base, { kind: 'turndone', status: 'failed' }];
  assert.equal(latestQuotaFailure(noQuota, keysFor(noQuota)), null);
  const done = [...base, failed({ status: 'done' })];
  assert.equal(latestQuotaFailure(done, keysFor(done)), null);
  const later = [...base, failed(), { kind: 'user', id: 'u2', text: 'again' }];
  assert.equal(latestQuotaFailure(later, keysFor(later)), null, 'a later turn hides it');
  assert.equal(latestQuotaFailure([], []), null);
});

test('panel visibility: idle, undismissed, quota present', () => {
  const failure = { turnKey: 'turn:u1', kind: 'quota_exhausted', quota };
  const state = { failure, sessionId: 's1', busy: false, dismissedKey: '' };
  assert.equal(quotaPanelVisible(state), true, 'exhausted quota stays visible without a known reset');
  const known = { ...failure, quota: { ...quota, resetAt: 5_000 } };
  assert.equal(quotaPanelVisible({ ...state, failure: known }), true);
  assert.equal(quotaPanelVisible({ ...state, failure: { ...failure, kind: 'billing' } }), true);
  assert.equal(quotaPanelVisible({ ...state, failure: null }), false, 'no quota failure / a later turn');
  const live = { ...state, failure: known };
  assert.equal(quotaPanelVisible({ ...live, busy: true }), false);
  assert.equal(quotaPanelVisible({ ...live, dismissedKey: quotaDismissKey('s1', 'turn:u1') }), false);
  assert.equal(quotaPanelVisible({ ...live, dismissedKey: quotaDismissKey('s1', 'turn:u0') }), true);
});

test('remaining label rounds up to whole minutes', () => {
  const now = 1_000_000;
  const at = (ms) => quotaRemainingLabel(now + ms, now);
  assert.equal(at((2 * 60 + 15) * 60_000), translate('{{hours}}h {{minutes}}m', { hours: 2, minutes: 15 }));
  assert.equal(at(2 * 3_600_000), translate('{{hours}}h', { hours: 2 }));
  assert.equal(at(5 * 60_000 - 1), translate('{{minutes}}m', { minutes: 5 }));
  assert.equal(at(1), translate('{{minutes}}m', { minutes: 1 }));
  assert.equal(at(-5), translate('Under 1m'));
});

test('reset label is HH:mm today and carries the day otherwise', () => {
  const now = new Date(2026, 9, 12, 9, 0).getTime();
  assert.equal(quotaResetLabel(new Date(2026, 9, 12, 18, 40).getTime(), now), '18:40');
  assert.equal(quotaResetLabel(new Date(2026, 9, 13, 3, 5).getTime(), now), '10/13 03:05');
});

test('account guidance needs a manual roster with another signed-in account', () => {
  const accounts = [
    { id: 'a', authenticated: true },
    { id: 'b', authenticated: true },
  ];
  assert.equal(rosterOffersOtherAccount({ policy: 'manual', selectedId: 'a', accounts }), true);
  assert.equal(rosterOffersOtherAccount({ auto: false, selectedId: 'a', accounts }), true, 'legacy auto off');
  assert.equal(rosterOffersOtherAccount({ policy: 'limit', selectedId: 'a', accounts }), false, 'rotation does it');
  assert.equal(rosterOffersOtherAccount({ selectedId: 'a', accounts }), false, 'no policy: limit');
  assert.equal(rosterOffersOtherAccount({ policy: 'manual', selectedId: 'a', accounts: accounts.slice(0, 1) }), false);
  assert.equal(
    rosterOffersOtherAccount({
      policy: 'manual',
      selectedId: 'a',
      accounts: [
        accounts[0],
        { id: 'b', authenticated: true, reauthRequired: true },
        { id: 'c', authenticated: false },
      ],
    }),
    false,
    'signed-out accounts do not count'
  );
  assert.equal(rosterOffersOtherAccount(null), false);
});

/** Observers the test can fire (width changes). */
const observers = new Set();

function mount(t) {
  const { dom, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'CustomEvent'],
    globals: {
      ResizeObserver: class {
        constructor(callback) {
          this.callback = callback;
        }
        observe() {
          observers.add(this);
        }
        disconnect() {
          observers.delete(this);
        }
      },
    },
    rootId: 'root',
  });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.requestAnimationFrame = (callback) => dom.window.setTimeout(() => callback(Date.now()), 16);
  dom.window.cancelAnimationFrame = (id) => dom.window.clearTimeout(id);
  dom.window.mixdogDesktop = {};
  t.after(() => defaultSessionLaneStore.clear());
  return { root, document: dom.window.document };
}

const dockProps = (overrides = {}) => ({
  sessionId: 'island-session',
  goalSubmissionId: '',
  showProjectSelector: false,
  reviewItems: [],
  reviewActive: true,
  reviewBusy: false,
  reviewSessionId: '',
  reviewCwd: '',
  children: React.createElement('form', { className: 'composer' }),
  ...overrides,
});

const banner = (document) => document.querySelector('.composer-quota-card');
const guidanceText = (otherAccount = false) =>
  otherAccount
    ? translate("Switch accounts or to another provider's model to continue now")
    : translate("Switch to another provider's model to continue now");

test('the quota banner is one line between the island and the composer, with no close', async (t) => {
  const { root, document } = mount(t);
  const calls = [];
  const render = (quotaCard) =>
    act(async () => root.render(React.createElement(ComposerDock, { ...dockProps(), quotaCard })));
  await render(null);
  assert.equal(banner(document), null);

  const resetAt = Date.now() + (2 * 60 + 15) * 60_000 - 1_000;
  const time = quotaResetLabel(resetAt);
  await render({
    resetAt,
    otherAccount: false,
    reserved: false,
    busy: false,
    onToggleResume: () => calls.push('toggle'),
  });
  const section = banner(document);
  const order = [...document.querySelector('.composer-region').children].map((child) => child.className);
  assert.deepEqual(order, ['composer-island-slot', 'composer-quota-card', 'composer']);
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'pill', 'the island stays a pill');
  assert.ok(section.querySelector('svg.composer-quota-card-icon'), 'warning glyph');
  assert.equal(section.querySelector('.composer-quota-card-title').textContent, translate('Usage limit reached'));
  assert.equal(
    section.querySelector('.composer-quota-card-reset').textContent,
    translate('· {{remaining}} left', {
      remaining: translate('{{hours}}h {{minutes}}m', { hours: 2, minutes: 15 }),
    })
  );
  assert.equal(section.querySelector('.composer-quota-card-guide').textContent, `· ${guidanceText()}`);
  assert.equal(section.dataset.guidanceHidden, undefined, 'room for the guidance');
  const buttons = [...section.querySelectorAll('button')];
  assert.deepEqual(
    buttons.map((button) => [button.textContent, button.classList.contains('composer-island-button-primary')]),
    [[translate('Resume at {{time}}', { time }), true]],
    'only the resume button: no close, no switch'
  );
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'false');
  assert.equal(buttons[0].dataset.reserved, undefined, 'off: the clock stays still');
  await act(async () => buttons[0].click());
  assert.deepEqual(calls, ['toggle']);

  // Reserved: the same button spins and pressing it cancels.
  await render({
    resetAt,
    otherAccount: false,
    reserved: true,
    busy: false,
    onToggleResume: () => calls.push('toggle'),
  });
  const reserved = banner(document).querySelector('button');
  assert.equal(reserved.getAttribute('aria-pressed'), 'true');
  assert.equal(reserved.dataset.reserved, 'true', 'on: the icon spins');
  assert.equal(reserved.getAttribute('title'), translate('Resume reserved · click to cancel'));

  // An unknown reset: no time part and no resume button.
  await render({ resetAt: null, otherAccount: true, reserved: false, busy: false });
  assert.equal(banner(document).querySelector('.composer-quota-card-reset'), null);
  assert.equal(banner(document).querySelector('button'), null);
  assert.equal(banner(document).querySelector('.composer-quota-card-guide').textContent, `· ${guidanceText(true)}`);
});

test('a plan or billing stop shows its own guidance and never offers a resume', async (t) => {
  const { root, document } = mount(t);
  for (const [kind, title, guide] of [
    ['entitlement', 'Not included in your plan', 'Upgrade your plan, or choose another model or provider.'],
    ['billing', 'Out of credits or at spend limit', 'Check your billing with the provider, then try again.'],
  ]) {
    await act(async () =>
      root.render(
        React.createElement(ComposerDock, {
          ...dockProps(),
          quotaCard: { kind, resetAt: null, otherAccount: false, reserved: false, busy: false },
        })
      )
    );
    const section = banner(document);
    assert.equal(section.querySelector('.composer-quota-card-title').textContent, translate(title));
    assert.equal(section.querySelector('.composer-quota-card-guide').textContent, `· ${translate(guide)}`);
    assert.equal(section.querySelector('button'), null);
    assert.equal(section.querySelector('.composer-quota-card-reset'), null);
  }
});

test('a guidance that does not fit is hidden and kept as the tooltip and description', async (t) => {
  const { root, document } = mount(t);
  const window = document.defaultView;
  let room = 200;
  const text = (element) => element.classList?.contains('composer-quota-card-guide');
  const scroll = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'scrollWidth');
  const client = Object.getOwnPropertyDescriptor(window.Element.prototype, 'clientWidth');
  Object.defineProperty(window.HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() {
      return text(this) ? 480 : 0;
    },
  });
  Object.defineProperty(window.Element.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return text(this) ? room : 0;
    },
  });
  t.after(() => {
    if (scroll) Object.defineProperty(window.HTMLElement.prototype, 'scrollWidth', scroll);
    if (client) Object.defineProperty(window.Element.prototype, 'clientWidth', client);
  });
  const resetAt = Date.now() + 3_600_000;
  await act(async () =>
    root.render(
      React.createElement(ComposerDock, {
        ...dockProps(),
        quotaCard: { resetAt, otherAccount: false, reserved: false, busy: false, onToggleResume() {} },
      })
    )
  );
  const section = banner(document);
  assert.equal(section.dataset.guidanceHidden, 'true');
  assert.equal(section.title, guidanceText());
  assert.equal(document.getElementById(section.getAttribute('aria-describedby')).textContent, guidanceText());
  assert.ok(section.querySelector('.composer-quota-card-title'), 'title stays');
  assert.ok(section.querySelector('.composer-quota-card-reset'), 'reset stays');
  assert.ok(section.querySelector('button'), 'resume stays');

  room = 600;
  await act(async () => {
    for (const observer of observers) observer.callback([]);
  });
  assert.equal(section.dataset.guidanceHidden, undefined, 'wide again: the guidance shows');
  assert.equal(section.hasAttribute('title'), false);
  assert.equal(section.hasAttribute('aria-describedby'), false);
});

function QuotaHarness(props) {
  const { quotaCard, quotaResume } = useConversationQuotaCard(props);
  return React.createElement(ComposerDock, { ...dockProps(), quotaCard, quotaResume });
}

const conversation = [
  { kind: 'user', id: 'u1', text: 'hi' },
  { kind: 'assistant', id: 'a1', text: 'hello' },
  { kind: 'turndone', id: 'd1', status: 'done' },
];
const quotaStop = (resetAt) => [
  ...conversation,
  { kind: 'user', id: 'u2', text: 'do it' },
  {
    kind: 'turndone',
    id: 'd2',
    status: 'failed',
    quota: { provider: 'anthropic-oauth', model: 'claude-opus', resetAt },
  },
];

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The host's quota calls and the exhausted provider's account roster. */
function quotaHost(document, roster = null) {
  const host = { schedules: [], cancels: [], retries: [], rosterReads: [], roster };
  document.defaultView.mixdogDesktop = {
    scheduleQuotaResume: async (sessionId) => {
      host.schedules.push(sessionId);
      return true;
    },
    cancelQuotaResume: async (sessionId) => {
      host.cancels.push(sessionId);
      return true;
    },
    invokeCapability: async ({ capability, args, sessionId }) => {
      if (capability === 'retryFailedTurn') {
        host.retries.push({ sessionId, args });
        return { value: true };
      }
      assert.equal(capability, 'getProviderAccounts');
      host.rosterReads.push(args[0]);
      if (!host.roster) throw new Error('no roster');
      return { value: host.roster };
    },
  };
  return host;
}

function quotaProps(overrides = {}) {
  const settledItems = overrides.settledItems ?? quotaStop(Date.now() + 3_600_000);
  return {
    draftMode: false,
    snapshot: { sessionId: 's1' },
    sessionId: 's1',
    pendingPromptCount: 0,
    invokeResult: async (action) => action(),
    ...overrides,
    settledItems,
    settledTurnKeys: transcriptTurnKeys(settledItems),
  };
}

test('a changed model offers immediate resume without automatically submitting', async (t) => {
  const { root, document } = mount(t);
  const host = quotaHost(document);
  const render = (chatProvider, chatModel) =>
    act(async () => {
      root.render(
        React.createElement(
          QuotaHarness,
          quotaProps({
            chatProvider,
            chatModel,
          })
        )
      );
      await settle();
    });
  await render('anthropic-oauth', 'claude-opus');
  assert.ok(banner(document), 'still on the exhausted model');
  await render('anthropic-oauth', 'claude-sonnet');
  assert.equal(banner(document).querySelectorAll('button').length, 1);
  assert.equal(banner(document).querySelector('button').textContent, translate('Resume with changed model'));
  await render('openai-oauth', 'gpt-5.1');
  assert.equal(banner(document).querySelectorAll('button').length, 1);
  assert.deepEqual(host.retries, []);
  await act(async () => {
    banner(document).querySelector('button').click();
    await settle();
  });
  assert.deepEqual(host.retries, [{ sessionId: 's1', args: ['s1', 'turn:u2'] }]);
  await render('', '');
  assert.ok(banner(document), 'unknown chat route keeps the banner');
});

test('one button cancels an existing reservation before offering changed-model resume', async (t) => {
  const { root, document } = mount(t);
  const host = quotaHost(document);
  const resetAt = Date.now() + 3_600_000;
  const render = (quotaResume) =>
    act(async () => {
      root.render(
        React.createElement(
          QuotaHarness,
          quotaProps({
            chatProvider: 'openai-oauth',
            chatModel: 'gpt-new',
            settledItems: quotaStop(resetAt),
            snapshot: { sessionId: 's1', quotaResume },
          })
        )
      );
      await settle();
    });
  await render({ state: 'waiting', turnKey: 'turn:u2', provider: 'anthropic-oauth', model: 'claude-opus', resetAt });
  assert.equal(banner(document).querySelectorAll('button').length, 1);
  const button = banner(document).querySelector('button');
  assert.equal(button.textContent, translate('Cancel resume'));
  assert.equal(button.dataset.reserved, 'true');
  await act(async () => {
    button.click();
    await settle();
  });
  assert.deepEqual(host.cancels, ['s1']);
  assert.deepEqual(host.retries, []);
  await render(null);
  assert.equal(banner(document).querySelector('button').textContent, translate('Resume with changed model'));
  await act(async () => {
    banner(document).querySelector('button').click();
    await settle();
  });
  assert.equal(host.retries.length, 1);
});

test('a refused immediate resume reports an actionable error instead of silently doing nothing', async (t) => {
  const { root, document } = mount(t);
  quotaHost(document);
  document.defaultView.mixdogDesktop.invokeCapability = async () => ({ value: false });
  const errors = [];
  await act(async () => {
    root.render(
      React.createElement(
        QuotaHarness,
        quotaProps({
          chatProvider: 'openai-oauth',
          chatModel: 'gpt-new',
          invokeResult: async (action) => {
            try {
              return await action();
            } catch (error) {
              errors.push(error.message);
            }
          },
        })
      )
    );
    await settle();
  });
  await act(async () => {
    banner(document).querySelector('button').click();
    await settle();
  });
  assert.deepEqual(errors, [translate('Unable to resume this turn. Check its status or send a new message.')]);
  assert.equal(banner(document).querySelector('button').disabled, false);
});

test('a manual roster with another signed-in account adds the account guidance', async (t) => {
  const { root, document } = mount(t);
  const host = quotaHost(document, {
    policy: 'manual',
    selectedId: 'a',
    accounts: [
      { id: 'a', authenticated: true },
      { id: 'b', authenticated: true },
    ],
  });
  await act(async () => {
    root.render(React.createElement(QuotaHarness, quotaProps()));
    await settle();
  });
  assert.deepEqual(host.rosterReads, ['anthropic-oauth'], 'the exhausted provider');
  assert.equal(banner(document).querySelector('.composer-quota-card-guide').textContent, `· ${guidanceText(true)}`);
});

test('a reopened banner reads the roster afresh; a failed read drops the earlier account guidance', async (t) => {
  const { root, document } = mount(t);
  const host = quotaHost(document, {
    policy: 'manual',
    selectedId: 'a',
    accounts: [
      { id: 'a', authenticated: true },
      { id: 'b', authenticated: true },
    ],
  });
  const render = (chatModel) =>
    act(async () => {
      root.render(React.createElement(QuotaHarness, quotaProps({ chatProvider: 'anthropic-oauth', chatModel })));
      await settle();
    });
  await render('claude-opus');
  assert.equal(banner(document).querySelector('.composer-quota-card-guide').textContent, `· ${guidanceText(true)}`);
  await render('claude-sonnet');
  assert.equal(banner(document).querySelector('button').textContent, translate('Resume with changed model'));
  host.roster = null;
  await render('claude-opus');
  assert.deepEqual(host.rosterReads, ['anthropic-oauth', 'anthropic-oauth'], 'read again on reopening');
  assert.equal(banner(document).querySelector('.composer-quota-card-guide').textContent, `· ${guidanceText()}`);
});

test('a roster that cannot be read keeps the provider guidance', async (t) => {
  const { root, document } = mount(t);
  const host = quotaHost(document);
  await act(async () => {
    root.render(React.createElement(QuotaHarness, quotaProps()));
    await settle();
  });
  assert.deepEqual(host.rosterReads, ['anthropic-oauth']);
  assert.equal(banner(document).querySelector('.composer-quota-card-guide').textContent, `· ${guidanceText()}`);
});

test('the resume button toggles the reservation and the banner stays; no island pill beside it', async (t) => {
  const { root, document } = mount(t);
  const host = quotaHost(document);
  const resetAt = Date.now() + 3_600_000;
  const waitingResume = {
    state: 'waiting',
    turnKey: 'turn:u2',
    provider: 'anthropic-oauth',
    model: 'claude-opus',
    resetAt,
  };
  const render = (snapshot) =>
    act(async () => {
      root.render(React.createElement(QuotaHarness, quotaProps({ snapshot, settledItems: quotaStop(resetAt) })));
      await settle();
    });
  const resume = () => banner(document).querySelector('button');

  // Off: pressing reserves; the banner stays.
  await render({ sessionId: 's1' });
  assert.equal(resume().dataset.reserved, undefined);
  await act(async () => {
    resume().click();
    await settle();
  });
  assert.deepEqual(host.schedules, ['s1']);
  assert.ok(banner(document), 'the banner stays');

  // Reserved (by the click or by the runtime on its own): the button spins,
  // the island shows no separate waiting pill, and pressing cancels.
  await render({ sessionId: 's1', quotaResume: waitingResume });
  assert.equal(resume().dataset.reserved, 'true');
  assert.equal(document.querySelector('.composer-island-seg-warning'), null, 'no pill beside the banner');
  await act(async () => {
    resume().click();
    await settle();
  });
  assert.deepEqual(host.cancels, ['s1']);
  assert.ok(banner(document), 'cancelling keeps the banner, off again once the snapshot drops the reservation');
  await render({ sessionId: 's1' });
  assert.equal(resume().dataset.reserved, undefined);
});

test('a reservation without a banner still shows the island pill, which offers only cancel', async (t) => {
  const { root, document } = mount(t);
  const host = quotaHost(document);
  const resetAt = Date.now() + 3_600_000;
  await act(async () => {
    root.render(
      React.createElement(
        QuotaHarness,
        quotaProps({
          snapshot: {
            sessionId: 's1',
            quotaResume: {
              state: 'waiting',
              turnKey: 'turn:u2',
              provider: 'anthropic-oauth',
              model: 'claude-opus',
              resetAt,
            },
          },
          settledItems: quotaStop(resetAt),
          pendingPromptCount: 1,
        })
      )
    );
    await settle();
  });
  assert.equal(banner(document), null, 'a queued prompt hides the banner');
  await act(async () => document.querySelector('.composer-island-seg-warning').click());
  const panelButtons = [...document.querySelectorAll('.composer-island-quota .composer-island-pfoot button')];
  assert.deepEqual(
    panelButtons.map((button) => button.textContent),
    [translate('Cancel resume')]
  );
  await act(async () => {
    panelButtons[0].click();
    await settle();
  });
  assert.deepEqual(host.cancels, ['s1']);
});

test('a new turn removes the banner', async (t) => {
  const { root, document } = mount(t);
  quotaHost(document);
  const render = (overrides) =>
    act(async () => {
      root.render(React.createElement(QuotaHarness, quotaProps(overrides)));
      await settle();
    });
  await render({});
  assert.ok(banner(document));
  await render({ snapshot: { sessionId: 's1', busy: true } });
  assert.equal(banner(document), null, 'running');
  await render({ pendingPromptCount: 1 });
  assert.equal(banner(document), null, 'queued');
  await render({ settledItems: [...quotaStop(null), { kind: 'user', id: 'u3', text: 'next' }] });
  assert.equal(banner(document), null, 'a later turn');
});

test('an explicit whole carry refuses a chat the target model cannot hold; /inherit still compacts', async (t) => {
  const { document } = mount(t);
  const seen = [];
  document.defaultView.addEventListener(DESKTOP_TOAST_EVENT, (event) => seen.push(event.detail));
  document.defaultView.mixdogDesktop = {
    invokeCapability: async () => ({
      value: { known: true, fits: false, willCompact: true, used: 900, limit: 100, percent: 900 },
    }),
  };
  const carried = [];
  const inherit = async (...args) => {
    carried.push(args);
  };
  const route = { provider: 'openai-oauth', model: 'gpt-5.1' };
  assert.equal(await inheritSessionDirectly('s1', route, inherit, { compact: false }), false);
  assert.deepEqual(carried, []);
  assert.equal(seen.at(-1).tone, 'warn');
  assert.equal(
    seen.at(-1).text,
    translate('This chat is long, so it can only be forked to {{model}} as a summary.', { model: 'GPT-5.1' })
  );
  assert.equal(await inheritSessionDirectly('s1', route, inherit, { compact: true }), true);
  assert.equal(await inheritSessionDirectly('s1', route, inherit), true);
  assert.deepEqual(carried, [
    ['s1', route, { compact: true }],
    ['s1', route],
  ]);
});

test('a waiting resume shows the warning pill and expands into its panel', async (t) => {
  const { root, document } = mount(t);
  const calls = [];
  const resetAt = Date.now() + (2 * 60 + 15) * 60_000 - 1_000;
  await act(async () =>
    root.render(
      React.createElement(ComposerDock, {
        ...dockProps(),
        quotaResume: {
          model: 'Claude Opus',
          resetAt,
          onCancel: () => calls.push('cancel'),
        },
      })
    )
  );
  assert.equal(document.querySelector('.composer-island-quota'), null, 'collapsed until the pill is opened');
  const pill = document.querySelector('.composer-island-seg.composer-island-seg-warning');
  assert.ok(pill.querySelector('svg'), 'clock glyph');
  assert.match(pill.textContent, /Claude Opus/);
  assert.match(pill.textContent, new RegExp(quotaResetLabel(resetAt)));
  assert.match(
    pill.querySelector('.composer-island-seg-sub').textContent,
    new RegExp(translate('{{hours}}h {{minutes}}m', { hours: 2, minutes: 15 }).replace(/[()]/g, '.'))
  );

  await act(async () => pill.click());
  const panel = document.querySelector('.composer-island-quota');
  assert.ok(panel, 'D-2 panel');
  assert.match(
    panel.querySelector('.composer-island-ptitle').textContent,
    new RegExp(
      translate('Resumes automatically at {{time}} in {{model}}', {
        time: quotaResetLabel(resetAt),
        model: 'Claude Opus',
      })
    )
  );
  const buttons = [...panel.querySelectorAll('.composer-island-pfoot button')];
  assert.deepEqual(
    buttons.map((button) => button.textContent),
    [translate('Cancel resume')]
  );
  await act(async () => buttons[0].click());
  assert.deepEqual(calls, ['cancel']);

  await act(async () => root.render(React.createElement(ComposerDock, { ...dockProps(), quotaResume: null })));
  assert.equal(document.querySelector('.composer-island-seg-warning'), null, 'cancelled: pill gone');
});
