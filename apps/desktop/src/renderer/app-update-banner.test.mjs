import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from './test-support/test-dom.mjs';
import { AppUpdateBanner, appUpdateView, isAppUpdatePending, phoneAppUpdateView } from './AppUpdateBanner.tsx';
import { RailUpdateSlot, useRailUpdate } from './RailUpdateSlot.tsx';
import { PhoneUpdatePanel } from './settings/phone-app-update-group.tsx';

const base = { installed: '1.3.2', version: '1.4.0' };
const labels = (view) => view.actions.map((a) => a.label);

test('state → view mapping', () => {
  assert.equal(appUpdateView(null), null);
  for (const status of ['idle', 'checking', 'up-to-date']) assert.equal(appUpdateView({ ...base, status }), null);
  assert.equal(appUpdateView({ ...base, status: 'available', dismissed: true }), null);

  const available = appUpdateView({ ...base, status: 'available' });
  assert.equal(available.title, 'Mixdog app v1.4.0 is available');
  assert.equal(available.sub, 'Currently installed: v1.3.2');
  assert.deepEqual(labels(available), ['Update', 'Later']);

  const downloading = appUpdateView({
    ...base,
    status: 'downloading',
    receivedBytes: 18.4 * 1024 * 1024,
    totalBytes: 42.7 * 1024 * 1024,
  });
  assert.equal(downloading.title, 'Downloading v1.4.0…');
  assert.equal(downloading.sub, '18.4 MB / 42.7 MB · 43%');
  assert.equal(downloading.progress, 43);
  assert.deepEqual(labels(downloading), ['Cancel']);

  for (const status of ['ready', 'needs-permission']) {
    const ready = appUpdateView({ ...base, status });
    assert.equal(ready.title, 'Phone app v1.4.0 is ready to install');
    assert.equal(ready.sub, 'Currently installed: v1.3.2');
    assert.deepEqual(labels(ready), ['Install', 'Later']);
    assert.ok(ready.actions.every((a) => !a.disabled));
  }
  assert.ok(appUpdateView({ ...base, status: 'installing' }).actions.every((a) => a.disabled));
  assert.equal(appUpdateView({ ...base, status: 'ready' }, 'ready'), null);

  const failed = appUpdateView({ ...base, status: 'failed', error: 'storage' });
  assert.equal(failed.role, 'alert');
  assert.equal(failed.sub, 'Not enough storage space for the update');
  assert.deepEqual(labels(failed), ['Try again', 'Get in browser']);
  assert.ok(failed.closable);
});

function mount(t, native) {
  const { root, document, window } = installTestDom(t, { rootId: 'root', expose: ['Event'] });
  if (native) window.mixdogNative = native;
  return { root, document, window };
}

const absent = [
  ['old shell answering null', { platform: 'android', version: '1', call: () => Promise.resolve(null) }],
  ['call rejecting', { platform: 'android', version: '1', call: () => Promise.reject(new Error('timeout')) }],
  ['ios', { platform: 'ios', version: '1', call: () => Promise.resolve({ ...base, status: 'available' }) }],
  ['no bridge', undefined],
];
for (const [name, native] of absent) {
  test(`renders nothing: ${name}`, async (t) => {
    const { root, document } = mount(t, native);
    await act(async () => root.render(React.createElement(AppUpdateBanner)));
    assert.equal(document.querySelector('.app-update-banner'), null);
  });
}

test('android banner follows the native event and drives the bridge', async (t) => {
  let state = { ...base, status: 'available' };
  const calls = [];
  const native = {
    platform: 'android',
    version: '1',
    call: (method, args) => {
      calls.push(method);
      if (method === 'startAppUpdate') state = { ...base, status: 'downloading', receivedBytes: 1, totalBytes: 2 };
      return Promise.resolve(method === 'openAppUpdateInBrowser' ? true : state);
    },
  };
  const { root, document, window } = mount(t, native);
  await act(async () => root.render(React.createElement(AppUpdateBanner)));
  const banner = document.querySelector('.app-update-banner');
  assert.ok(banner);
  assert.equal(banner.querySelectorAll('.mx-button').length, 2);
  assert.equal(banner.querySelector('.mx-button.is-primary').textContent, 'Update');
  await act(async () => banner.querySelector('.mx-button.is-primary').click());
  assert.ok(calls.includes('startAppUpdate'));
  assert.equal(document.querySelector('.app-update-banner').dataset.kind, 'downloading');
  state = { ...base, status: 'up-to-date' };
  await act(async () => window.dispatchEvent(new window.Event('mixdognativeupdate')));
  assert.equal(document.querySelector('.app-update-banner'), null);
});

test('"Later" hides the toast for this page session only and never dismisses', async (t) => {
  const calls = [];
  let state = { ...base, status: 'available' };
  const native = {
    platform: 'android',
    version: '1',
    call: (method) => {
      calls.push(method);
      return Promise.resolve(state);
    },
  };
  const { root, document, window } = mount(t, native);
  await act(async () => root.render(React.createElement(AppUpdateBanner)));
  const later = [...document.querySelectorAll('.app-update-banner .mx-button')].find((b) => b.textContent === 'Later');
  await act(async () => later.click());
  assert.equal(document.querySelector('.app-update-banner'), null);
  assert.ok(!calls.includes('dismissAppUpdate'));
  await act(async () => window.dispatchEvent(new window.Event('mixdognativeupdate')));
  assert.equal(document.querySelector('.app-update-banner'), null);
  state = { ...base, status: 'ready' };
  await act(async () => window.dispatchEvent(new window.Event('mixdognativeupdate')));
  assert.ok(document.querySelector('.app-update-banner'));
});

test('no toast while the shell downloads automatically', () => {
  const auto = { ...base, status: 'downloading', auto: true, receivedBytes: 1, totalBytes: 2 };
  assert.equal(appUpdateView(auto), null);
  assert.ok(appUpdateView({ ...auto, auto: false }));
});

test('update slot shows for available, downloading and ready only', () => {
  assert.equal(isAppUpdatePending(null), false);
  for (const status of ['idle', 'checking', 'up-to-date', 'failed'])
    assert.equal(isAppUpdatePending({ ...base, status }), false, status);
  assert.equal(isAppUpdatePending({ ...base, status: 'available' }), true);
  assert.equal(isAppUpdatePending({ ...base, status: 'available', dismissed: true }), true);
  assert.equal(isAppUpdatePending({ ...base, status: 'downloading' }), true);
  assert.equal(isAppUpdatePending({ ...base, status: 'ready' }), true);
  assert.equal(isAppUpdatePending({ ...base, status: 'needs-permission' }), true);
});

function Harness({ desktopState, installDesktop, openSettings }) {
  return React.createElement(RailUpdateSlot, { update: useRailUpdate(desktopState, installDesktop, openSettings) });
}

function androidNative(getState, calls) {
  return {
    platform: 'android',
    version: '1',
    call: (method) => {
      calls.push(method);
      return Promise.resolve(getState());
    },
  };
}

test('rail slot (phone app): follows the native state and ignores the PC updater', async (t) => {
  let state = { ...base, status: 'ready' };
  const calls = [];
  const opened = [];
  const { root, document, window } = mount(
    t,
    androidNative(() => state, calls)
  );
  const pcReady = { status: 'ready', version: '9.9.9' };
  const render = () =>
    root.render(
      React.createElement(Harness, {
        desktopState: pcReady,
        installDesktop: () => calls.push('pc'),
        openSettings: (s) => opened.push(s),
      })
    );
  await act(async () => render());
  const slot = () => document.querySelector('.rail-update-slot');
  assert.equal(slot().getAttribute('aria-label'), 'Phone app v1.4.0 install');
  await act(async () => slot().click());
  assert.ok(calls.includes('installAppUpdate'));
  assert.ok(!calls.includes('pc'));
  state = { ...base, status: 'downloading', receivedBytes: 62, totalBytes: 100 };
  await act(async () => window.dispatchEvent(new window.Event('mixdognativeupdate')));
  assert.equal(slot().getAttribute('aria-label'), 'Phone app v1.4.0 downloading 62%');
  assert.ok(slot().querySelector('.rail-update-ring'));
  await act(async () => slot().click());
  assert.deepEqual(opened, ['update']);
  state = { ...base, status: 'available' };
  await act(async () => window.dispatchEvent(new window.Event('mixdognativeupdate')));
  await act(async () => slot().click());
  assert.equal(calls.at(-1), 'startAppUpdate');
  state = { ...base, status: 'up-to-date' };
  await act(async () => window.dispatchEvent(new window.Event('mixdognativeupdate')));
  assert.equal(slot(), null);
});

test('rail slot (desktop): reads the desktop updater', async (t) => {
  const { root, document } = mount(t, undefined);
  const calls = [];
  const opened = [];
  const show = (desktopState) =>
    act(async () =>
      root.render(
        React.createElement(Harness, {
          desktopState,
          installDesktop: () => calls.push('install'),
          openSettings: (s) => opened.push(s),
        })
      )
    );
  const slot = () => document.querySelector('.rail-update-slot');
  for (const status of ['disabled', 'idle', 'checking', 'up-to-date']) {
    await show({ status });
    assert.equal(slot(), null, status);
  }
  await show({ status: 'error', message: 'x' });
  assert.equal(slot(), null);
  await show({ status: 'ready', version: '1.2.7' });
  assert.equal(slot().getAttribute('aria-label'), 'Mixdog v1.2.7 install');
  await act(async () => slot().click());
  assert.deepEqual(calls, ['install']);
  await show({ status: 'downloading', version: '1.2.7', percent: 40 });
  assert.equal(slot().getAttribute('aria-label'), 'Mixdog v1.2.7 downloading 40%');
  await act(async () => slot().click());
  assert.deepEqual(opened, ['update']);
  await show({ status: 'downloading', version: '1.2.7' });
  assert.equal(slot().getAttribute('aria-label'), 'Mixdog v1.2.7 downloading');
});

test('settings view mirrors the host updater rows', () => {
  const at = new Date(2026, 9, 19, 9, 48).getTime();
  const view = (state) => {
    const v = phoneAppUpdateView(state, '0.1.17');
    return [v.current, v.latest, v.install.id, v.install.label, v.busy];
  };
  assert.deepEqual(view(null), ['0.1.17', '0.1.17', null, 'Check for update', false]);
  assert.deepEqual(
    view({ ...base, status: 'up-to-date' }),
    ['1.3.2', '1.3.2', null, 'Up to date', false].map((x, i) => (i === 1 ? '1.4.0' : x))
  );
  assert.deepEqual(view({ ...base, status: 'checking' }), ['1.3.2', '1.4.0', null, 'Checking for update…', true]);
  // dismissed is ignored: the update can always be started from settings
  assert.deepEqual(view({ ...base, status: 'available', dismissed: true }), [
    '1.3.2',
    '1.4.0',
    'start',
    'Update to v1.4.0',
    false,
  ]);
  assert.deepEqual(view({ ...base, status: 'downloading', auto: true, receivedBytes: 62, totalBytes: 100 }), [
    '1.3.2',
    '1.4.0',
    null,
    'Downloading v1.4.0… 62%',
    true,
  ]);
  assert.deepEqual(view({ ...base, status: 'ready' }), ['1.3.2', '1.4.0', 'install', 'Update to v1.4.0', false]);
  assert.deepEqual(view({ ...base, status: 'installing' }), ['1.3.2', '1.4.0', null, 'Installing v1.4.0…', false]);
  assert.deepEqual(view({ ...base, status: 'failed', error: 'network' }), [
    '1.3.2',
    '1.4.0',
    'start',
    'Try again',
    false,
  ]);
  assert.equal(phoneAppUpdateView({ ...base, status: 'failed' }).note, "Couldn't download the update");
  const failedCheck = phoneAppUpdateView({
    installed: '1.3.2',
    status: 'idle',
    lastCheckError: 'network',
    lastCheckAt: at,
  });
  assert.match(failedCheck.note, /^Couldn't check for updates · last tried .*9:48/u);
  assert.equal(
    phoneAppUpdateView({ installed: '1.3.2', status: 'idle', lastCheckError: 'network' }).note,
    "Couldn't check for updates"
  );
  assert.equal(phoneAppUpdateView({ ...base, status: 'up-to-date' }).note, '');
});

for (const [name, native] of [
  ['no bridge', undefined],
  ['ios', { platform: 'ios', version: '1', call: () => Promise.resolve({ ...base, status: 'available' }) }],
]) {
  test(`phone update group hidden: ${name}`, async (t) => {
    const { root, document } = mount(t, native);
    await act(async () => root.render(React.createElement(PhoneUpdatePanel)));
    assert.equal(document.querySelector('.settings-group'), null);
  });
}

test('phone update group drives the bridge and refreshes on the event', async (t) => {
  let state = { installed: '1.3.2', status: 'up-to-date', version: '1.3.2', dismissed: true };
  const calls = [];
  const native = {
    platform: 'android',
    version: '1.3.2',
    call: (method, args) => {
      calls.push([method, args]);
      if (method === 'getAppUpdate' && args?.check) state = { ...base, status: 'available', dismissed: true };
      if (method === 'startAppUpdate') state = { ...base, status: 'downloading', receivedBytes: 1, totalBytes: 4 };
      return Promise.resolve(state);
    },
  };
  const { root, document, window } = mount(t, native);
  await act(async () => root.render(React.createElement(PhoneUpdatePanel)));
  const text = () => document.querySelector('.settings-group').textContent;
  assert.match(text(), /Update \(phone app\)/u);
  assert.match(text(), /Current version.*1\.3\.2/u);
  assert.ok(!/Auto-update/u.test(text()));
  const buttons = () => [...document.querySelectorAll('.settings-resource-actions button')];
  assert.deepEqual(
    buttons().map((b) => b.textContent),
    ['Check now', 'Up to date']
  );
  assert.equal(buttons()[1].disabled, true);
  await act(async () => buttons()[0].click());
  assert.deepEqual(calls.at(-1), ['getAppUpdate', { check: true }]);
  assert.equal(buttons()[1].textContent, 'Update to v1.4.0');
  await act(async () => buttons()[1].click());
  assert.equal(calls.at(-1)[0], 'startAppUpdate');
  assert.equal(buttons()[1].textContent, 'Downloading v1.4.0… 25%');
  assert.equal(buttons()[0].disabled, true);
  state = { ...base, status: 'ready' };
  await act(async () => window.dispatchEvent(new window.Event('mixdognativeupdate')));
  assert.equal(buttons()[1].textContent, 'Update to v1.4.0');
  await act(async () => buttons()[1].click());
  assert.equal(calls.at(-1)[0], 'installAppUpdate');
});
