// The "Time format" preference: stored locally, and its Intl options reshape
// every time of day (here: the settings "Today …" label) at format time.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

const { getTimeFormat, setTimeFormat, subscribeTimeFormat, timeFormatOptions } = await import(
  './time-format-preference.ts'
);

const AFTERNOON = new Date(2026, 9, 19, 14, 30);
const clock = (locale) =>
  AFTERNOON.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', ...timeFormatOptions() });

test('the preference defaults to the system clock and persists a choice', (t) => {
  const { window } = installTestDom(t, { actEnvironment: false });
  setTimeFormat('system');
  assert.equal(getTimeFormat(), 'system');
  assert.deepEqual(timeFormatOptions(), {});
  let changes = 0;
  const unsubscribe = subscribeTimeFormat(() => (changes += 1));
  assert.equal(setTimeFormat('24h'), true);
  assert.equal(window.localStorage.getItem('mixdog.desktop.time-format.v1'), '24h');
  assert.equal(getTimeFormat(), '24h');
  assert.deepEqual(timeFormatOptions(), { hourCycle: 'h23' });
  setTimeFormat('12h');
  assert.deepEqual(timeFormatOptions(), { hourCycle: 'h12' });
  unsubscribe();
  setTimeFormat('system');
  assert.equal(changes, 2);
  window.localStorage.setItem('mixdog.desktop.time-format.v1', 'bogus');
  assert.equal(getTimeFormat(), 'system');
});

test('system keeps each language’s own clock; 12h and 24h force it', (t) => {
  installTestDom(t, { actEnvironment: false });
  setTimeFormat('system');
  assert.equal(clock('en'), AFTERNOON.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' }));
  assert.match(clock('en'), /^2:30\sPM$/u);
  setTimeFormat('12h');
  assert.match(clock('en'), /^2:30\sPM$/u);
  assert.match(clock('ko'), /^오후 2:30$/u);
  setTimeFormat('24h');
  assert.equal(clock('en'), '14:30');
  assert.equal(clock('ko'), '14:30');
  setTimeFormat('system');
});

test('a stored 24-hour choice changes a rendered time', async (t) => {
  installTestDom(t, { actEnvironment: false });
  const { default: i18n } = await import('./i18n.ts');
  const previous = i18n.language;
  t.after(() => i18n.changeLanguage(previous));
  await i18n.changeLanguage('en');
  const { relativeWhen } = await import('./settings/relative-when.ts');
  const now = AFTERNOON.getTime() + 3_600_000;
  setTimeFormat('system');
  assert.match(relativeWhen(AFTERNOON.getTime(), now), /^Today 2:30\sPM$/u);
  setTimeFormat('24h');
  assert.equal(relativeWhen(AFTERNOON.getTime(), now), 'Today 14:30');
  setTimeFormat('system');
});

const MIDNIGHT = new Date(2026, 9, 19, 0, 5);
const midnight = (locale) =>
  MIDNIGHT.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', ...timeFormatOptions() });

test('ja and de follow 12h / 24h, midnight included', (t) => {
  installTestDom(t, { actEnvironment: false });
  setTimeFormat('12h');
  assert.match(midnight('ja'), /^午前12:05$/u);
  assert.match(midnight('de'), /^12:05\sAM$/u);
  setTimeFormat('24h');
  assert.equal(midnight('ja'), '0:05');
  assert.equal(midnight('de'), '0:05');
  setTimeFormat('system');
});

test('the hand-built quota-reset label and commit byline follow the preference', async (t) => {
  installTestDom(t, { actEnvironment: false });
  const { quotaResetLabel } = await import('./quota-continue.ts');
  const { formatCommitDate } = await import('./source-control-commit-detail.tsx');
  const now = new Date(2026, 9, 12, 9, 0).getTime();
  const reset = new Date(2026, 9, 13, 14, 5).getTime();
  const iso = new Date(2026, 9, 12, 14, 30).toISOString();
  setTimeFormat('system');
  assert.equal(quotaResetLabel(reset, now), '10/13 14:05');
  assert.equal(formatCommitDate(iso), '2026-10-12 14:30');
  setTimeFormat('12h');
  assert.match(quotaResetLabel(reset, now), /^10\/13 0?2:05\sPM$/u);
  assert.match(formatCommitDate(iso), /^2026-10-12 0?2:30\sPM$/u);
  setTimeFormat('24h');
  assert.equal(quotaResetLabel(reset, now), '10/13 14:05');
  assert.equal(formatCommitDate(iso), '2026-10-12 14:30');
  setTimeFormat('system');
});

test('the settings row reloads only after a saved change; a failed write shows an error', async (t) => {
  const { VirtualConsole } = await import('jsdom');
  const { default: React, act } = await import('react');
  const reloads = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => reloads.push(error.message));
  const { dom, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Element', 'Node', 'MouseEvent', 'PointerEvent', 'Event', 'KeyboardEvent'],
    rootId: 'root',
    jsdom: { virtualConsole },
  });
  dom.window.mixdogDesktop = new Proxy({}, { get: () => async () => undefined });
  const { DisplayPanel } = await import('./settings/general-panel.tsx');
  const { t: translate } = await import('./i18n.ts');
  setTimeFormat('system');
  await act(async () =>
    root.render(React.createElement(DisplayPanel, { data: {}, pending: '', run: async () => {}, api: {} }))
  );
  const document = dom.window.document;
  const pick = async (label) => {
    await act(async () => document.querySelector(`button[aria-label="${translate('Time format')}"]`).click());
    const option = [...document.querySelectorAll('[role="option"]')].find((n) => n.textContent === translate(label));
    await act(async () => option.click());
  };
  await pick('System default');
  assert.equal(reloads.length, 0, 'unchanged selection does not reload');
  const setItem = dom.window.Storage.prototype.setItem;
  dom.window.Storage.prototype.setItem = () => {
    throw new Error('quota');
  };
  await pick('24-hour');
  dom.window.Storage.prototype.setItem = setItem;
  assert.equal(reloads.length, 0, 'a failed write does not reload');
  assert.equal(document.querySelector('[role="alert"]').textContent, translate('The setting could not be saved.'));
  setTimeFormat('system');
  await pick('12-hour');
  assert.equal(reloads.length, 1, 'a saved change reloads once');
  setTimeFormat('system');
});
