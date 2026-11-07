// The first half of the operations that had no Rust op: section reads, ignored deletions, refused deletions and
// the browser surface notification.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DELETED_DESKTOP_OPERATIONS,
  IGNORED_DESKTOP_OPERATIONS,
  SECTION_READ_DESKTOP_OPERATIONS,
  createOperationLane,
} from './desktop-operation-route.ts';

const entry = (section, key, value) => ({ section, key, revision: 1, value });
function lane(entries, host = {}, status = 'ready') {
  const notified = [];
  const calls = [];
  return {
    notified,
    calls,
    lane: createOperationLane({
      protocol: {
        snapshot: () => ({ status, entries }),
        notify: (method, params) => notified.push({ method, params }),
        call: async (method, params) => calls.push({ method, params }),
      },
      host,
    }),
  };
}

const CONFIG = [
  entry('config', 'desktop', {
    keepAwake: false,
    activityRailPins: { revision: 4 },
    editor: { markdownDefaultView: 'rich' },
  }),
  entry('config', 'agent', { autoClear: { enabled: false } }),
  entry('config', 'notifications', {
    migratedAt: 100,
    devices: { pc: { scope: 'bots' } },
    overrides: [
      { target: { kind: 'agent', id: 'a1' }, setting: { mode: 'muted', until: null } },
      { target: { kind: 'agent', id: 'a2' }, setting: { mode: 'muted', until: 1 } },
      { target: { kind: 'bad', id: 'x' }, setting: { mode: 'always' } },
    ],
  }),
];

test('settings reads come from the held config sections and send nothing', async () => {
  const { lane: l, calls } = lane(CONFIG);
  const settings = await l.invoke('readSettings', []);
  assert.equal(settings.keepAwake, false);
  assert.equal(settings.autoClear, false);
  assert.equal((await l.invoke('readActivityRailPins', [])).revision, 4);
  assert.equal(await l.invoke('readZoom', []), 1);
  assert.equal(await l.invoke('readMarkdownDefaultView', ['/user']), 'rich');
  assert.deepEqual(calls, []);
});

test('an absent config subtree reads as Node reads an empty one; a connection that is not ready refuses', async () => {
  assert.equal(await lane([]).lane.invoke('readMarkdownDefaultView', []), 'preview');
  assert.equal((await lane([]).lane.invoke('readSettings', [])).keepAwake, true);
  await assert.rejects(lane(CONFIG, {}, 'reconnecting').lane.invoke('readSettings', []), /not ready/);
});

test('conversation overrides in force exclude expired mutes and invalid entries', async () => {
  const list = await lane(CONFIG).lane.invoke('listConversationNotifications', []);
  assert.deepEqual(list.map((row) => row.target.id), ['a1']);
});

test('the notification state lists this PC and the paired devices with defaults by kind and pairing time', async () => {
  const remote = entry('remote', null, {
    settings: { name: 'Desk' },
    pushRegistered: ['p-new'],
    clients: [
      { id: 'p-new', name: 'Pixel · Mixdog App', platform: 'Android', browser: 'Mixdog App', createdAt: 200, lastSeenAt: 1, online: true },
      { id: 'p-old', name: 'Old · Mixdog App', platform: 'Android', browser: 'Mixdog App', createdAt: 50, lastSeenAt: 1, online: false },
      { id: 'gone', name: 'X', platform: 'x', browser: 'Chrome', createdAt: 1, lastSeenAt: 1, online: false, pendingRemoval: true },
    ],
  });
  const { lane: l } = lane([...CONFIG, remote]);
  const state = await l.invoke('notificationPreferencesState', ['pc', true]);
  assert.equal(state.currentDeviceId, 'pc');
  assert.deepEqual(state.devices.map((d) => [d.id, d.kind, d.canNotify]), [
    ['pc', 'pc', true],
    ['p-new', 'phone-app', true],
    ['p-old', 'phone-app', false],
  ]);
  assert.equal(state.devices[0].name, 'Desk');
  assert.equal(state.preferences.pc.scope, 'bots');
  assert.equal(state.preferences['p-new'].scope, 'bots');
  assert.equal(state.preferences['p-old'].scope, 'all');
});

test('a null pcCanNotify is asked of the host, and refused when there is none', async () => {
  const withHost = lane(CONFIG, { pcNotificationsSupported: async () => false, hostName: () => 'box' });
  const state = await withHost.lane.invoke('notificationPreferencesState', ['pc', null]);
  assert.deepEqual([state.devices[0].name, state.devices[0].canNotify], ['box', false]);
  await assert.rejects(lane(CONFIG, { hostName: () => 'b' }).lane.invoke('notificationPreferencesState', ['pc', null]), /needs pcCanNotify/);
});

test('ignored deletions answer undefined and send nothing; refused ones are unknownMethod', async () => {
  const { lane: l, calls, notified } = lane([]);
  for (const name of IGNORED_DESKTOP_OPERATIONS) assert.equal(await l.invoke(name, ['desktop']), undefined);
  for (const name of Object.keys(DELETED_DESKTOP_OPERATIONS)) {
    await assert.rejects(l.invoke(name, []), { code: 'unknownMethod' }, name);
  }
  assert.deepEqual([calls, notified], [[], []]);
  assert.equal(SECTION_READ_DESKTOP_OPERATIONS.length, 6);
});

test('browserRemoteOpen is the notification host/browser/surface', async () => {
  const { lane: l, notified, calls } = lane([]);
  assert.equal(await l.invoke('browserRemoteOpen', [{ sessionId: 's1', hide: true }]), null);
  assert.deepEqual(notified, [{ method: 'host/browser/surface', params: { sessionId: 's1', hide: true } }]);
  assert.deepEqual(calls, []);
  await assert.rejects(l.invoke('browserRemoteOpen', [{}]), /sessionId/);
});
