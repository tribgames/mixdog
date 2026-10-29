import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from '../test-support/test-dom.mjs';
import { setCachedConnectionInfo } from './connection-info.ts';
import { ConnectionPanel } from './connection-panel.tsx';
import { NotificationsPanel } from './notification-panel.tsx';
import { SETTINGS_CATEGORIES, settingsCategoriesForSurface } from './settings-items.ts';

const DOM = { rootId: 'root', expose: ['HTMLElement', 'Node', 'KeyboardEvent', 'Event', 'CustomEvent'] };
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));
const flat = (text) => text.replace(/\s/g, ' ');

const prefs = (over = {}) => ({
  scope: 'all',
  events: { finished: true, question: true, approval: true, error: false },
  automaticRuns: true,
  quietHours: { enabled: false, start: '23:00', end: '08:00', days: 'every', allowWaiting: false },
  holdWhileDesktopActive: false,
  taskbarFlash: true,
  ...over,
});

function makeState(currentDeviceId = 'pc') {
  return {
    currentDeviceId,
    devices: [
      { id: 'pc', name: 'This PC', kind: 'pc', online: true, canNotify: true },
      { id: 'c1', name: 'Galaxy S24', kind: 'phone-app', online: true, canNotify: true },
      { id: 'c2', name: 'Office laptop', kind: 'browser', online: false, canNotify: true },
      { id: 'c3', name: 'iPad', kind: 'phone-app', online: false, canNotify: false },
    ],
    preferences: {
      pc: prefs(),
      c1: prefs({
        scope: 'bots',
        quietHours: { enabled: true, start: '23:00', end: '08:00', days: 'every', allowWaiting: false },
      }),
      c2: prefs(),
      c3: prefs(),
    },
  };
}

function makeApi(state = makeState(), { failWrites = false } = {}) {
  const calls = [];
  const api = {
    getNotificationPreferences: () => Promise.resolve(structuredClone(state)),
    setNotificationPreferences: (id, patch) => {
      calls.push([id, patch]);
      if (failWrites) return Promise.reject(new Error('no'));
      const old = state.preferences[id];
      state.preferences[id] = {
        ...old,
        ...patch,
        events: { ...old.events, ...patch.events },
        quietHours: { ...old.quietHours, ...patch.quietHours },
      };
      return Promise.resolve(structuredClone(state));
    },
    sendTestNotification: (id) => {
      calls.push(['test', id]);
      return Promise.resolve({ ok: true, message: 'Sent to Galaxy S24.' });
    },
  };
  return { api, calls, state };
}

async function mountPanel(t, made, props = {}, { globals, prepare } = {}) {
  const dom = installTestDom(t, { ...DOM, globals });
  prepare?.(dom.window);
  await act(async () => dom.root.render(React.createElement(NotificationsPanel, { api: made.api, ...props })));
  await settle();
  return dom;
}

const checkbox = (document, label) => document.querySelector(`input[aria-label="${label}"]`);
const combo = (document, label) => document.querySelector(`button[role="combobox"][aria-label="${label}"]`);
const clickEl = (element) => act(async () => element.click());
async function choose(document, label, option) {
  await clickEl(combo(document, label));
  await clickEl(
    [...document.querySelectorAll('[role="listbox"] [role="option"]')].find((o) => o.textContent.trim() === option)
  );
  await settle();
}
const groupTitles = (document) =>
  [...document.querySelectorAll('.settings-group > header h3')].map((h) => h.textContent);

test('Notifications sits right after Bots in Basics and shows on this PC and on paired devices', () => {
  const values = SETTINGS_CATEGORIES.map((category) => category.value);
  assert.equal(values[values.indexOf('bots') + 1], 'notifications');
  assert.equal(SETTINGS_CATEGORIES.find((category) => category.value === 'notifications').group, 'Basics');
  for (const remote of [false, true]) {
    for (const open of [false, true]) {
      assert.ok(settingsCategoriesForSurface(remote, open).some((category) => category.value === 'notifications'));
    }
  }
});

test('the panel starts on this PC with every group, and the device picker lists the others', async (t) => {
  const { document } = await mountPanel(t, makeApi());
  assert.deepEqual(groupTitles(document), ['Conversations to notify', 'What to notify', 'Quiet hours', 'On this PC']);
  assert.equal(document.querySelector('.notif-device-button b').textContent, 'This PC');
  await clickEl(document.querySelector('.notif-device-button'));
  const options = [...document.querySelectorAll('.notif-device-list [role="option"]')];
  assert.deepEqual(
    options.map((option) => flat(option.textContent)),
    [
      'This PCThis computer',
      'Galaxy S24Phone app · Online',
      'Office laptopWeb browser · Offline',
      'iPadNotifications off — allow them on that device',
    ]
  );
  assert.equal(options[3].getAttribute('aria-disabled'), 'true');
  assert.match(document.querySelector('.notif-device-head').textContent, /Connected devices/);
  await clickEl(options[3]);
  assert.equal(
    document.querySelector('.notif-device-button b').textContent,
    'This PC',
    'a muted device is not selectable'
  );
  await clickEl(document.querySelector('.notif-device-list [data-device="c1"]'));
  assert.equal(document.querySelector('.notif-device-button b').textContent, 'Galaxy S24');
  assert.deepEqual(groupTitles(document).slice(-1), ['On this device']);
  assert.equal(combo(document, 'Notification scope').textContent, 'Bot chats only');
});

test('the footer link opens Settings › Connection', async (t) => {
  const opened = [];
  const { document } = await mountPanel(t, makeApi(), { openCategory: (category) => opened.push(category) });
  await clickEl(document.querySelector('.notif-device-button'));
  await clickEl(document.querySelector('.notif-device-foot button'));
  assert.deepEqual(opened, ['connection']);
});

test('a paired device starts on itself', async (t) => {
  const own = await mountPanel(t, makeApi(makeState('c1')));
  assert.equal(own.document.querySelector('.notif-device-button b').textContent, 'Galaxy S24');
});

test('every control writes its patch for the selected device', async (t) => {
  const made = makeApi();
  const { document } = await mountPanel(t, made);
  await choose(document, 'Notification scope', 'Off');
  await clickEl(checkbox(document, 'When a reply finishes'));
  await clickEl(checkbox(document, 'When a question arrives'));
  await clickEl(checkbox(document, 'When an approval is requested'));
  await clickEl(checkbox(document, 'When a turn stops on an error'));
  await clickEl(checkbox(document, 'Schedule and webhook results'));
  await clickEl(checkbox(document, 'Taskbar flash'));
  assert.deepEqual(made.calls, [
    ['pc', { scope: 'off' }],
    ['pc', { events: { finished: false } }],
    ['pc', { events: { question: false } }],
    ['pc', { events: { approval: false } }],
    ['pc', { events: { error: true } }],
    ['pc', { automaticRuns: false }],
    ['pc', { taskbarFlash: false }],
  ]);
  await settle();
  assert.equal(checkbox(document, 'When a reply finishes').checked, false, 'the re-read state shows the change');
});

test('approval items read as the app’s approval waits: 승인 요청이 왔을 때, and 승인 대기 marks', async (t) => {
  const { document } = await mountPanel(t, makeApi());
  const quietNote =
    'No notifications on this device in this window. Missed items stay as unread and “Approval needed” or “Answer needed” marks.';
  assert.ok(checkbox(document, 'When an approval is requested'));
  assert.ok(document.body.textContent.includes(quietNote));
  const ko = JSON.parse(readFileSync(new URL('../locales/ko.json', import.meta.url), 'utf8'));
  assert.equal(ko['When an approval is requested'], '승인 요청이 왔을 때');
  assert.match(ko[quietNote], /“승인 대기”/);
  assert.doesNotMatch(ko[quietNote], /확인 필요/);
});

test('quiet hours: toggle, 30-minute localized times, days and the waiting exception', async (t) => {
  const made = makeApi();
  const { document } = await mountPanel(t, made);
  assert.equal(flat(combo(document, 'Quiet hours start').textContent), '11:00 PM');
  assert.equal(flat(combo(document, 'Quiet hours end').textContent), '8:00 AM');
  await clickEl(checkbox(document, 'Use quiet hours'));
  await clickEl(combo(document, 'Quiet hours start'));
  const times = [...document.querySelectorAll('[role="listbox"] [role="option"]')].map((o) =>
    flat(o.textContent.trim())
  );
  assert.equal(times.length, 48);
  assert.deepEqual(times.slice(0, 3), ['12:00 AM', '12:30 AM', '1:00 AM']);
  await clickEl(
    [...document.querySelectorAll('[role="listbox"] [role="option"]')].find(
      (o) => flat(o.textContent.trim()) === '10:30 PM'
    )
  );
  await choose(document, 'Quiet hours end', '7:00 AM');
  await choose(document, 'Days', 'Weekdays');
  await clickEl(checkbox(document, 'Still notify questions and approvals'));
  assert.deepEqual(made.calls, [
    ['pc', { quietHours: { enabled: true } }],
    ['pc', { quietHours: { start: '22:30' } }],
    ['pc', { quietHours: { end: '07:00' } }],
    ['pc', { quietHours: { days: 'weekdays' } }],
    ['pc', { quietHours: { allowWaiting: true } }],
  ]);
});

test('a paired device shows the device group, not the PC group, and sends a test notification', async (t) => {
  const made = makeApi(makeState('c1'));
  const { document } = await mountPanel(t, made);
  assert.equal(document.body.textContent.includes('Taskbar flash'), false);
  assert.equal(document.body.textContent.includes('On this PC'), false);
  await clickEl(checkbox(document, 'Skip if seen on this PC'));
  assert.deepEqual(made.calls, [['c1', { holdWhileDesktopActive: true }]]);
  const send = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send');
  await clickEl(send);
  await settle();
  assert.deepEqual(made.calls[1], ['test', 'c1']);
  assert.equal(document.querySelector('[role="status"]').textContent, 'Sent to Galaxy S24.');
});

test('a failed write rolls the control back', async (t) => {
  const made = makeApi(makeState(), { failWrites: true });
  const { document } = await mountPanel(t, made);
  await clickEl(checkbox(document, 'Taskbar flash'));
  await settle();
  assert.equal(made.calls.length, 1);
  assert.equal(checkbox(document, 'Taskbar flash').checked, true);
});

/** An API whose writes and reads wait for the test to answer them. */
function deferredApi(state) {
  const made = makeApi(state);
  const writes = [];
  made.api.setNotificationPreferences = (id, patch) => {
    made.calls.push([id, patch]);
    const gate = Promise.withResolvers();
    writes.push({ id, patch, ...gate });
    return gate.promise;
  };
  const reads = [];
  made.api.getNotificationPreferences = () => {
    const snapshot = structuredClone(made.state);
    const gate = Promise.withResolvers();
    reads.push({ snapshot, ...gate });
    return gate.promise;
  };
  return { ...made, writes, reads };
}
const answerRead = async (read) => {
  read.resolve(read.snapshot);
  await settle();
};

test('overlapping writes: a failed one drops only its own change, in order', async (t) => {
  const made = deferredApi(makeState());
  const { document } = await mountPanel(t, made);
  await answerRead(made.reads[0]);
  await clickEl(checkbox(document, 'Taskbar flash'));
  await clickEl(checkbox(document, 'When a reply finishes'));
  assert.equal(made.writes.length, 1, 'the second write waits for the first');
  assert.equal(checkbox(document, 'Taskbar flash').checked, false);
  assert.equal(checkbox(document, 'When a reply finishes').checked, false);
  await act(async () => made.writes[0].reject(new Error('no')));
  await settle();
  assert.equal(made.writes.length, 2);
  assert.equal(checkbox(document, 'Taskbar flash').checked, true, 'the failed change is undone');
  assert.equal(checkbox(document, 'When a reply finishes').checked, false, 'the other change stays');
  made.state.preferences.pc.events.finished = false;
  await act(async () => made.writes[1].resolve(structuredClone(made.state)));
  await settle();
  assert.equal(checkbox(document, 'Taskbar flash').checked, true);
  assert.equal(checkbox(document, 'When a reply finishes').checked, false);
});

test('a settings broadcast that arrives mid-write does not undo the edit', async (t) => {
  const made = deferredApi(makeState());
  const { document } = await mountPanel(t, made);
  await answerRead(made.reads[0]);
  await clickEl(checkbox(document, 'Taskbar flash'));
  const { announceSetupChange } = await import('../setup-change-refresh.ts');
  await act(async () => announceSetupChange('settings_changed'));
  assert.equal(made.reads.length, 2);
  await answerRead(made.reads[1]); // a snapshot from before the write
  assert.equal(checkbox(document, 'Taskbar flash').checked, false, 'the stale read is ignored');
  made.state.preferences.pc.taskbarFlash = false;
  await act(async () => made.writes[0].resolve(structuredClone(made.state)));
  await settle();
  assert.equal(checkbox(document, 'Taskbar flash').checked, false);
});

test('a change broadcast during a failing write shows once the queue drains', async (t) => {
  const made = deferredApi(makeState());
  const { document } = await mountPanel(t, made);
  await answerRead(made.reads[0]);
  await clickEl(checkbox(document, 'Taskbar flash'));
  made.state.preferences.pc.scope = 'bots'; // another window changed it
  const { announceSetupChange } = await import('../setup-change-refresh.ts');
  await act(async () => announceSetupChange('settings_changed'));
  await answerRead(made.reads[1]);
  assert.equal(combo(document, 'Notification scope').textContent, 'All conversations', 'held back during the write');
  assert.equal(made.reads.length, 2);
  await act(async () => made.writes[0].reject(new Error('no')));
  await settle();
  assert.equal(made.reads.length, 3, 'the discarded read is redone');
  await answerRead(made.reads[2]);
  assert.equal(combo(document, 'Notification scope').textContent, 'Bot chats only');
  assert.equal(checkbox(document, 'Taskbar flash').checked, true);
});

test('a failed older volume save does not undo a newer value', async (t) => {
  const made = makeApi();
  const saves = [];
  made.api.readSettings = () => Promise.resolve({ notificationVolume: 100 });
  made.api.setNotificationVolume = (volume) => {
    const gate = Promise.withResolvers();
    saves.push({ volume, ...gate });
    return gate.promise;
  };
  made.api.previewNotificationSound = () => Promise.resolve('');
  const { document, window } = await mountPanel(t, made, {}, { globals: { navigator: { userAgent: 'Windows' } } });
  const slider = () => document.querySelector('input[type="range"]');
  const move = (value) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(slider(), value);
      slider().dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const play = () => clickEl([...document.querySelectorAll('button')].find((b) => b.textContent === 'Play test sound'));
  await move('250');
  await play();
  await move('300');
  await play();
  assert.deepEqual(
    saves.map((save) => save.volume),
    [250, 300]
  );
  await act(async () => saves[0].reject(new Error('no')));
  await settle();
  assert.equal(slider().value, '300', 'the newer edit stays');
  await act(async () => saves[1].resolve({ notificationVolume: 300 }));
  await settle();
  assert.equal(slider().value, '300');
});

test('the device you are on stays selectable while unregistered, and keeps its registration control', async (t) => {
  const state = makeState('c3');
  const made = makeApi(state);
  made.api.pushPublicKey = async () => 'key';
  const { document } = await mountPanel(
    t,
    made,
    {},
    {
      globals: { navigator: { serviceWorker: { ready: new Promise(() => {}) }, userAgent: '' } },
      prepare: (window) => {
        window.isSecureContext = true;
        window.Notification = { permission: 'default' };
        window.PushManager = {};
      },
    }
  );
  const registration = () => checkbox(document, 'Allow notifications on this device');
  assert.equal(document.querySelector('.notif-device-button b').textContent, 'iPad');
  assert.ok(registration());
  await clickEl(document.querySelector('.notif-device-button'));
  await clickEl(document.querySelector('.notif-device-list [data-device="pc"]'));
  assert.equal(registration(), null);
  await clickEl(document.querySelector('.notif-device-button'));
  const own = document.querySelector('.notif-device-list [data-device="c3"]');
  assert.equal(own.getAttribute('aria-disabled'), null);
  await clickEl(own);
  assert.equal(document.querySelector('.notif-device-button b').textContent, 'iPad');
  assert.ok(registration());
});

test('a rejected volume save puts the slider back on the saved volume', async (t) => {
  const made = makeApi();
  made.api.readSettings = () => Promise.resolve({ notificationVolume: 100 });
  made.api.setNotificationVolume = () => Promise.reject(new Error('no'));
  made.api.previewNotificationSound = () => Promise.resolve('');
  const { document, window } = await mountPanel(
    t,
    made,
    {},
    {
      globals: { navigator: { userAgent: 'Windows' } },
    }
  );
  const slider = () => document.querySelector('input[type="range"]');
  assert.equal(slider().value, '100');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(slider(), '250');
    slider().dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assert.equal(slider().value, '250');
  await clickEl([...document.querySelectorAll('button')].find((b) => b.textContent === 'Play test sound'));
  await settle();
  assert.equal(slider().value, '100');
  assert.equal(document.querySelector('.notification-volume-control output').textContent, '100%');
});

test('the Connection tab lists devices without a notification line', async (t) => {
  const dom = installTestDom(t, DOM);
  const made = makeApi();
  const device = (id, name) => ({
    id,
    name,
    platform: 'Android',
    browser: 'Mixdog App',
    createdAt: 1,
    lastSeenAt: 2,
    online: true,
  });
  const info = {
    relayBrowserUrl: 'https://relay.example/d/a/',
    relayBrowserQrSvg: '<svg></svg>',
    relayAppQrSvg: '<svg></svg>',
    relayConnectUrl: 'https://relay.example/connect',
    clients: [device('c1', 'Galaxy S24'), device('c2', 'Office laptop'), device('c3', 'iPad')],
    enabled: true,
  };
  made.state.preferences.c2 = prefs({ scope: 'off' });
  const api = { ...made.api, getRemoteAccessInfo: () => Promise.resolve(info) };
  setCachedConnectionInfo(api, info);
  await act(async () => dom.root.render(React.createElement(ConnectionPanel, { api })));
  await settle();
  const rows = [...dom.document.querySelectorAll('.conn-list .conn-row')];
  assert.equal(rows.length, 3);
  for (const row of rows) assert.doesNotMatch(row.textContent, /Notifications/);
});

test('a failed first read shows the error with a retry that loads the panel', async (t) => {
  const made = makeApi();
  const read = made.api.getNotificationPreferences;
  let fail = true;
  made.api.getNotificationPreferences = () => (fail ? Promise.reject(new Error('connection lost')) : read());
  const { document } = await mountPanel(t, made);
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, 'the failure is announced');
  assert.match(alert.textContent, /connection lost/);
  assert.deepEqual(groupTitles(document), []);
  fail = false;
  await clickEl([...alert.querySelectorAll('button')].find((button) => button.textContent.includes('Retry')));
  await settle();
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.equal(groupTitles(document).length, 4);
});

test('a failed write shows its error and rolls the control back', async (t) => {
  const { document } = await mountPanel(t, makeApi(makeState(), { failWrites: true }));
  const toggle = checkbox(document, 'Taskbar flash');
  assert.equal(toggle.checked, true);
  await clickEl(toggle);
  await settle();
  assert.equal(checkbox(document, 'Taskbar flash').checked, true, 'rolled back');
  assert.match(document.querySelector('[role="alert"]').textContent, /no/);
});
