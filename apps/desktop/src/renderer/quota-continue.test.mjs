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
  continueAfterQuota,
  latestQuotaFailure,
  quotaDismissKey,
  quotaIslandPlan,
  quotaPanelVisible,
  quotaRemainingLabel,
  quotaResetLabel,
  takeQuotaContinue,
} from './quota-continue.ts';

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

test('island plan: pill vs panel by quotaResume, setting and resetAt', () => {
  const known = { turnKey: 'turn:u1', quota: { ...quota, resetAt: 1_000 } };
  const unknown = { turnKey: 'turn:u1', quota };
  const base = { resume: null, failure: known, panelVisible: true, autoResume: false };
  assert.equal(quotaIslandPlan(base), 'panel-schedule', 'setting off + known reset');
  assert.equal(quotaIslandPlan({ ...base, failure: unknown }), 'panel', 'unknown reset keeps the two-button panel');
  assert.equal(quotaIslandPlan({ ...base, autoResume: true }), 'panel', 'setting on: runtime schedules by itself');
  assert.equal(quotaIslandPlan({ ...base, autoResume: null }), 'panel', 'setting not read yet');
  assert.equal(quotaIslandPlan({ ...base, panelVisible: false }), 'none');
  assert.equal(quotaIslandPlan({ ...base, failure: null }), 'none');
  const waiting = { state: 'waiting' };
  assert.equal(quotaIslandPlan({ ...base, resume: waiting }), 'resume', 'waiting replaces the panel');
  assert.equal(quotaIslandPlan({ ...base, resume: waiting, panelVisible: false, failure: null }), 'resume');
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

test('continue flow: switch the model, then retry; media-only prompts stay switched', async () => {
  const calls = [];
  const steps = (switched, retried) => ({
    switchModel: async () => {
      calls.push('switch');
      return switched;
    },
    retry: async () => {
      calls.push('retry');
      return retried;
    },
  });
  assert.equal(await continueAfterQuota(steps(true, true)), 'retried');
  assert.deepEqual(calls, ['switch', 'retry']);
  calls.length = 0;
  assert.equal(await continueAfterQuota(steps(true, false)), 'switched', 'a refused retry is not reported as retried');
  calls.length = 0;
  assert.equal(await continueAfterQuota(steps(undefined, true)), 'failed');
  assert.deepEqual(calls, ['switch'], 'no retry when the switch failed');
});

test('the picker selection, not an open or a close, completes the continue', (t) => {
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
    expose: ['HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent'],
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

test('the quota panel shows title, both notes, and two right-aligned buttons; it beats the mismatch', async (t) => {
  const { root, document } = mount(t);
  const calls = [];
  const render = (quotaExhausted) =>
    act(async () =>
      root.render(
        React.createElement(ComposerDock, {
          ...dockProps(),
          modelMismatch: { sessionModel: 'A', selectedModel: 'B', onRevert() {}, onContinue() {} },
          quotaExhausted,
        })
      )
    );
  await render(null);
  assert.equal(document.querySelector('.composer-island-quota'), null);
  assert.ok(document.querySelector('.composer-island-seg-model'), 'mismatch segment without quota');

  await render({
    provider: 'Claude',
    resetAt: new Date(2026, 9, 12, 18, 40).getTime() + 86_400_000 * 3,
    onDismiss: () => calls.push('dismiss'),
    onContinue: () => calls.push('continue'),
  });
  const panel = document.querySelector('.composer-island-panel.composer-island-quota');
  assert.ok(panel);
  assert.equal(document.querySelector('.composer-island-model'), null, 'quota wins over the mismatch panel');
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'panel');
  assert.equal(
    panel.querySelector('.composer-island-ptitle').textContent,
    translate('{{provider}} usage limit reached', { provider: 'Claude' })
  );
  assert.ok(panel.querySelector('.composer-island-ptitle svg'), 'warning glyph');
  assert.match(panel.querySelector('.composer-island-pnote').textContent, /18:40/);
  const buttons = [...panel.querySelectorAll('.composer-island-pfoot button')];
  assert.deepEqual(
    buttons.map((button) => button.textContent),
    [translate('Keep stopped'), translate('Continue in another model')]
  );
  assert.ok(buttons[1].classList.contains('composer-island-button-primary'));
  await act(async () => buttons[0].click());
  await act(async () => buttons[1].click());
  assert.deepEqual(calls, ['dismiss', 'continue']);

  await render({ provider: 'OpenAI', resetAt: null, onDismiss() {}, onContinue() {} });
  assert.equal(
    document.querySelector('.composer-island-quota .composer-island-pnote').textContent,
    translate('No reset time is available. Continuing in another model carries on this chat as it is.')
  );

  await render(null);
  assert.equal(document.querySelector('.composer-island-quota'), null, 'dismissed or answered: panel gone');
});

test('the panel offers a scheduling button between the two others only when onSchedule is given', async (t) => {
  const { root, document } = mount(t);
  const calls = [];
  const resetAt = new Date(2026, 9, 12, 18, 40).getTime();
  await act(async () =>
    root.render(
      React.createElement(ComposerDock, {
        ...dockProps(),
        quotaExhausted: {
          provider: 'Claude',
          resetAt,
          onDismiss() {},
          onContinue() {},
          onSchedule: () => calls.push('schedule'),
        },
      })
    )
  );
  const buttons = [...document.querySelectorAll('.composer-island-quota .composer-island-pfoot button')];
  assert.deepEqual(
    buttons.map((button) => button.textContent),
    [
      translate('Keep stopped'),
      translate('Auto-resume at {{time}}', { time: quotaResetLabel(resetAt) }),
      translate('Continue in another model'),
    ]
  );
  assert.ok(buttons[2].classList.contains('composer-island-button-primary'));
  await act(async () => buttons[1].click());
  assert.deepEqual(calls, ['schedule']);
});

test('a waiting resume shows the warning pill instead of the panel and expands into D-2', async (t) => {
  const { root, document } = mount(t);
  const calls = [];
  const resetAt = Date.now() + (2 * 60 + 15) * 60_000 - 1_000;
  await act(async () =>
    root.render(
      React.createElement(ComposerDock, {
        ...dockProps(),
        quotaExhausted: { provider: 'Claude', resetAt, onDismiss() {}, onContinue() {} },
        quotaResume: {
          model: 'Claude Opus',
          resetAt,
          onCancel: () => calls.push('cancel'),
          onContinue: () => calls.push('continue'),
        },
      })
    )
  );
  assert.equal(document.querySelector('.composer-island-quota'), null, 'no A panel while waiting');
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
    [translate('Cancel resume'), translate('Continue in another model')]
  );
  await act(async () => buttons[0].click());
  await act(async () => buttons[1].click());
  assert.deepEqual(calls, ['cancel', 'continue']);

  await act(async () => root.render(React.createElement(ComposerDock, { ...dockProps(), quotaResume: null })));
  assert.equal(document.querySelector('.composer-island-seg-warning'), null, 'cancelled: pill gone');
});
