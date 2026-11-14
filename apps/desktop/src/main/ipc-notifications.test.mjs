import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_IPC } from '../shared/contract';
import { registerNotificationIpc } from './ipc-notifications';

const REMOTE = {
  clients: [
    { id: 'phone', name: 'Pixel · Mixdog App', platform: 'Android', browser: 'Mixdog App', createdAt: 6000, lastSeenAt: 1, online: true },
  ],
  pushRegistered: ['phone'],
  settings: { name: 'Studio PC' },
};

function setup({ notifications, supported = true, fail } = {}) {
  const handlers = new Map();
  const calls = [];
  const operations = [];
  const core = {
    call: async (method, params) => {
      calls.push([method, params]);
      if (fail?.[method]) throw fail[method];
      if (method === 'remoteAccess/state') return REMOTE;
      if (method === 'notify/state') return { supported, notifications };
      if (method === 'notify/test') return { ok: true };
      return {};
    },
  };
  registerNotificationIpc({
    handle: (channel, listener) => handlers.set(channel, listener),
    invokeDesktopOperation: async (method, args) => {
      operations.push([method, args]);
      return [];
    },
    core,
  });
  return { handlers, calls, operations };
}

test('getNotificationPreferences answers the devices and stored preferences from notify/state', async () => {
  const stored = { version: 1, migratedAt: 100, devices: { pc: { scope: 'off' } }, overrides: [] };
  const { handlers, calls } = setup({ notifications: stored, supported: false });
  const state = await handlers.get(DESKTOP_IPC.getNotificationPreferences)({});
  assert.deepEqual(calls.map(([method]) => method), ['remoteAccess/state', 'notify/state']);
  assert.equal(state.currentDeviceId, 'pc');
  assert.deepEqual(state.devices.map((device) => [device.id, device.name, device.canNotify]), [
    ['pc', 'Studio PC', false],
    ['phone', 'Pixel', true],
  ]);
  assert.equal(state.preferences.pc.scope, 'off');
  assert.equal(state.preferences.phone.scope, 'bots');
});

test('a null stored document reads as defaults', async () => {
  const { handlers } = setup({ notifications: null });
  const state = await handlers.get(DESKTOP_IPC.getNotificationPreferences)({});
  assert.equal(state.preferences.pc.scope, 'all');
  assert.equal(state.preferences.phone.scope, 'all');
});

test('setNotificationPreferences writes the key, announces, then answers the state', async () => {
  const { handlers, calls } = setup({ notifications: { version: 1, migratedAt: 100, devices: {}, overrides: [] } });
  await handlers.get(DESKTOP_IPC.setNotificationPreferences)({}, 'phone', { scope: 'all' });
  const methods = calls.map(([method]) => method);
  assert.deepEqual(methods.slice(2), ['config/value/write', 'ui/settings/announce', 'remoteAccess/state', 'notify/state']);
  assert.deepEqual(calls[2][1], { path: 'notifications.devices.phone', value: { scope: 'all' }, mode: 'mergePatchBots' });
  assert.deepEqual(calls[3][1], { scope: 'notifications' });
});

test('a device that is not paired is refused before anything is written', async () => {
  const { handlers, calls } = setup({ notifications: null });
  await assert.rejects(handlers.get(DESKTOP_IPC.setNotificationPreferences)({}, 'ghost', { scope: 'all' }), /not paired/);
  assert.ok(!calls.some(([method]) => method === 'config/value/write'));
});

test('sendTestNotification asks notify/test for the device, this PC included', async () => {
  const { handlers, calls } = setup();
  assert.deepEqual(await handlers.get(DESKTOP_IPC.sendTestNotification)({}, 'pc'), { ok: true });
  assert.deepEqual(calls, [['notify/test', { target: 'pc' }]]);
});

test('conversation overrides stay desktop operations', async () => {
  const { handlers, operations } = setup();
  await handlers.get(DESKTOP_IPC.listConversationNotifications)({});
  await handlers.get(DESKTOP_IPC.setConversationNotification)({}, { kind: 'agent', id: 'a1' }, { mode: 'always' });
  assert.deepEqual(operations, [
    ['listConversationNotifications', []],
    ['setConversationNotification', [{ kind: 'agent', id: 'a1' }, { mode: 'always' }]],
  ]);
});

test('a core failure rejects the call', async () => {
  const { handlers } = setup({ fail: { 'notify/test': new Error('link down') } });
  await assert.rejects(handlers.get(DESKTOP_IPC.sendTestNotification)({}, 'pc'));
});

test('without a core connection the calls fail', async () => {
  const handlers = new Map();
  registerNotificationIpc({ handle: (c, l) => handlers.set(c, l), invokeDesktopOperation: async () => [] });
  await assert.rejects(handlers.get(DESKTOP_IPC.getNotificationPreferences)({}), /core connection/);
});
