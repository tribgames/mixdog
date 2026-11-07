// setNotificationPreferences end to end against Node: the lane's answer must equal what Node's own notification center
// answered for the same stored state, devices and patch. Needs the notificationPreferencesState section read of
// desktop-ops-new-a (the lane asks it for the state after the write).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createNotificationCenter } from '../notification-center.ts';
import { createNotificationPreferencesStore } from '../notification-preferences.ts';
import { createOperationLane } from './desktop-operation-route.ts';

const NOW = 5_000;
// Paired devices as Node lists them (DesktopRemoteClientInfo) and as the core's `remote` section carries them
// (mixdog-remote ClientInfo: the same fields, camelCase).
const clients = [
  { id: 'phone', name: 'Pixel · Mixdog App', platform: 'Android', browser: 'Mixdog App', createdAt: 6_000, lastSeenAt: 6_500, online: true },
  { id: 'older', name: 'Tab · Chrome', platform: 'Windows', browser: 'Chrome', createdAt: 100, lastSeenAt: 200, online: false, alias: 'Desk' },
  { id: 'leaving', name: 'Old · Mixdog App', platform: 'iOS', browser: 'Mixdog App', createdAt: 7_000, lastSeenAt: 7_000, online: false, pendingRemoval: true },
];
const PC_NAME = 'Studio PC';

function nodeCenter(dir) {
  const store = createNotificationPreferencesStore({
    filePath: join(dir, 'notification-preferences.json'),
    readLegacy: async () => ({ turnNotifications: true, mutedAgents: [] }),
    now: () => NOW,
  });
  const center = createNotificationCenter({
    store,
    pcName: () => PC_NAME,
    listClients: async () => clients,
    pushRegistrations: async () => new Set(['phone']),
    pcSupported: async () => true,
    sendPcTest: async () => ({ ok: true }),
    sendDeviceTest: async () => ({ ok: true }),
  });
  return { store, center, file: join(dir, 'notification-preferences.json') };
}

const document = (file) => {
  const { version, ...rest } = JSON.parse(readFileSync(file, 'utf8'));
  void version;
  return rest;
};

test('setNotificationPreferences answers the notification state Node answered for the same write', async () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'notification-lane-'));
  for (const [deviceId, patch] of [
    ['phone', { events: { error: false }, quietHours: { enabled: true, start: '22:00', end: '07:00' } }],
    ['older', { scope: 'off' }],
    ['pc', { taskbarFlash: false }],
  ]) {
    // Node: the write, then the state, on a store that starts like the lane's.
    const node = nodeCenter(dir());
    await node.store.ready();
    const initial = document(node.file);
    const expected = await node.center.setPreferences('pc', true, deviceId, patch);

    // The core's document after the same write (its merge is the Rust test's subject): Node's, taken before it
    // read the state back, so defaults Node writes for other devices on reading are not in it.
    const written = nodeCenter(dir());
    await written.store.ready();
    const info = deviceId === 'pc' ? { kind: 'pc' } : undefined;
    await written.store.setDevice(deviceId, patch, info ?? (deviceId === 'phone' ? { kind: 'phone-app', pairedAt: 6_000 } : { kind: 'browser', pairedAt: 100 }));
    const after = document(written.file);

    let notifications = initial;
    const entries = () => [
      { section: 'remote', key: null, revision: 1, value: { settings: { name: PC_NAME }, clients, pushRegistered: ['phone'] } },
      { section: 'config', key: 'notifications', revision: 1, value: notifications },
    ];
    const calls = [];
    const lane = createOperationLane({
      protocol: {
        notify: () => {},
        snapshot: () => ({ status: 'ready', entries: entries() }),
        call: async (method, params) => {
          calls.push({ method, params });
          notifications = after;
          return { revision: 2, values: [after.devices[deviceId]] };
        },
      },
    });
    const answered = await lane.invoke('setNotificationPreferences', ['pc', true, deviceId, patch]);
    assert.deepEqual(answered, expected, deviceId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'config/value/write');
  }
});

test('setNotificationPreferences for a device that is not paired is refused as Node refused it, and writes nothing', async () => {
  const node = nodeCenter(mkdtempSync(join(tmpdir(), 'notification-lane-')));
  await assert.rejects(node.center.setPreferences('pc', true, 'stranger', {}), /That device is not paired with this PC/);
  const calls = [];
  const lane = createOperationLane({
    protocol: {
      notify: () => {},
      snapshot: () => ({ status: 'ready', entries: [{ section: 'remote', key: null, revision: 1, value: { clients } }] }),
      call: async (method) => {
        calls.push(method);
        return {};
      },
    },
  });
  for (const id of ['stranger', 'leaving']) {
    await assert.rejects(lane.invoke('setNotificationPreferences', ['pc', true, id, {}]), /That device is not paired with this PC/);
  }
  assert.deepEqual(calls, []);
});
