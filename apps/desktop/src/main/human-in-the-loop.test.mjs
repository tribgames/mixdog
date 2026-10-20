import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { decryptNativePush } from '../shared/native-push-crypto.ts';
import { sessionAttention } from '../shared/session-attention.ts';
import { createAgentNotificationMuteStore, readMutedAgents } from './agent-notification-mute.ts';
import { fillSecretInput } from './browser/host-agent.ts';
import { beginComputerOperation } from './human-only-approval.ts';
import { requiredToolApprovalDecision } from './ipc-validation.ts';
import { createPushNotifier, heldRequestPushText } from './push-notifier.ts';
import { createSecretInputs, typeComputerSecret } from './secret-input.ts';
import { createTakeoverGate } from './takeover-gate.ts';

const SENTINEL = 'S3NT1NEL-desktop-secret-41aa';
const REQUEST = 'secret_0123456789abcdef';

test('secret input: one-shot slot, only the target field receives it, replies are redacted', async () => {
  const inputs = createSecretInputs();
  assert.equal(inputs.provide('not-an-id', SENTINEL), false);
  assert.equal(inputs.provide(REQUEST, SENTINEL), true);
  const typed = [];
  const reply = await typeComputerSecret(
    { session_id: 's1', request_id: REQUEST },
    async (command) => {
      typed.push(command);
      return { text: `field now shows ${SENTINEL}` };
    },
    inputs
  );
  assert.deepEqual(reply, { text: 'provided' }, 'the reply says only provided');
  assert.deepEqual(typed, [{ action: 'type', text: SENTINEL, session_id: 's1' }]);
  assert.equal(inputs.take(REQUEST), '', 'the value is gone after one use');
  assert.deepEqual(
    await typeComputerSecret({ session_id: 's1', request_id: REQUEST }, async () => assert.fail('no value'), inputs),
    { text: 'skipped' }
  );
  assert.equal(inputs.redact('s1', `ocr: ${SENTINEL}`), 'ocr: [REDACTED SECRET]');
  assert.equal(inputs.focusArmed('s1'), true, 'captures are withheld while the field may be focused');
  inputs.forget('s1');
  assert.equal(inputs.redact('s1', SENTINEL), SENTINEL);

  // Browser: the isolated-world fill gets the value; the bridge reply does not.
  assert.equal(inputs.provide(REQUEST, SENTINEL), true);
  const fills = [];
  const guest = { isDestroyed: () => false };
  const result = await fillSecretInput(
    {
      currentGuest: () => guest,
      fill: async (_guest, credential) => {
        fills.push(credential);
        return { usernameFilled: false, passwordFilled: true };
      },
      assertFree: () => {},
    },
    's1',
    REQUEST,
    undefined,
    inputs
  );
  assert.deepEqual(result, { text: 'provided' });
  assert.deepEqual(fills, [{ username: '', password: SENTINEL }]);
});

test('an approval decision can never carry a secret value', () => {
  assert.throws(
    () => requiredToolApprovalDecision({ approved: true, response: 'provide-secret', value: SENTINEL }),
    /unsupported field/
  );
  assert.deepEqual(
    requiredToolApprovalDecision({
      approved: true,
      response: 'edit-and-approve',
      editedArgs: { body: 'edited' },
      remember: 'agent',
    }),
    {
      approved: true,
      reason: undefined,
      response: 'edit-and-approve',
      editedArgs: { body: 'edited' },
      remember: 'agent',
    }
  );
  assert.throws(() => requiredToolApprovalDecision({ approved: true, response: 'auto' }), /response/);
  assert.throws(() => requiredToolApprovalDecision({ approved: true, editedArgs: { body: 1 } }), /editedArgs/);
});

test('a pending takeover blocks Computer and Browser Use until it leaves the snapshot', async () => {
  const gate = createTakeoverGate();
  const takeover = (id) => ({ sessionId: 's1', snapshot: { toolApproval: id ? { id, kind: 'takeover' } : null } });
  gate.onSessionState(takeover('t1'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => beginComputerOperation(), /blocked/);
  assert.throws(() => gate.assertFree(), /taken over/);
  gate.onSessionState(takeover(null));
  await new Promise((resolve) => setImmediate(resolve));
  gate.assertFree();
  beginComputerOperation()();
  gate.onSessionState({ sessionId: 's1', snapshot: { toolApproval: { id: 'a1', kind: 'approval' } } });
  gate.assertFree();
});

const device = () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey().toString('base64url') };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

function notifier(t, mutes) {
  const phone = device();
  const sent = [];
  const instance = createPushNotifier({
    store: { keys: async () => ({}), list: async () => [], remove: async () => true, removeByClient: async () => true },
    isEnabled: () => true,
    readFinalAnswer: async () => null,
    isClientForeground: () => false,
    isSessionMuted: (sessionId) => mutes.isSessionMuted(sessionId),
    native: {
      list: async () => [{ clientId: 'c1', platform: 'fcm', token: 'tok', publicKey: phone.publicKey, sandbox: false }],
      isClientForeground: () => false,
      send: (message) => {
        sent.push(decryptNativePush(phone.privateKey, message.mx));
        return true;
      },
      removeByClient: async () => true,
    },
  });
  t.after(() => instance.dispose());
  return { instance, sent };
}

test('a held request push says only that the agent waits — no tool, arguments or text', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mute-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mutes = createAgentNotificationMuteStore(join(dir, 'agent-notifications.json'));
  const f = notifier(t, mutes);
  f.instance.onHeldRequest({ sessionId: 'sess_home_reviewer', agentName: '리뷰어', requestId: 'held_1' });
  await settle();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].body, '리뷰어가 승인을 기다립니다');
  assert.equal(f.sent[0].body, heldRequestPushText('리뷰어'));
  assert.equal(f.sent[0].approvalId, 'held_1');
  assert.deepEqual(Object.keys(f.sent[0]).sort(), ['approvalId', 'body', 'reason', 'sessionId', 'title']);
});

test('a muted agent pushes nothing — approvals, failures, held requests — while in-app state stays', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mute-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'agent-notifications.json');
  const mutes = createAgentNotificationMuteStore(file);
  const f = notifier(t, mutes);
  const home = 'sess_home_reviewer';
  const summary = {
    id: home,
    title: 'Reviewer',
    preview: '',
    messageCount: 5,
    readMessageCount: 3,
    agentHome: 'reviewer',
  };
  const before = structuredClone(summary);
  f.instance.onSessions([summary]);
  await mutes.setMuted('reviewer', true);
  assert.deepEqual([...readMutedAgents(file)], ['reviewer'], 'stored on the host');
  // An approval, a failure (blocked goal) and a held request, all muted.
  f.instance.onSessionState({ sessionId: home, frameSource: 'live', snapshot: { toolApproval: { id: 'a1' } } });
  f.instance.onSessionState({
    sessionId: home,
    frameSource: 'live',
    snapshot: { goal: { id: 'g1', status: 'blocked', blocker: 'build failed' } },
  });
  f.instance.onHeldRequest({ sessionId: home, agentName: 'reviewer', requestId: 'held_2' });
  await settle();
  assert.equal(f.sent.length, 0, 'no push while muted');
  // In-app state is untouched: the summary (unread) and the attention mark.
  assert.deepEqual(summary, before);
  assert.equal(summary.messageCount > summary.readMessageCount, true);
  assert.equal(
    sessionAttention({ needsUser: true, unread: summary.messageCount > summary.readMessageCount }),
    'needs-you',
    'the Agents-list attention mark still reads from the pending approval'
  );
  // Another agent is not affected; unmuting restores pushes.
  f.instance.onSessionState({
    sessionId: 'sess_home_writer',
    frameSource: 'live',
    snapshot: { toolApproval: { id: 'w1' } },
  });
  await settle();
  assert.equal(f.sent.length, 1);
  await mutes.setMuted('reviewer', false);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).muted, []);
  f.instance.onSessionState({ sessionId: home, frameSource: 'live', snapshot: { toolApproval: { id: 'a2' } } });
  f.instance.onHeldRequest({ sessionId: home, agentName: 'reviewer', requestId: 'held_3' });
  await settle();
  assert.equal(f.sent.length, 3);
  assert.deepEqual(
    f.sent.slice(1).map((push) => push.approvalId),
    ['a2', 'held_3']
  );
});
