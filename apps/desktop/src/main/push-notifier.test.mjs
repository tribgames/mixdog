import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createPushNotifier } from './push-notifier.ts';
import { generateWebPushKeys } from './web-push.ts';

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
    store: { keys: async () => keys, list: async () => [entry], remove: async () => true, removeByClient: async () => true },
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
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

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

test('an approval and an input wait on the same session are separate pushes', async (t) => {
  const f = fixture();
  t.after(() => f.notifier.dispose());
  f.notifier.onSessionState({ sessionId: 's1', frameSource: 'live', snapshot: { toolApproval: { id: 'a1' }, goal: parked() } });
  await settle();
  assert.equal(f.sent.length, 2);
});
