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

function wiring(t, { pairedAt = MIGRATED_AT + 1, registeredAt = MIGRATED_AT + 2, clock = { now: 0 } } = {}) {
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
  // Final-answer reads in the order the watcher issued them; a read precedes the push-or-suppress decision.
  const reads = [];
  const roster = new Map();
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
      readSessionFinalAnswer: async (sessionId) => {
        reads.push(sessionId);
        return { id: 'turn', at: Number.MAX_SAFE_INTEGER, status: 'done', text: 'Done.' };
      },
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
    foregroundNow: () => clock.now,
  }).start();
  t.after(() => subscriptions.dispose());
  // Finishes the given replies together and waits until `count` pushes were sent in total. Every
  // roster update keeps all known sessions (a session missing from the roster would cancel its
  // pending notification). The watcher reads finished turns one at a time in roster order, so
  // once every listed reply was read and the last one's push arrived, the earlier ones' decisions
  // (push or suppress) are already made.
  const finish = async (sessionIds, count) => {
    const ids = [sessionIds].flat();
    const publish = (working) => {
      for (const id of ids) roster.set(id, { id, title: id, ...(working ? { working: true } : {}) });
      listeners.sessions([...roster.values()]);
    };
    const readsBefore = reads.length;
    publish(true);
    publish(false);
    await until(() => reads.length - readsBefore >= ids.length && sent.length >= count);
  };
  return { subscriptions, preferences, removed, sent, reads, changes, listeners, leg, finish };
}

const turn = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition) => {
  for (let i = 0; i < 1_000 && !condition(); i += 1) await turn();
  assert.ok(condition(), 'condition never became true');
};

test('a phone paired before the migration that re-registers its push after it keeps the defaults', async (t) => {
  const w = wiring(t, { pairedAt: MIGRATED_AT - 1, registeredAt: MIGRATED_AT + 10 });
  // A coding session: a bots-only phone would not hear it.
  w.listeners.states({ sessionId: 'code', frameSource: 'live', snapshot: { toolApproval: { id: 'a1' } } });
  await until(() => w.sent.length >= 1);
  assert.equal(w.sent.length, 1);
  assert.equal((await w.preferences.device('c1')).scope, 'all');
});

test('a phone app paired after the migration starts with bot chats only, before settings are opened', async (t) => {
  const w = wiring(t, { pairedAt: MIGRATED_AT + 1 });
  w.listeners.states({ sessionId: 'code', frameSource: 'live', snapshot: { toolApproval: { id: 'a1' } } });
  // The approval is judged against the device's first-use default, which settles to bots.
  for (let i = 0; i < 1_000 && (await w.preferences.device('c1')).scope !== 'bots'; i += 1) await turn();
  assert.equal((await w.preferences.device('c1')).scope, 'bots');
  assert.equal(w.sent.length, 0);
});

test('a phone showing chat A still hears a reply that finished in chat B', async (t) => {
  const w = wiring(t, { pairedAt: MIGRATED_AT - 1 });
  w.leg.visibleSessionIds = new Set(['A']);
  w.leg.screenSessionIds = new Set(['A']);
  await w.finish(['A', 'B'], 1);
  assert.deepEqual(w.reads, ['A', 'B'], 'A was read and decided before B');
  assert.deepEqual(
    w.sent.map((push) => push.sessionId),
    ['B'],
    'the conversation on its screen is not pushed'
  );
  // A leg that reports no session is not showing that conversation.
  w.leg.screenSessionIds = new Set();
  await w.finish('A', 2);
  assert.equal(w.sent.length, 2);
  // In the background it shows nothing.
  w.leg.screenSessionIds = new Set(['A']);
  w.leg.background = true;
  await w.finish('A', 3);
  assert.equal(w.sent.length, 3);
});

test('a wide client subscribed to B in the background while showing A is notified of a B reply', async (t) => {
  const w = wiring(t, { pairedAt: MIGRATED_AT - 1 });
  // The delivery subscription carries the observed background session B.
  w.leg.visibleSessionIds = new Set(['A', 'B']);
  w.leg.screenSessionIds = new Set(['A']);
  await w.finish(['A', 'B'], 1);
  assert.deepEqual(w.reads, ['A', 'B'], 'A was read and decided before B');
  assert.deepEqual(
    w.sent.map((push) => push.sessionId),
    ['B'],
    'A is on its screen'
  );
});

test('a transport leg counts as foreground only with authenticated liveness within 35 s', async (t) => {
  const clock = { now: 100_000 };
  const w = wiring(t, { pairedAt: MIGRATED_AT - 1, clock });
  w.leg.transport = {};
  w.leg.visibleSessionIds = new Set(['A']);
  w.leg.screenSessionIds = new Set(['A']);
  w.leg.liveAt = clock.now - 34_999;
  // B (not on screen) is decided after A, so its push proves A's decision.
  await w.finish(['A', 'B'], 1);
  assert.deepEqual(
    w.sent.map((push) => push.sessionId),
    ['B'],
    'live at 34 999 ms: the conversation on screen is not pushed'
  );
  // Frozen: still registered, still reporting A, but silent for 35 000 ms.
  w.leg.liveAt = clock.now - 35_000;
  await w.finish('A', 2);
  assert.equal(w.sent.at(-1).sessionId, 'A', 'stale at 35 000 ms: pushed');
});

test('a legacy leg idle on a session stays foreground: its relay heartbeat is not authenticated', async (t) => {
  const clock = { now: 10_000_000 };
  const w = wiring(t, { pairedAt: MIGRATED_AT - 1, clock });
  w.leg.visibleSessionIds = new Set(['A']);
  w.leg.screenSessionIds = new Set(['A']);
  // Last authenticated traffic an hour ago; no transport session.
  w.leg.liveAt = clock.now - 3_600_000;
  await w.finish(['A', 'B'], 1);
  assert.deepEqual(
    w.sent.map((push) => push.sessionId),
    ['B'],
    'not pushed for the session it shows'
  );
  // A hidden report still removes eligibility at once.
  w.leg.background = true;
  await w.finish('A', 2);
  assert.equal(w.sent.at(-1).sessionId, 'A');
});

test('a client that never reports its screen (an older build) shows no conversation', async (t) => {
  const w = wiring(t, { pairedAt: MIGRATED_AT - 1 });
  w.leg.visibleSessionIds = new Set(['A']);
  await w.finish('A', 1);
  assert.equal(w.sent.length, 1);
});

test('revoking a paired client drops its push registrations and its notification preferences', async (t) => {
  const w = wiring(t);
  await w.preferences.setDevice('c1', { scope: 'off' });
  await w.preferences.setDevice('c2', { scope: 'bots' });
  w.changes.length = 0;
  w.subscriptions.forgetClient('c1');
  await until(() => w.removed.length >= 2 && w.changes.length >= 1);
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
