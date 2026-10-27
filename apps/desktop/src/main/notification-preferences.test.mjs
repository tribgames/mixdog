import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NEW_PHONE_NOTIFICATION_PREFERENCES,
} from '../shared/contract-notifications.ts';
import { createNotificationCenter, notificationDeviceName } from './notification-center.ts';
import {
  createNotificationPreferencesStore,
  legacyAgentMutePath,
  notificationPreferencesPath,
  readLegacyMutedAgents,
  readPcNotificationView,
} from './notification-preferences.ts';

const MIGRATED_AT = 5_000;

function profile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-notify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function store(dir, legacy = {}, now = { value: MIGRATED_AT }, onChange = () => {}) {
  return createNotificationPreferencesStore({
    filePath: notificationPreferencesPath(dir),
    readLegacy: async () => ({
      turnNotifications: legacy.turnNotifications ?? true,
      mutedAgents: readLegacyMutedAgents(legacyAgentMutePath(dir)),
    }),
    now: () => now.value,
    onChange,
  });
}

test('concurrent writes of devices, overrides and a revoke all land', async (t) => {
  const dir = profile(t);
  const prefs = store(dir);
  await prefs.setDevice('gone', { scope: 'off' });
  await Promise.all([
    prefs.setDevice('a', { scope: 'off' }),
    prefs.setDevice('b', { scope: 'bots' }),
    prefs.setDevice('a', { taskbarFlash: false }),
    prefs.setConversation({ kind: 'agent', id: 'gh' }, { mode: 'muted', until: null }),
    prefs.setConversation({ kind: 'room', id: 'r1' }, { mode: 'always' }),
    prefs.removeDevice('gone'),
    prefs.devices([{ id: 'c', info: { kind: 'phone-app', pairedAt: MIGRATED_AT + 1 } }]),
  ]);
  const reloaded = store(dir);
  const a = await reloaded.device('a');
  assert.equal(a.scope, 'off');
  assert.equal(a.taskbarFlash, false);
  assert.equal((await reloaded.device('b')).scope, 'bots');
  assert.equal((await reloaded.device('c')).scope, 'bots');
  assert.deepEqual((await reloaded.overrides()).map((entry) => entry.target.id).sort(), ['gh', 'r1']);
  const stored = JSON.parse(readFileSync(notificationPreferencesPath(dir), 'utf8'));
  assert.equal(Object.hasOwn(stored.devices, 'gone'), false);
});

test('every persisted change is announced exactly once; a no-op is not', async (t) => {
  const changes = [];
  const prefs = store(profile(t), {}, { value: MIGRATED_AT }, () => changes.push('notifications'));
  await prefs.ready();
  assert.equal(changes.length, 0, 'loading is not a change');
  await prefs.setDevice('a', { scope: 'off' });
  assert.equal(changes.length, 1);
  await prefs.setConversation({ kind: 'agent', id: 'gh' }, { mode: 'always' });
  assert.equal(changes.length, 2);
  await prefs.devices([{ id: 'new', info: { kind: 'browser' } }]);
  assert.equal(changes.length, 3, 'a listed device’s default was written');
  await prefs.devices([{ id: 'new', info: { kind: 'browser' } }]);
  assert.equal(changes.length, 3, 'nothing new to write');
  await prefs.removeDevice('a');
  assert.equal(changes.length, 4);
  await prefs.removeDevice('a');
  assert.equal(changes.length, 4, 'already gone');
});

test('a device resolved by its pairing record keeps that default; an unknown record stays unwritten', async (t) => {
  const changes = [];
  const prefs = store(profile(t), {}, { value: MIGRATED_AT }, () => changes.push('notifications'));
  const lookups = [];
  const record = (info) => async () => {
    lookups.push(info);
    return info;
  };
  assert.equal(
    (await prefs.resolveDevice('old', record({ kind: 'phone-app', pairedAt: MIGRATED_AT - 1 }))).scope,
    'all'
  );
  assert.equal(
    (await prefs.resolveDevice('new', record({ kind: 'phone-app', pairedAt: MIGRATED_AT + 1 }))).scope,
    'bots'
  );
  assert.equal(changes.length, 2);
  // Stored now: no further lookups.
  assert.equal((await prefs.resolveDevice('new', record(null))).scope, 'bots');
  assert.equal(lookups.length, 2);
  assert.equal((await prefs.resolveDevice('unknown', record(null))).scope, 'all');
  assert.equal(changes.length, 2, 'nothing known, nothing written');
});

test('first load migrates: notifications off becomes scope off, every muted bot a mute with no end', async (t) => {
  const dir = profile(t);
  writeFileSync(legacyAgentMutePath(dir), JSON.stringify({ muted: ['gh', 'rel'] }));
  const prefs = store(dir, { turnNotifications: false });
  await prefs.ready();
  assert.equal((await prefs.device('pc')).scope, 'off');
  assert.deepEqual(await prefs.overrides(), [
    { target: { kind: 'agent', id: 'gh' }, setting: { mode: 'muted', until: null } },
    { target: { kind: 'agent', id: 'rel' }, setting: { mode: 'muted', until: null } },
  ]);
  // The window process reads the same file.
  const view = readPcNotificationView(notificationPreferencesPath(dir), MIGRATED_AT);
  assert.equal(view.preferences.scope, 'off');
  assert.equal(view.overrides.length, 2);
  // Migration runs once: a later legacy change is not read again.
  writeFileSync(legacyAgentMutePath(dir), JSON.stringify({ muted: [] }));
  const again = store(dir, { turnNotifications: true });
  assert.equal((await again.device('pc')).scope, 'off');
  assert.equal((await again.overrides()).length, 2);
});

test('with notifications on and nobody muted, this PC starts at the defaults', async (t) => {
  const dir = profile(t);
  const prefs = store(dir);
  assert.deepEqual(await prefs.device('pc'), DEFAULT_NOTIFICATION_PREFERENCES);
  assert.deepEqual(await prefs.overrides(), []);
  assert.equal(JSON.parse(readFileSync(notificationPreferencesPath(dir), 'utf8')).migratedAt, MIGRATED_AT);
});

test('devices paired before the migration and browsers get the defaults; a new phone app gets bot chats only', async (t) => {
  const prefs = store(profile(t));
  await prefs.ready();
  assert.deepEqual(
    await prefs.device('old-phone', { kind: 'phone-app', pairedAt: MIGRATED_AT - 1 }),
    DEFAULT_NOTIFICATION_PREFERENCES
  );
  assert.deepEqual(
    await prefs.device('new-phone', { kind: 'phone-app', pairedAt: MIGRATED_AT }),
    NEW_PHONE_NOTIFICATION_PREFERENCES
  );
  assert.deepEqual(
    await prefs.device('new-tab', { kind: 'browser', pairedAt: MIGRATED_AT + 1 }),
    DEFAULT_NOTIFICATION_PREFERENCES
  );
  assert.deepEqual(await prefs.device('unknown', { kind: 'phone-app' }), DEFAULT_NOTIFICATION_PREFERENCES);
});

test('a listed device keeps the default it was shown, and a patch merges into it', async (t) => {
  const dir = profile(t);
  const prefs = store(dir);
  const listed = await prefs.devices([{ id: 'p1', info: { kind: 'phone-app', pairedAt: MIGRATED_AT + 10 } }]);
  assert.equal(listed.p1.scope, 'bots');
  // Later lookups without the pairing time read the stored entry.
  assert.equal((await prefs.device('p1', { kind: 'phone-app' })).scope, 'bots');
  const saved = await prefs.setDevice('p1', { events: { error: true }, quietHours: { enabled: true, end: '07:30' } });
  assert.equal(saved.scope, 'bots');
  assert.equal(saved.events.error, true);
  assert.equal(saved.events.finished, true);
  assert.deepEqual(saved.quietHours, { ...DEFAULT_NOTIFICATION_PREFERENCES.quietHours, enabled: true, end: '07:30' });
  assert.deepEqual(await store(dir).device('p1'), saved, 'survives a restart');
});

test('a revoked device loses its preferences; this PC never does', async (t) => {
  const dir = profile(t);
  const prefs = store(dir);
  await prefs.setDevice('p1', { scope: 'off' });
  await prefs.removeDevice('p1');
  await prefs.removeDevice('pc');
  assert.deepEqual(await store(dir).device('p1'), DEFAULT_NOTIFICATION_PREFERENCES);
  assert.ok(JSON.parse(readFileSync(notificationPreferencesPath(dir), 'utf8')).devices.pc);
});

test('conversation overrides: set, replace, inherit removes, an expired mute is dropped on read', async (t) => {
  const now = { value: MIGRATED_AT };
  const dir = profile(t);
  const prefs = store(dir, {}, now);
  await prefs.setConversation({ kind: 'session', id: 's1' }, { mode: 'muted', until: MIGRATED_AT + 1_000 });
  await prefs.setConversation({ kind: 'room', id: 'r1' }, { mode: 'always' });
  assert.equal((await prefs.overrides()).length, 2);
  await prefs.setConversation({ kind: 'room', id: 'r1' }, { mode: 'muted', until: null });
  assert.deepEqual(
    (await prefs.overrides()).map((entry) => [entry.target.id, entry.setting.mode]),
    [
      ['s1', 'muted'],
      ['r1', 'muted'],
    ]
  );
  now.value = MIGRATED_AT + 1_000;
  assert.deepEqual(
    (await prefs.overrides()).map((entry) => entry.target.id),
    ['r1']
  );
  assert.deepEqual(readPcNotificationView(notificationPreferencesPath(dir), now.value).overrides.length, 1);
  assert.deepEqual(await prefs.setConversation({ kind: 'room', id: 'r1' }, { mode: 'inherit' }), []);
});

test('every stored override and device is kept; adding one evicts nothing', async (t) => {
  const dir = profile(t);
  const overrides = Array.from({ length: 501 }, (_, index) => ({
    target: { kind: 'session', id: `s${index}` },
    setting: { mode: 'muted', until: null },
  }));
  const devices = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`d${index}`, { scope: 'bots' }]));
  writeFileSync(
    notificationPreferencesPath(dir),
    JSON.stringify({ version: 1, migratedAt: MIGRATED_AT, devices, overrides })
  );
  assert.equal(readPcNotificationView(notificationPreferencesPath(dir)).overrides.length, 501);
  const prefs = store(dir);
  assert.equal((await prefs.overrides()).length, 501);
  assert.equal(
    (await prefs.setConversation({ kind: 'room', id: 'extra' }, { mode: 'muted', until: null })).length,
    502
  );
  const kept = await prefs.overrides();
  assert.equal(kept.length, 502);
  assert.ok(
    kept.some((entry) => entry.target.id === 's0'),
    'the oldest mute is still there'
  );
  assert.equal((await prefs.device('d200')).scope, 'bots');
});

test('a read error is not an absent file: nothing is migrated and no default replaces the preferences', async (t) => {
  const dir = profile(t);
  const path = notificationPreferencesPath(dir);
  mkdirSync(path);
  assert.throws(() => readPcNotificationView(path), { code: 'EISDIR' });
  const prefs = store(dir);
  await assert.rejects(prefs.ready(), { code: 'EISDIR' });
  assert.equal(statSync(path).isDirectory(), true, 'the path is left as it was');
  const legacy = join(dir, 'legacy-as-directory');
  mkdirSync(legacy);
  assert.throws(() => readLegacyMutedAgents(legacy), { code: 'EISDIR' });
  assert.deepEqual(readLegacyMutedAgents(join(dir, 'no-such-file.json')), []);
});

test('a damaged file falls back to its last good copy', async (t) => {
  const dir = profile(t);
  const prefs = store(dir);
  await prefs.setDevice('pc', { scope: 'bots' });
  await prefs.setDevice('pc', { taskbarFlash: false });
  writeFileSync(notificationPreferencesPath(dir), '{"version":1,"devi');
  const view = readPcNotificationView(notificationPreferencesPath(dir));
  assert.equal(view.preferences.scope, 'bots');
});

const client = (id, extra = {}) => ({
  id,
  name: `${id} · Chrome`,
  platform: 'Windows',
  browser: 'Chrome',
  createdAt: MIGRATED_AT + 1,
  lastSeenAt: 0,
  online: false,
  ...extra,
});

function center(t, { clients = [], registrations = [], supported = true } = {}) {
  const published = [];
  const prefs = store(profile(t), {}, { value: MIGRATED_AT }, () => published.push('notifications'));
  const tests = [];
  const instance = createNotificationCenter({
    store: prefs,
    pcName: () => 'Desk',
    listClients: async () => clients,
    pushRegistrations: async () => new Set(registrations),
    pcSupported: async () => supported,
    sendPcTest: async () => {
      tests.push('pc');
      return { ok: true };
    },
    sendDeviceTest: async (id) => {
      tests.push(id);
      return { ok: false, message: 'offline' };
    },
  });
  return { instance, published, tests, prefs };
}

test('the device list is this PC, then the Connection tab’s devices with their names and reach', async (t) => {
  const { instance } = center(t, {
    clients: [
      client('phone', { name: 'Galaxy S24 · Mixdog App', browser: 'Mixdog App', online: true }),
      client('tab', { alias: 'Work laptop' }),
      client('gone', { pendingRemoval: true }),
    ],
    registrations: ['phone'],
  });
  const state = await instance.invoke('notificationPreferencesState', ['phone', null]);
  assert.deepEqual(state.devices, [
    { id: 'pc', name: 'Desk', kind: 'pc', online: true, canNotify: true },
    { id: 'phone', name: 'Galaxy S24', kind: 'phone-app', online: true, canNotify: true },
    { id: 'tab', name: 'Work laptop', kind: 'browser', online: false, canNotify: false },
  ]);
  assert.equal(state.currentDeviceId, 'phone');
  assert.deepEqual(Object.keys(state.preferences), ['pc', 'phone', 'tab']);
  assert.equal(state.preferences.phone.scope, 'bots', 'a phone app paired after the migration');
  assert.equal(state.preferences.tab.scope, 'all');
  assert.equal(notificationDeviceName(client('x', { name: '' })), 'Windows');
  const local = await instance.invoke('notificationPreferencesState', ['pc', false]);
  assert.equal(local.devices[0].canNotify, false);
});

test('writes broadcast a notifications settings change; an unknown device is refused', async (t) => {
  const { instance, published } = center(t, { clients: [client('tab')] });
  await instance.invoke('notificationPreferencesState', ['pc', true]);
  assert.deepEqual(published, ['notifications'], 'the listing wrote the defaults it showed');
  published.length = 0;
  const state = await instance.invoke('setNotificationPreferences', ['pc', true, 'tab', { scope: 'off' }]);
  assert.equal(state.preferences.tab.scope, 'off');
  assert.deepEqual(published, ['notifications'], 'one write, one announcement');
  await assert.rejects(instance.invoke('setNotificationPreferences', ['pc', true, 'stranger', {}]), /not paired/);
  const overrides = await instance.invoke('setConversationNotification', [
    { kind: 'agent', id: 'gh' },
    { mode: 'muted', until: null },
  ]);
  assert.equal(overrides.length, 1);
  assert.deepEqual(await instance.invoke('listConversationNotifications', []), overrides);
  assert.deepEqual(published, ['notifications', 'notifications']);
});

test('a test goes to this PC or the paired device; a stranger is told it is not paired', async (t) => {
  const { instance, tests } = center(t, { clients: [client('tab')] });
  assert.deepEqual(await instance.invoke('sendTestNotification', ['pc']), { ok: true });
  assert.deepEqual(await instance.invoke('sendTestNotification', ['tab']), { ok: false, message: 'offline' });
  assert.match((await instance.invoke('sendTestNotification', ['stranger'])).message, /not paired/);
  assert.deepEqual(tests, ['pc', 'tab']);
});
