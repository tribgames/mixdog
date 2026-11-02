import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { BrowserPagePrompts } from './BrowserPagePrompts.tsx';
import { t } from './i18n.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function render(context) {
  const { dom } = installTestDom(null, {
    html: '<!doctype html><html><body><main></main></body></html>',
    expose: ['HTMLElement', 'Node'],
    actEnvironment: false,
  });
  const root = createRoot(document.querySelector('main'));
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  return (props) => act(async () => root.render(React.createElement(BrowserPagePrompts, props)));
}

const chooser = (id, devices) => ({
  url: 'https://launcher.test/app',
  dialog: {
    id,
    type: 'permission',
    message: '',
    permission: { origin: 'https://launcher.test', keys: ['hid'], devices },
  },
});

test('a HID chooser connects only the device a person picks', async (context) => {
  const show = render(context);
  const sent = [];
  const control = async (action) => sent.push(action);
  const devices = [
    { id: 'hid-1', name: 'Keyboard' },
    { id: 'hid-2', name: '' },
  ];
  await show({ frame: chooser('permission_1', devices), control });
  const connect = () => document.querySelector('footer .primary');
  const radios = () => [...document.querySelectorAll('.browser-device-list input[type="radio"]')];
  assert.equal(connect().textContent, t('Connect'));
  assert.equal(connect().disabled, true, 'nothing is connected before a pick');
  assert.deepEqual(
    radios().map((radio) => radio.closest('label').textContent),
    ['Keyboard', t('Unknown device')]
  );
  await act(async () => radios()[1].click());
  assert.equal(radios()[1].checked, true);
  assert.equal(connect().disabled, false);

  // The picked device was unplugged: the pick goes with it.
  await show({ frame: chooser('permission_1', devices.slice(0, 1)), control });
  assert.equal(connect().disabled, true);
  await act(async () => radios()[0].click());
  await act(async () => connect().click());
  assert.deepEqual(sent, [
    { type: 'answer-dialog', requestId: 'permission_1', accept: true, promptText: '', deviceId: 'hid-1' },
  ]);

  // A new chooser starts unpicked; with no devices it says how to add one.
  await show({ frame: chooser('permission_2', []), control });
  assert.equal(
    document.querySelector('.browser-device-empty').textContent,
    t('No devices to connect. Connect a device to this PC and it appears here.')
  );
  assert.equal(connect().disabled, true);
  await act(async () => document.querySelector('footer button:not(.primary)').click());
  assert.deepEqual(sent.at(-1), { type: 'answer-dialog', requestId: 'permission_2', accept: false });
});
