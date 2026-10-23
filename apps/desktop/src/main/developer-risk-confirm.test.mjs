import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVELOPER_SECTIONS } from '../../../../src/runtime/shared/developer-options.mjs';
import { DESKTOP_IPC } from '../shared/contract.ts';
import { createAllowAllActionsConfirm, isAllowAllActionsEnable } from './developer-risk-confirm.ts';
import { beginComputerOperation } from './human-only-approval.ts';
import { registerWindowSettingsIpc } from './ipc-window-settings.ts';
import { assertRemoteCapabilityCall } from './remote-methods.ts';

const option = DEVELOPER_SECTIONS.flatMap((section) => section.options).find((entry) => entry.id === 'allowAllActions');
const settle = () => new Promise((resolve) => setImmediate(resolve));

function deferredDialog() {
  const shown = [];
  let answer = () => {};
  return {
    shown,
    answer: (response) => answer({ response }),
    dialog: {
      showMessageBox: (_window, options) => {
        shown.push(options);
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    },
  };
}
const liveWindow = { isDestroyed: () => false };

test('only turning ON allowAllActions needs the person', () => {
  assert.equal(isAllowAllActionsEnable('setDeveloperOption', ['allowAllActions', true]), true);
  assert.equal(isAllowAllActionsEnable('setDeveloperOption', ['allowAllActions', false]), false);
  assert.equal(isAllowAllActionsEnable('setDeveloperOption', ['cursorOAuth', true]), false);
  assert.equal(isAllowAllActionsEnable('getDeveloperSettings', ['allowAllActions', true]), false);
  assert.equal(isAllowAllActionsEnable('setDeveloperOption', []), false);
});

test('the native confirmation shows the registry label and warning and defaults to cancel', async () => {
  const fake = deferredDialog();
  const confirm = createAllowAllActionsConfirm({ dialog: fake.dialog, window: liveWindow, nativeT: (key) => key });
  const pending = confirm();
  await settle();
  const [options] = fake.shown;
  assert.equal(options.message, option.label);
  assert.equal(options.detail, option.warning);
  assert.equal(options.buttons[options.defaultId], 'Cancel');
  assert.equal(options.cancelId, options.defaultId);
  fake.answer(0);
  assert.equal(await pending, true);
});

test('while the confirmation is open Computer Use is refused, so it cannot answer it; an agent op in flight goes first', async () => {
  const fake = deferredDialog();
  const confirm = createAllowAllActionsConfirm({ dialog: fake.dialog, window: liveWindow, nativeT: (key) => key });
  // A Computer Use operation already running delays the dialog until it ends.
  const release = beginComputerOperation();
  const pending = confirm();
  await settle();
  assert.equal(fake.shown.length, 0, 'not shown while Computer Use is mid-operation');
  assert.throws(() => beginComputerOperation(), /human-only approval is pending/, 'no new operation queues behind it');
  release();
  await settle();
  assert.equal(fake.shown.length, 1);
  assert.throws(() => beginComputerOperation(), /human-only approval is pending/, 'refused while the dialog is open');
  fake.answer(1);
  assert.equal(await pending, false, 'Cancel does not turn it on');
  beginComputerOperation()();
});

test('a destroyed window or a closed dialog does not turn it on', async () => {
  const fake = deferredDialog();
  const gone = createAllowAllActionsConfirm({
    dialog: fake.dialog,
    window: { isDestroyed: () => true },
    nativeT: (key) => key,
  });
  assert.equal(await gone(), false);
  assert.equal(fake.shown.length, 0);
});

function windowHost() {
  const handlers = new Map();
  const calls = [];
  const host = {
    invokeCapability: async (capability, args) => {
      calls.push([capability, args]);
      return { value: capability };
    },
    readCapabilities: async () => [],
    getSnapshot: () => ({}),
  };
  return {
    handlers,
    calls,
    register: (extra = {}) =>
      registerWindowSettingsIpc({
        window: { webContents: { setZoomFactor() {}, send() {} }, setTitleBarOverlay() {} },
        app: {},
        host,
        handle: (channel, handler) => handlers.set(channel, handler),
        invokeDesktopOperation: async () => undefined,
        readsLocalOnboardingStatus: false,
        ...extra,
      }),
    invoke: (capability, args) => handlers.get(DESKTOP_IPC.invokeCapability)({}, { capability, args }),
  };
}

test('the renderer cannot turn on allowAllActions without the main-process confirmation', async () => {
  // No confirmation wired: refused, and the host never sees the write.
  const bare = windowHost();
  bare.register();
  await bare.invoke('setDeveloperOption', ['allowAllActions', true]);
  assert.deepEqual(bare.calls, [['getDeveloperSettings', []]]);

  // Declined: unchanged. Accepted: forwarded once.
  const answers = [false, true];
  const asked = [];
  const wired = windowHost();
  wired.register({
    confirmAllowAllActions: async () => {
      asked.push(true);
      return answers.shift();
    },
  });
  await wired.invoke('setDeveloperOption', ['allowAllActions', true]);
  assert.deepEqual(wired.calls, [['getDeveloperSettings', []]]);
  await wired.invoke('setDeveloperOption', ['allowAllActions', true]);
  assert.deepEqual(wired.calls.at(-1), ['setDeveloperOption', ['allowAllActions', true]]);
  assert.equal(asked.length, 2);

  // Turning it off and other options never ask.
  await wired.invoke('setDeveloperOption', ['allowAllActions', false]);
  await wired.invoke('setDeveloperOption', ['cursorOAuth', true]);
  assert.equal(asked.length, 2);
  assert.deepEqual(wired.calls.slice(-2), [
    ['setDeveloperOption', ['allowAllActions', false]],
    ['setDeveloperOption', ['cursorOAuth', true]],
  ]);
});

test('a paired remote client cannot turn on allowAllActions but can turn it off', () => {
  assert.throws(
    () => assertRemoteCapabilityCall('setDeveloperOption', ['allowAllActions', true]),
    /cannot turn on Allow all actions over remote access/
  );
  assertRemoteCapabilityCall('setDeveloperOption', ['allowAllActions', false]);
  assertRemoteCapabilityCall('setDeveloperOption', ['cursorOAuth', true]);
});
