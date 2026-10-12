import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from './test-support/test-dom.mjs';
import { AppUpdateBanner, appUpdateView } from './AppUpdateBanner.tsx';

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
    assert.equal(ready.title, 'v1.4.0 downloaded');
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

