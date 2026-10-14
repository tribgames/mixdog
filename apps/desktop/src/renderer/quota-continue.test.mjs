import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { ComposerDock } from './ComposerDock.tsx';
import { defaultSessionLaneStore } from './session-lane-store.ts';
import { t as translate } from './i18n.ts';
import { OPEN_MODEL_PICKER_EVENT } from './model-picker-event.ts';
import {
  beginQuotaContinue,
  cancelQuotaContinue,
  latestQuotaFailure,
  quotaDismissKey,
  quotaPanelVisible,
  quotaRemainingLabel,
  quotaResetLabel,
  takeQuotaContinue,
} from './quota-continue.ts';
import { useConversationQuotaCard } from './use-conversation-quota-card.ts';
import { inheritSessionDirectly } from './session-inheritance.ts';
import { DESKTOP_TOAST_EVENT } from './desktop-toasts.tsx';
import { transcriptTurnKeys } from '../../../../src/tui/session/quota-resume.mjs';

const quota = { provider: 'anthropic', model: 'claude-opus', resetAt: null };
const failed = (extra = {}) => ({ kind: 'turndone', status: 'failed', quota, ...extra });
const keysFor = (items) => items.map(() => 'turn:u1');

test('quota failure: only the latest failed turndone with quota and no later turn', () => {
  const base = [{ kind: 'user', id: 'u1', text: 'hi' }];
  assert.deepEqual(latestQuotaFailure([...base, failed()], keysFor([...base, failed()])), {
    turnKey: 'turn:u1',
    quota,
  });
  const noQuota = [...base, { kind: 'turndone', status: 'failed' }];
  assert.equal(latestQuotaFailure(noQuota, keysFor(noQuota)), null);
  const done = [...base, failed({ status: 'done' })];
  assert.equal(latestQuotaFailure(done, keysFor(done)), null);
  const later = [...base, failed(), { kind: 'user', id: 'u2', text: 'again' }];
  assert.equal(latestQuotaFailure(later, keysFor(later)), null, 'a later turn hides it');
  assert.equal(latestQuotaFailure([], []), null);
});

test('panel visibility: idle, undismissed, quota present', () => {
  const failure = { turnKey: 'turn:u1', quota };
  const state = { failure, sessionId: 's1', busy: false, dismissedKey: '' };
  assert.equal(quotaPanelVisible(state), true);
  assert.equal(quotaPanelVisible({ ...state, failure: null }), false, 'no quota failure / a later turn');
  assert.equal(quotaPanelVisible({ ...state, busy: true }), false);
  assert.equal(quotaPanelVisible({ ...state, dismissedKey: quotaDismissKey('s1', 'turn:u1') }), false);
  assert.equal(quotaPanelVisible({ ...state, dismissedKey: quotaDismissKey('s1', 'turn:u0') }), true);
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

test('an applied pick, not an open or a close, completes the switch', (t) => {
  const { dom } = installTestDom(t, { expose: ['CustomEvent'], rootId: 'root' });
  const window = dom.window;
  globalThis.window = window;
  window.addEventListener(OPEN_MODEL_PICKER_EVENT, (event) => event.preventDefault());
  const picked = [];
  assert.equal(
    beginQuotaContinue('s1', (selection) => picked.push(selection)),
    true
  );
  assert.deepEqual(picked, [], 'opening the picker selects nothing');
  assert.equal(takeQuotaContinue('s2'), null, 'another session does not claim it');
  const route = { provider: 'openai', model: 'gpt' };
  takeQuotaContinue('s1')(route);
  assert.deepEqual(picked, [route]);
  assert.equal(takeQuotaContinue('s1'), null, 'one selection per continue');
  // Closing the picker without a selection cancels.
  beginQuotaContinue('s1', (selection) => picked.push(selection));
  cancelQuotaContinue('s1');
  assert.equal(takeQuotaContinue('s1'), null);
  assert.equal(picked.length, 1);
});

test('beginQuotaContinue reports an unanswered picker and arms nothing', (t) => {
  const { dom } = installTestDom(t, { expose: ['CustomEvent'], rootId: 'root' });
  globalThis.window = dom.window;
  assert.equal(
    beginQuotaContinue('s1', () => {}),
    false
  );
  assert.equal(takeQuotaContinue('s1'), null);
});

function mount(t) {
  const { dom, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'CustomEvent'],
    globals: {
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
    },
    rootId: 'root',
  });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
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

const cardButtons = (document) =>
  [...document.querySelectorAll('.composer-quota-card .composer-island-pfoot button')].map((button) => ({
    text: button.textContent,
    disabled: button.disabled,
    primary: button.classList.contains('composer-island-button-primary'),
  }));

test('the quota card sits between the island and the composer: resume at the reset, or switch model', async (t) => {
  const { root, document } = mount(t);
  const calls = [];
  const render = (quotaCard) =>
    act(async () => root.render(React.createElement(ComposerDock, { ...dockProps(), quotaCard })));
  await render(null);
  assert.equal(document.querySelector('.composer-quota-card'), null);

  const resetAt = Date.now() + (2 * 60 + 15) * 60_000 - 1_000;
  const card = {
    provider: 'Claude',
    resetAt,
    busy: false,
    onWait: () => calls.push('wait'),
    onSwitch: () => calls.push('switch'),
    onDismiss: () => calls.push('dismiss'),
  };
  await render(card);
  const section = document.querySelector('.composer-quota-card');
  const order = [...document.querySelector('.composer-region').children].map((child) => child.className);
  assert.deepEqual(order, ['composer-island-slot', 'composer-quota-card', 'composer-queue-tray', 'composer']);
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'pill', 'the island stays a pill');
  assert.equal(
    section.querySelector('.composer-island-ptitle').textContent,
    translate('{{provider}} usage limit reached', { provider: 'Claude' })
  );
  assert.ok(section.querySelector('.composer-island-ptitle svg'), 'warning glyph');
  assert.equal(
    section.querySelector('.composer-island-pnote').textContent,
    translate('Resets at {{time}} · {{remaining}} left.', {
      time: quotaResetLabel(resetAt),
      remaining: translate('{{hours}}h {{minutes}}m', { hours: 2, minutes: 15 }),
    })
  );
  assert.deepEqual(cardButtons(document), [
    { text: translate('Resume at {{time}}', { time: quotaResetLabel(resetAt) }), disabled: false, primary: false },
    { text: translate('Switch model'), disabled: false, primary: true },
  ]);
  for (const button of section.querySelectorAll('.composer-island-pfoot button')) {
    await act(async () => button.click());
  }
  await act(async () => section.querySelector('.composer-quota-card-close').click());
  assert.deepEqual(calls, ['wait', 'switch', 'dismiss']);

  // An unknown reset: no reset note and no resume, only the switch.
  await render({ ...card, resetAt: null, onWait: undefined });
  assert.equal(document.querySelector('.composer-quota-card .composer-island-pnote'), null);
  assert.deepEqual(cardButtons(document), [{ text: translate('Switch model'), disabled: false, primary: true }]);
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
  { kind: 'turndone', id: 'd2', status: 'failed', quota: { provider: 'anthropic-oauth', model: 'claude-opus', resetAt } },
];

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The host's quota calls, the picker, and the session's retry action. */
function quotaHost(t, document) {
  const host = { schedules: [], cancels: [], retries: [], pickerOpened: 0, retryResult: null };
  const window = document.defaultView;
  window.mixdogDesktop = {
    scheduleQuotaResume: async (sessionId) => {
      host.schedules.push(sessionId);
      return true;
    },
    cancelQuotaResume: async (sessionId) => {
      host.cancels.push(sessionId);
      return true;
    },
    invokeCapability: async ({ capability, sessionId, args }) => {
      assert.equal(capability, 'retryFailedTurn');
      assert.equal(sessionId, args[0]);
      host.retries.push(args[1]);
      return { value: await (host.retryResult ?? Promise.resolve(true)) };
    },
  };
  const opened = (event) => {
    host.pickerOpened += 1;
    event.preventDefault();
  };
  window.addEventListener(OPEN_MODEL_PICKER_EVENT, opened);
  t.after(() => window.removeEventListener(OPEN_MODEL_PICKER_EVENT, opened));
  return host;
}

function quotaProps(host, overrides = {}) {
  const settledItems = overrides.settledItems ?? quotaStop(null);
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

const picked = { provider: 'openai-oauth', model: 'gpt-5.1' };

test('switch model opens the picker; once the pick applied in place the stopped turn is retried once', async (t) => {
  const { root, document } = mount(t);
  const host = quotaHost(t, document);
  let finishRetry;
  host.retryResult = new Promise((resolve) => {
    finishRetry = resolve;
  });
  const resetAt = Date.now() + 3_600_000;
  await act(async () => {
    root.render(React.createElement(QuotaHarness, quotaProps(host, { settledItems: quotaStop(resetAt) })));
    await settle();
  });
  const switchButton = () => cardButtons(document).at(-1);
  assert.equal(switchButton().text, translate('Switch model'));
  await act(async () => document.querySelector('.composer-quota-card .composer-island-button-primary').click());
  assert.equal(host.pickerOpened, 1);
  assert.deepEqual(host.retries, [], 'nothing retries before a model is applied');

  // The picker applied another model to this chat (model-controls runs the
  // ordinary in-place route change first), then hands over.
  const applied = takeQuotaContinue('s1');
  assert.equal(takeQuotaContinue('s1'), null, 'one pick per switch');
  await act(async () => {
    applied(picked);
    applied(picked);
    await settle();
  });
  assert.deepEqual(host.retries, ['turn:u2'], 'the stopped turn runs exactly once');
  assert.ok(
    cardButtons(document).every(({ disabled }) => disabled),
    'every action waits while the retry is submitted'
  );
  await act(async () => document.querySelector('.composer-quota-card .composer-island-button-primary').click());
  assert.equal(host.pickerOpened, 1, 'no second switch while one runs');
  await act(async () => {
    finishRetry(true);
    await settle();
  });
  assert.ok(
    cardButtons(document).every(({ disabled }) => !disabled),
    'settled'
  );

  // Resume at the reset reserves it and closes the card.
  await act(async () => {
    document.querySelector('.composer-quota-card .composer-island-pfoot button').click();
    await settle();
  });
  assert.deepEqual(host.schedules, ['s1']);
  assert.equal(document.querySelector('.composer-quota-card'), null);
  assert.deepEqual(host.retries, ['turn:u2']);
});

test("the waiting resume panel's switch model runs the same in-place switch and single retry", async (t) => {
  const { root, document } = mount(t);
  const host = quotaHost(t, document);
  const resetAt = Date.now() + 3_600_000;
  const snapshot = {
    sessionId: 's1',
    quotaResume: { state: 'waiting', turnKey: 'turn:u2', provider: 'anthropic-oauth', model: 'claude-opus', resetAt },
  };
  await act(async () => {
    root.render(React.createElement(QuotaHarness, quotaProps(host, { snapshot, settledItems: quotaStop(resetAt) })));
    await settle();
  });
  // A reservation the runtime already made only needs the card closed.
  await act(async () => document.querySelector('.composer-quota-card .composer-island-pfoot button').click());
  assert.deepEqual(host.schedules, []);
  assert.equal(document.querySelector('.composer-quota-card'), null);
  await act(async () => document.querySelector('.composer-island-seg-warning').click());
  const panelButtons = [...document.querySelectorAll('.composer-island-quota .composer-island-pfoot button')];
  assert.deepEqual(
    panelButtons.map((button) => button.textContent),
    [translate('Cancel resume'), translate('Switch model')]
  );
  await act(async () => panelButtons[1].click());
  assert.equal(host.pickerOpened, 1);
  await act(async () => {
    takeQuotaContinue('s1')(picked);
    await settle();
  });
  assert.deepEqual(host.retries, ['turn:u2']);
  assert.deepEqual(host.cancels, [], 'the route change itself drops the reservation');
});

test('the retry is decided by the session, not by the last rendered snapshot', async (t) => {
  const { root, document } = mount(t);
  const host = quotaHost(t, document);
  const stopped = quotaStop(null);
  await act(async () => {
    root.render(React.createElement(QuotaHarness, quotaProps(host, { settledItems: stopped })));
    await settle();
  });
  await act(async () => document.querySelector('.composer-quota-card .composer-island-button-primary').click());
  // The route reply already carries a running newer turn, but React has not
  // committed it: the rendered card still looks idle on the stopped turn.
  // The request names the stopped turn and the session refuses it.
  host.retryResult = Promise.resolve(false);
  await act(async () => {
    takeQuotaContinue('s1')(picked);
    await settle();
  });
  assert.deepEqual(host.retries, ['turn:u2'], 'one request, keyed to the stopped turn');
  assert.ok(
    cardButtons(document).every(({ disabled }) => !disabled),
    'a refusal settles the card'
  );
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
          onContinue: () => calls.push('continue'),
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
    [translate('Cancel resume'), translate('Switch model')]
  );
  await act(async () => buttons[0].click());
  await act(async () => buttons[1].click());
  assert.deepEqual(calls, ['cancel', 'continue']);

  await act(async () => root.render(React.createElement(ComposerDock, { ...dockProps(), quotaResume: null })));
  assert.equal(document.querySelector('.composer-island-seg-warning'), null, 'cancelled: pill gone');
});
