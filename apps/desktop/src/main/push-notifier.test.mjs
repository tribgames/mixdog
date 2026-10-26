import assert from 'node:assert/strict';
import { createECDH, generateKeyPairSync, randomBytes } from 'node:crypto';
import test, { mock } from 'node:test';
import { createPushNotifier } from './push-notifier.ts';
import { decryptNativePush } from '../shared/native-push-crypto.ts';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../shared/contract-notifications.ts';
import { generateWebPushKeys } from './web-push.ts';
import { noteLegLive, someLegShowsSession } from './remote-transport/foreground.ts';

function subscription() {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.of(0x04), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return {
    endpoint: 'https://push.example.test/x',
    p256dh: raw.toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
    clientId: 'browser-1',
  };
}

function fixture({ foreground = false, enabled = true } = {}) {
  const sent = [];
  const keys = generateWebPushKeys();
  const entry = subscription();
  const notifier = createPushNotifier({
    store: {
      keys: async () => keys,
      list: async () => [entry],
      remove: async () => true,
      removeByClient: async () => true,
    },
    isEnabled: () => enabled,
    readFinalAnswer: async () => null,
    isClientForeground: () => foreground,
    fetchImpl: async (_url, init) => {
      sent.push(init);
      return new Response(null, { status: 201 });
    },
  });
  return { notifier, sent };
}
const update = (toolApproval, frameSource = 'live') => ({ sessionId: 's1', frameSource, snapshot: { toolApproval } });
// final-answer-watcher confirms a finished lead turn after this delay.
const LEAD_FINISHED_MS = 300;
// The notifier's collaborators are promise-only fakes (its timers are faked or
// not yet due), so all its work is microtasks; the event loop reaches its next
// macrotask (the real setImmediate) only once every one of them has run.
const settle = () => new Promise((resolve) => setImmediate(resolve));
// Holds use the global setTimeout; fake it so a hold is advanced, not waited out.
const fakeHoldTimers = (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
};
const advance = async (ms) => {
  mock.timers.tick(ms);
  await settle();
};

test('a session titled by attachments alone is pushed with its kind’s label, never [Image]', async (t) => {
  const device = createECDH('prime256v1');
  device.generateKeys();
  const messages = [];
  const notifier = createPushNotifier({
    store: { keys: async () => generateWebPushKeys(), list: async () => [], remove: async () => true },
    isEnabled: () => true,
    readFinalAnswer: async () => null,
    isClientForeground: () => false,
    native: {
      list: async () => [
        {
          clientId: 'phone-1',
          platform: 'fcm',
          token: 'token',
          publicKey: device.getPublicKey().toString('base64url'),
          sandbox: false,
          createdAt: 1,
        },
      ],
      isClientForeground: () => false,
      send: (message) => messages.push(message) > 0,
      removeByClient: async () => true,
    },
  });
  t.after(() => notifier.dispose());
  notifier.onSessions([
    { id: 's1', title: '[Image]' },
    { id: 's2', title: 'Fix the release' },
  ]);
  notifier.onSessionState(update({ id: 'a1', name: 'shell' }));
  notifier.onSessionState({ ...update({ id: 'a2', name: 'shell' }), sessionId: 's2' });
  await settle();
  const titles = messages.map((message) => decryptNativePush(device.getPrivateKey(), message.mx).title);
  assert.deepEqual(titles.sort(), ['Fix the release', 'Image']);
});

test('a new tool approval pushes once to a background client', async (t) => {
  const f = fixture();
  t.after(() => f.notifier.dispose());
  f.notifier.onSessionState(update({ id: 'a1', name: 'shell' }));
  f.notifier.onSessionState(update({ id: 'a1', name: 'shell' }));
  await settle();
  assert.equal(f.sent.length, 1);
  f.notifier.onSessionState(update(null));
  f.notifier.onSessionState(update({ id: 'a3' }));
  await settle();
  assert.equal(f.sent.length, 2);
});

test('approval push is suppressed for foreground, disabled and replayed state', async (t) => {
  for (const [options, frame] of [
    [{ foreground: true }, 'live'],
    [{ enabled: false }, 'live'],
    [{}, 'replay'],
  ]) {
    const f = fixture(options);
    t.after(() => f.notifier.dispose());
    f.notifier.onSessionState(update({ id: 'a2' }, frame));
    await settle();
    assert.equal(f.sent.length, 0);
  }
});

test('a frozen phone suppresses pushes until its authenticated liveness goes stale, then is pushed to', async (t) => {
  let clock = 0;
  const phone = { background: false, screenSessionIds: new Set(['s1']), browserId: 'browser-1' };
  noteLegLive(phone, clock);
  const legs = [phone];
  const sent = [];
  const notifier = createPushNotifier({
    store: {
      keys: async () => generateWebPushKeys(),
      list: async () => [subscription()],
      remove: async () => true,
    },
    isEnabled: () => true,
    readFinalAnswer: async () => null,
    isClientForeground: (browserId, sessionId) =>
      someLegShowsSession(legs, sessionId, (leg) => leg.browserId === browserId, clock),
    fetchImpl: async (_url, init) => {
      sent.push(init);
      return new Response(null, { status: 201 });
    },
  });
  t.after(() => notifier.dispose());
  clock = 34_999;
  notifier.onSessionState(update({ id: 'a1' }));
  await settle();
  assert.equal(sent.length, 0);
  clock = 35_000;
  notifier.onSessionState(update(null));
  notifier.onSessionState(update({ id: 'a2' }));
  await settle();
  assert.equal(sent.length, 1);
});

const withGoal = (goal, extra = {}, frameSource = 'live') => ({
  sessionId: 's1',
  frameSource,
  snapshot: { goal, busy: false, ...extra },
});
const parked = (id = 't1') => ({
  id: 'g1',
  status: 'active',
  tasks: [{ id, status: 'awaiting_approval' }],
});

test('a session that starts waiting for the user pushes once per wait', async (t) => {
  const f = fixture();
  t.after(() => f.notifier.dispose());
  f.notifier.onSessionState(withGoal(parked()));
  f.notifier.onSessionState(withGoal(parked()));
  await settle();
  assert.equal(f.sent.length, 1);
  f.notifier.onSessionState(withGoal({ id: 'g1', status: 'active', tasks: [{ id: 't1', status: 'completed' }] }));
  f.notifier.onSessionState(withGoal(parked('t2')));
  await settle();
  assert.equal(f.sent.length, 2);
  f.notifier.onSessionState(withGoal({ id: 'g1', status: 'blocked', blocker: 'needs a sign-in' }));
  await settle();
  assert.equal(f.sent.length, 3);
});

test('a parked task while the turn is still running is not yet a wait', async (t) => {
  const f = fixture();
  t.after(() => f.notifier.dispose());
  f.notifier.onSessionState(withGoal(parked(), { busy: true }));
  await settle();
  assert.equal(f.sent.length, 0);
});

test('input-needed push obeys the same gates as approvals', async (t) => {
  for (const [options, frame] of [
    [{ foreground: true }, 'live'],
    [{ enabled: false }, 'live'],
    [{}, 'replay'],
  ]) {
    const f = fixture(options);
    t.after(() => f.notifier.dispose());
    f.notifier.onSessionState(withGoal(parked(), {}, frame));
    await settle();
    assert.equal(f.sent.length, 0);
  }
});

/** Two phone apps and a browser, each with its own preferences. */
function devices(t, { preferences = {}, desktopActive = false, foreground = [], answer = null, holdMs = 60_000 } = {}) {
  const keys = new Map();
  const phones = ['phone-a', 'phone-b'].map((clientId, index) => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    keys.set(clientId, ecdh);
    return {
      clientId,
      platform: 'fcm',
      token: `token-${index}`,
      publicKey: ecdh.getPublicKey().toString('base64url'),
      sandbox: false,
      createdAt: 10 + index,
    };
  });
  const web = { ...subscription(), clientId: 'tab-1', label: '', createdAt: 0 };
  const native = [];
  // What the relay itself is handed, before the phone decrypts anything.
  const relayed = [];
  const posted = [];
  const asked = [];
  let activeChecks = 0;
  const notifier = createPushNotifier({
    store: {
      keys: async () => generateWebPushKeys(),
      list: async () => [web],
      remove: async () => true,
      removeByClient: async () => true,
    },
    isEnabled: () => true,
    readFinalAnswer: async () => answer,
    holdMs,
    isClientForeground: (id, sessionId) => foreground.includes(`${id}:${sessionId}`),
    fetchImpl: async () => {
      posted.push('tab-1');
      return new Response(null, { status: 201 });
    },
    preferences: {
      device: async (id) => {
        asked.push(id);
        return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...preferences[id] };
      },
      overrides: async () => [],
      desktopActive: async () => {
        activeChecks += 1;
        return desktopActive;
      },
    },
    native: {
      list: async () => phones,
      isClientForeground: (id, sessionId) => foreground.includes(`${id}:${sessionId}`),
      send: (message) => {
        relayed.push(message);
        const recipient = phones.find((phone) => phone.token === message.token).clientId;
        native.push({
          recipient,
          outer: message.reason,
          ...decryptNativePush(keys.get(recipient).getPrivateKey(), message.mx),
        });
        return true;
      },
      removeByClient: async () => true,
    },
  });
  t.after(() => notifier.dispose());
  return { notifier, native, relayed, posted, asked, checks: () => activeChecks };
}

test('each paired device gets its own decision: scope and event switch', async (t) => {
  const f = devices(t, {
    preferences: {
      'phone-b': { scope: 'bots' },
      'tab-1': { events: { ...DEFAULT_NOTIFICATION_PREFERENCES.events, approval: false } },
    },
  });
  f.notifier.onSessions([{ id: 's1', title: 'Fix' }]);
  f.notifier.onSessionState(update({ id: 'a1' }));
  await settle();
  assert.deepEqual(
    f.native.map((push) => push.recipient),
    ['phone-a']
  );
  assert.deepEqual(f.posted, [], 'the browser turned approvals off');
  assert.deepEqual([...f.asked].sort(), ['phone-a', 'phone-b', 'tab-1']);
});

test('a device holding pushes while this PC is in use waits, and this PC is asked only for it', async (t) => {
  fakeHoldTimers(t);
  const quiet = devices(t, { desktopActive: true });
  quiet.notifier.onSessionState(update({ id: 'a1' }));
  await settle();
  assert.equal(quiet.native.length, 2);
  assert.equal(quiet.checks(), 0, 'nobody holds: the PC is not asked');
  const held = devices(t, {
    desktopActive: true,
    holdMs: 150,
    preferences: { 'phone-a': { holdWhileDesktopActive: true } },
  });
  held.notifier.onSessionState(update({ id: 'a1' }));
  await settle();
  assert.deepEqual(
    held.native.map((push) => push.recipient),
    ['phone-b'],
    'the device that does not hold hears it at once'
  );
  assert.equal(held.checks(), 1, 'asked once per notification');
  await advance(250);
  assert.deepEqual(
    held.native.map((push) => push.recipient),
    ['phone-b', 'phone-a'],
    'the approval is still open after the hold: the held device hears it, the other not twice'
  );
  assert.deepEqual(held.posted, ['tab-1'], 'the browser was not held and hears it once');
  assert.equal(held.checks(), 1, 'the PC is not asked again after the hold');
});

test('a held approval answered on this PC during the hold is never pushed', async (t) => {
  fakeHoldTimers(t);
  const f = devices(t, {
    desktopActive: true,
    holdMs: 150,
    preferences: { 'phone-a': { holdWhileDesktopActive: true } },
  });
  f.notifier.onSessionState(update({ id: 'a1' }));
  await settle();
  f.notifier.onSessionState(update(null));
  await advance(250);
  assert.deepEqual(
    f.native.map((push) => push.recipient),
    ['phone-b']
  );
});

test('a held finished turn goes out after the hold only while it is still unread', async (t) => {
  fakeHoldTimers(t);
  const answer = { id: 'turn', at: Number.MAX_SAFE_INTEGER, status: 'done', text: 'Done.' };
  const hold = { holdWhileDesktopActive: true };
  const preferences = { 'phone-a': hold, 'phone-b': hold, 'tab-1': hold };
  const run = async (readDuringHold) => {
    const f = devices(t, { desktopActive: true, holdMs: 400, answer, preferences });
    f.notifier.onSessions([{ id: 's1', title: 'Fix', working: true, messageCount: 2, readMessageCount: 2 }]);
    f.notifier.onSessions([{ id: 's1', title: 'Fix', messageCount: 4, readMessageCount: 2 }]);
    await advance(LEAD_FINISHED_MS);
    assert.equal(f.native.length, 0, 'held while this PC is in use');
    if (readDuringHold) f.notifier.onSessions([{ id: 's1', title: 'Fix', messageCount: 4, readMessageCount: 4 }]);
    await advance(400);
    return f;
  };
  const unread = await run(false);
  assert.deepEqual(unread.native.map((push) => push.recipient).sort(), ['phone-a', 'phone-b']);
  assert.deepEqual(unread.posted, ['tab-1']);
  const read = await run(true);
  assert.equal(read.native.length, 0, 'read on this PC meanwhile');
  assert.deepEqual(read.posted, []);
});

test('a failed turn pushes reason turn-failed, travelling to the relay as turn-finished', async (t) => {
  const errors = { ...DEFAULT_NOTIFICATION_PREFERENCES.events, error: true };
  fakeHoldTimers(t);
  const f = devices(t, {
    preferences: { 'phone-a': { events: errors } },
    answer: { id: 'turn', at: Number.MAX_SAFE_INTEGER, status: 'failed', text: '' },
  });
  f.notifier.onSessions([{ id: 's1', title: 'Deploy', working: true }]);
  f.notifier.onSessions([{ id: 's1', title: 'Deploy' }]);
  await advance(LEAD_FINISHED_MS);
  assert.deepEqual(
    f.native.map((push) => [push.recipient, push.outer, push.reason, push.body]),
    [['phone-a', 'turn-finished', 'turn-failed', 'The turn stopped with an error.']]
  );
  assert.deepEqual(f.posted, [], 'errors are off for the others');
});

test('a webhook result reaches a device that is watching, like a schedule’s', async (t) => {
  fakeHoldTimers(t);
  const f = devices(t, {
    foreground: ['phone-a:hook', 'phone-b:hook', 'tab-1:hook'],
    answer: { id: 'turn', at: Number.MAX_SAFE_INTEGER, status: 'done', text: 'Deployed.' },
  });
  f.notifier.onSessions([{ id: 'hook', title: 'Hook', sourceType: 'webhook', working: true }]);
  f.notifier.onSessions([{ id: 'hook', title: 'Hook', sourceType: 'webhook' }]);
  await advance(LEAD_FINISHED_MS);
  assert.equal(f.native.length, 2);
  assert.deepEqual(f.posted, ['tab-1']);
});

test('a test push goes to that device alone, past its preferences', async (t) => {
  const f = devices(t, { preferences: { 'phone-a': { scope: 'off' } } });
  assert.deepEqual(await f.notifier.sendTest('phone-a'), { ok: true });
  assert.deepEqual(
    f.native.map((push) => [push.recipient, push.reason, push.body]),
    [['phone-a', 'turn-finished', 'Notifications from this PC reach this device.']]
  );
  assert.deepEqual(await f.notifier.sendTest('tab-1'), { ok: true });
  assert.deepEqual(f.posted, ['tab-1']);
  const none = await f.notifier.sendTest('stranger');
  assert.equal(none.ok, false);
  assert.match(none.message, /not allowed notifications/);
});

test('an approval and an input wait on the same session are separate pushes', async (t) => {
  const f = fixture();
  t.after(() => f.notifier.dispose());
  f.notifier.onSessionState({
    sessionId: 's1',
    frameSource: 'live',
    snapshot: { toolApproval: { id: 'a1' }, goal: parked() },
  });
  await settle();
  assert.equal(f.sent.length, 2);
});

// Each kind of approval as a session's snapshot shows it (human-gate/requests.mjs).
const APPROVALS = {
  shell: { kind: 'approval', name: 'shell', args: { command: 'npm test' } },
  comment: { kind: 'outbound', outbound: { category: 'comment', target: 'repo#1' } },
  officeCommit: { kind: 'approval', name: 'office', args: { action: 'commit' } },
  permissionOnce: {
    kind: 'permission',
    permission: {
      scopes: [
        { id: 'o', kind: 'allow_once' },
        { id: 'a', kind: 'allow_always' },
      ],
    },
  },
  payment: { kind: 'outbound', outbound: { category: 'payment' } },
  delete: { kind: 'outbound', outbound: { category: 'delete' } },
  officeRollback: { kind: 'approval', name: 'office', args: { action: 'rollback' } },
  officeDiscard: { kind: 'approval', name: 'office', args: { action: 'discard' } },
  alwaysOnly: { kind: 'permission', permission: { scopes: [{ id: 'a', kind: 'allow_always' }] } },
  login: { kind: 'takeover', takeover: { purpose: 'login', url: 'https://github.com/login' } },
  takeover: { kind: 'takeover', takeover: { surface: 'browser' } },
  secret: { kind: 'secret', secret: { requestId: 'r1', form: 'otp' } },
};
/** The ones this PC's card allows once with a bare Enter (its 한 번만 허용). */
const ALLOWED_ONCE = new Set(['shell', 'comment', 'officeCommit', 'permissionOnce']);

test('a phone’s approval push offers Allow only where this PC’s card allows it once with a bare Enter', async (t) => {
  const f = devices(t);
  for (const [name, approval] of Object.entries(APPROVALS)) {
    f.notifier.onSessionState({
      sessionId: name,
      frameSource: 'live',
      snapshot: { toolApproval: { id: `${name}-1`, ...approval } },
    });
  }
  await settle();
  const pushes = f.native.filter((push) => push.recipient === 'phone-a');
  assert.deepEqual(pushes.map((push) => push.sessionId).sort(), Object.keys(APPROVALS).sort());
  for (const push of pushes) {
    assert.equal(push.reason, 'approval-pending', push.sessionId);
    // Every one still names its approval: a tap opens it there, Deny answers it.
    assert.equal(push.approvalId, `${push.sessionId}-1`);
    assert.equal(push.allowOnce === true, ALLOWED_ONCE.has(push.sessionId), push.sessionId);
  }
  // The relay is handed the reason alone, never whether Allow is offered.
  for (const message of f.relayed) {
    assert.deepEqual(Object.keys(message).sort(), ['collapseKey', 'mx', 'platform', 'reason', 'sandbox', 'token']);
  }
});

test('a held request’s push names it but never offers Allow: its content is not known here', async (t) => {
  const f = devices(t);
  f.notifier.onHeldRequest({ sessionId: 'sess_home_x', agentId: 'x', agentName: 'Mixy', requestId: 'held_1' });
  await settle();
  assert.equal(f.native.length, 2);
  for (const push of f.native) {
    assert.equal(push.approvalId, 'held_1');
    assert.equal(push.allowOnce, undefined);
  }
});

test('a notification’s Allow may answer only the approval a session shows now, where Enter allows it once', async (t) => {
  const f = fixture();
  t.after(() => f.notifier.dispose());
  const show = (approval, frameSource = 'live') =>
    f.notifier.onSessionState({ sessionId: 's1', frameSource, snapshot: { toolApproval: approval } });
  show({ id: 'a1', ...APPROVALS.shell });
  assert.equal(f.notifier.approvalAllowsOnce('s1', 'a1'), true);
  assert.equal(f.notifier.approvalAllowsOnce('s1', 'another'), false);
  assert.equal(f.notifier.approvalAllowsOnce('s2', 'a1'), false);
  show({ id: 'p1', ...APPROVALS.payment });
  assert.equal(f.notifier.approvalAllowsOnce('s1', 'p1'), false);
  assert.equal(f.notifier.approvalAllowsOnce('s1', 'a1'), false, 'no longer shown');
  show(null);
  assert.equal(f.notifier.approvalAllowsOnce('s1', 'p1'), false);
  show({ id: 'a2', ...APPROVALS.shell }, 'replay');
  assert.equal(f.notifier.approvalAllowsOnce('s1', 'a2'), true, 'a replayed frame still says what the session shows');
});
