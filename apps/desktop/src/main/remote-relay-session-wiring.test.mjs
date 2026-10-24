import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { decryptNativePush } from '../shared/native-push-crypto.ts';
import { createNotificationPreferencesStore, notificationPreferencesPath } from './notification-preferences.ts';
import { createRelaySessionWiring } from './remote-relay-session-wiring.ts';

const off = () => () => {};
const MIGRATED_AT = 5_000;

function wiring(t, { pairedAt = MIGRATED_AT + 1, registeredAt = MIGRATED_AT + 2 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-wiring-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const changes = [];
  const preferences = createNotificationPreferencesStore({
    filePath: notificationPreferencesPath(dir),
    readLegacy: async () => ({ turnNotifications: true, mutedAgents: [] }),
    now: () => MIGRATED_AT,
    onChange: () => changes.push('notifications'),
  });
  const phone = createECDH('prime256v1');
  phone.generateKeys();
  const registrations = [
    {
      clientId: 'c1',
      platform: 'fcm',
      token: 't1',
      publicKey: phone.getPublicKey().toString('base64url'),
      sandbox: false,
      createdAt: registeredAt,
    },
  ];
  const removed = [];
  const sent = [];
  const listeners = { sessions: null, states: null };
  // The phone's relay leg: what it reports itself showing.
  const leg = { credentialId: 'c1', background: false, visibleSessionIds: new Set() };
  const clients = new Map([['leg-1', leg]]);
  const subscriptions = createRelaySessionWiring({
    host: {
      subscribe: off,
      subscribeSessions: (listener) => {
        listeners.sessions = listener;
        return () => {};
      },
      subscribeAgentPool: off,
      subscribeSessionStates: (listener) => {
        listeners.states = listener;
        return () => {};
      },
      readSessionFinalAnswer: async () => ({ id: 'turn', at: Number.MAX_SAFE_INTEGER, status: 'done', text: 'Done.' }),
      invokeDesktopOperation: async () => [],
    },
    clients: { clients, size: clients.size },
    catalogs: { publishSessions: () => {}, publishAgentPool: () => {} },
    sessionStates: { publish: () => {} },
    pushStore: {
      list: async () => [],
      keys: async () => ({}),
      remove: async () => true,
      removeByClient: async (id) => removed.push(['web', id]),
    },
    nativePush: {
      store: {
        list: async () => registrations,
        removeByClient: async (id) => removed.push(['native', id]),
      },
      send: (message) => sent.push(decryptNativePush(phone.getPrivateKey(), message.mx)) > 0,
    },
    notifications: {
      preferences,
      desktopActive: async () => false,
      // The paired client's own record (Settings › Connection), not its push registration.
      pairedClient: async (clientId) => (clientId === 'c1' ? { kind: 'phone-app', pairedAt } : null),
    },
    live: () => true,
    closed: () => false,
    sendEncryptedFrame: async () => {},
    broadcastEncrypted: () => {},
  }).start();
  t.after(() => subscriptions.dispose());
  const finish = async (sessionId) => {
    listeners.sessions([{ id: sessionId, title: sessionId, working: true }]);
    listeners.sessions([{ id: sessionId, title: sessionId }]);
    await new Promise((resolve) => setTimeout(resolve, 500));
  };
  return { subscriptions, preferences, removed, sent, changes, listeners, leg, finish };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('a phone paired before the migration that re-registers its push after it keeps the defaults', async (t) => {
  const w = wiring(t, { pairedAt: MIGRATED_AT - 1, registeredAt: MIGRATED_AT + 10 });
  // A coding session: a bots-only phone would not hear it.
  w.listeners.states({ sessionId: 'code', frameSource: 'live', snapshot: { toolApproval: { id: 'a1' } } });
  await settle();
  assert.equal(w.sent.length, 1);
  assert.equal((await w.preferences.device('c1')).scope, 'all');
});

test('a phone app paired after the migration starts with bot chats only, before settings are opened', async (t) => {
  const w = wiring(t, { pairedAt: MIGRATED_AT + 1 });
  w.listeners.states({ sessionId: 'code', frameSource: 'live', snapshot: { toolApproval: { id: 'a1' } } });
  await settle();
  assert.equal(w.sent.length, 0);
  assert.equal((await w.preferences.device('c1')).scope, 'bots');
});

test('a phone showing chat A still hears a reply that finished in chat B', async (t) => {
  const w = wiring(t, { pairedAt: MIGRATED_AT - 1 });
  w.leg.visibleSessionIds = new Set(['A']);
  w.leg.screenSessionIds = new Set(['A']);
  await w.finish('B');
  assert.deepEqual(
    w.sent.map((push) => push.sessionId),
    ['B']
  );
  await w.finish('A');
  assert.equal(w.sent.length, 1, 'the conversation on its screen is not pushed');
  // A leg that reports no session is not showing that conversation.
  w.leg.screenSessionIds = new Set();
  await w.finish('A');
  assert.equal(w.sent.length, 2);
  // In the background it shows nothing.
  w.leg.screenSessionIds = new Set(['A']);
  w.leg.background = true;
  await w.finish('A');
  assert.equal(w.sent.length, 3);
});

test('a wide client subscribed to B in the background while showing A is notified of a B reply', async (t) => {
  const w = wiring(t, { pairedAt: MIGRATED_AT - 1 });
  // The delivery subscription carries the observed background session B.
  w.leg.visibleSessionIds = new Set(['A', 'B']);
  w.leg.screenSessionIds = new Set(['A']);
  await w.finish('B');
  assert.deepEqual(
    w.sent.map((push) => push.sessionId),
    ['B']
  );
  await w.finish('A');
  assert.equal(w.sent.length, 1, 'A is on its screen');
});

test('a client that never reports its screen (an older build) shows no conversation', async (t) => {
  const w = wiring(t, { pairedAt: MIGRATED_AT - 1 });
  w.leg.visibleSessionIds = new Set(['A']);
  await w.finish('A');
  assert.equal(w.sent.length, 1);
});

test('revoking a paired client drops its push registrations and its notification preferences', async (t) => {
  const w = wiring(t);
  await w.preferences.setDevice('c1', { scope: 'off' });
  await w.preferences.setDevice('c2', { scope: 'bots' });
  w.changes.length = 0;
  w.subscriptions.forgetClient('c1');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(w.changes, ['notifications'], 'open settings pages are told');
  assert.deepEqual(w.removed.sort(), [
    ['native', 'c1'],
    ['web', 'c1'],
  ]);
  assert.equal((await w.preferences.device('c1')).scope, 'all', 'back to the default: nothing stored');
  assert.equal((await w.preferences.device('c2')).scope, 'bots', 'another device keeps its own');
});

test('a test notification reaches the paired device through its native registration', async (t) => {
  const w = wiring(t);
  await w.preferences.setDevice('c1', { scope: 'off' });
  assert.deepEqual(await w.subscriptions.sendTestNotification('c1'), { ok: true });
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].reason, 'turn-finished');
});
