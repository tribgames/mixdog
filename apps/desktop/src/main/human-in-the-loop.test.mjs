import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { waitUntil } from './bounded-wait.mjs';
import { decryptNativePush } from '../shared/native-push-crypto.ts';
import { sessionAttention } from '../shared/session-attention.ts';
import { createNotificationPreferencesStore, notificationPreferencesPath } from './notification-preferences.ts';
import { fillSecretInput } from './browser/host-agent.ts';
import { beginComputerOperation } from './human-only-approval.ts';
import { requiredToolApprovalDecision } from './ipc-validation.ts';
import { createPushNotifier, heldRequestPushText } from './push-notifier.ts';
import { bindComputerSecret, createSecretInputs, typeComputerSecret } from './secret-input.ts';
import { createTakeoverGate } from './takeover-gate.ts';

const SENTINEL = 'S3NT1NEL-desktop-secret-41aa';
const REQUEST = 'secret_0123456789abcdef';
/** What secret_bind records for a page: its main-frame document and the exact element. */
const BOUND = { document: 'main:L1', targets: [{ node: 7, type: 'password' }] };

test('secret input: one-shot slot, only the target field receives it, replies are redacted', async () => {
  const inputs = createSecretInputs();
  assert.equal(inputs.provide('not-an-id', SENTINEL), false);
  assert.equal(inputs.provide(REQUEST, SENTINEL), true);
  assert.equal(inputs.bindComputer(REQUEST, { sessionId: 's1', windowId: 'hwnd:0x2', ref: 'e7' }), true);
  const typed = [];
  const reply = await typeComputerSecret(
    { session_id: 's1', request_id: REQUEST, window_id: 'hwnd:0x2', ref: 'e7' },
    async (command) => {
      typed.push(command);
      return { text: `field now shows ${SENTINEL}` };
    },
    inputs,
    () => {}
  );
  assert.deepEqual(reply, { text: 'entered' }, 'the reply says only entered');
  assert.deepEqual(typed, [{ action: 'type', text: SENTINEL, session_id: 's1', ref: 'e7', window_id: 'hwnd:0x2' }]);
  assert.equal(inputs.take(REQUEST), '', 'the value is gone after one use');
  assert.deepEqual(
    await typeComputerSecret({ session_id: 's1', request_id: REQUEST }, async () => assert.fail('no value'), inputs),
    { text: 'expired' }
  );
  assert.equal(inputs.redact('s1', `ocr: ${SENTINEL}`), 'ocr: [redacted]');
  assert.equal(inputs.focusArmed('s1'), true, 'captures are withheld while the field may be focused');
  inputs.forget('s1');
  assert.equal(inputs.redact('s1', SENTINEL), SENTINEL);

  // Browser: the isolated-world fill gets the value; the bridge reply does not.
  assert.equal(inputs.provide(REQUEST, SENTINEL), true);
  inputs.bind(REQUEST, { sessionId: 's1', pageId: 'p1', origin: 'https://bank.example', form: 'password', ...BOUND });
  const fills = [];
  const guest = { isDestroyed: () => false, getURL: () => 'https://bank.example/login' };
  const result = await fillSecretInput(
    {
      pageById: (_session, pageId) => (pageId === 'p1' ? guest : null),
      fill: async (_guest, request) => {
        fills.push(request);
        return { filled: true };
      },
      assertFree: () => {},
    },
    's1',
    REQUEST,
    undefined,
    inputs
  );
  assert.deepEqual(result, { text: 'entered' });
  assert.deepEqual(fills, [{ form: 'password', value: SENTINEL, username: '', ...BOUND }]);
});

test('a computer secret goes only to the window and field it was bound to: unbound or junk targets are refused, never typed', async () => {
  const typed = [];
  const execute = async (command) => typed.push(command);
  const free = () => {};
  // Nothing bound (an empty identity): no field to type into, not the focused one.
  let inputs = createSecretInputs();
  inputs.provide(REQUEST, SENTINEL);
  assert.deepEqual(await typeComputerSecret({ session_id: 's1', request_id: REQUEST }, execute, inputs, free), {
    text: 'no_field',
  });
  assert.equal(inputs.has(REQUEST), false, 'dropped unused');
  // An empty or junk window/ref binds nothing.
  for (const [windowId, ref] of [
    ['', ''],
    ['hwnd:0x2', ''],
    ['', 'e7'],
    ['hwnd 0x2; x', 'e7'],
    ['hwnd:0x2', 'e7"]'],
  ]) {
    inputs = createSecretInputs();
    assert.deepEqual(
      bindComputerSecret({ session_id: 's1', request_id: REQUEST, window_id: windowId, ref }, inputs),
      { text: 'no_field' },
      `${windowId} / ${ref}`
    );
    inputs.provide(REQUEST, SENTINEL);
    assert.deepEqual(
      await typeComputerSecret(
        { session_id: 's1', request_id: REQUEST, window_id: windowId, ref },
        execute,
        inputs,
        free
      ),
      { text: 'no_field' }
    );
  }
  // Another target than the bound one, or another session: refused before the value is taken.
  inputs = createSecretInputs();
  assert.deepEqual(
    bindComputerSecret({ session_id: 's1', request_id: REQUEST, window_id: 'hwnd:0x2', ref: 'e7' }, inputs),
    { text: 'bound' }
  );
  inputs.provide(REQUEST, SENTINEL);
  assert.deepEqual(
    await typeComputerSecret(
      { session_id: 's1', request_id: REQUEST, window_id: 'hwnd:0x9', ref: 'e7' },
      execute,
      inputs,
      free
    ),
    { text: 'page_changed' }
  );
  assert.equal(inputs.has(REQUEST), false);
  assert.equal(inputs.computerBinding(REQUEST), null);
  bindComputerSecret({ session_id: 's1', request_id: REQUEST, window_id: 'hwnd:0x2', ref: 'e7' }, inputs);
  inputs.provide(REQUEST, SENTINEL);
  assert.deepEqual(await typeComputerSecret({ session_id: 's2', request_id: REQUEST }, execute, inputs, free), {
    text: 'blocked',
  });
  assert.deepEqual(typed, [], 'nothing was typed anywhere');
  // The bound window or field went away: the input path refuses it, reported as such.
  bindComputerSecret({ session_id: 's1', request_id: REQUEST, window_id: 'hwnd:0x2', ref: 'e7' }, inputs);
  inputs.provide(REQUEST, SENTINEL);
  assert.deepEqual(
    await typeComputerSecret(
      { session_id: 's1', request_id: REQUEST },
      async () => {
        throw new Error('ref e7 is stale; take a fresh snapshot/find');
      },
      inputs,
      free
    ),
    { text: 'page_changed' }
  );
});

/** A browser host for fillSecretInput whose bound page is at `url()`. */
function boundHost(url, { free = true, filled = true } = {}) {
  const fills = [];
  const saved = [];
  const order = [];
  return {
    fills,
    saved,
    order,
    host: {
      pageById: (_session, pageId) => (pageId === 'p1' ? { isDestroyed: () => false, getURL: () => url() } : null),
      fill: async (_guest, request) => {
        order.push('fill');
        fills.push(request);
        return { filled };
      },
      assertFree: (sessionId) => {
        order.push(`lock:${sessionId}`);
        if (!free) throw new Error('blocked');
      },
      saveLogin: async (login) => {
        saved.push(login);
      },
    },
  };
}

test('a secret bound to its page is refused once that page left the origin; never the selected tab', async () => {
  const inputs = createSecretInputs();
  let url = 'https://bank.example/login';
  const b = boundHost(() => url);
  inputs.bind(REQUEST, { sessionId: 's1', pageId: 'p1', origin: 'https://bank.example', form: 'password', ...BOUND });
  inputs.provide(REQUEST, SENTINEL);
  url = 'https://evil.example/login';
  assert.deepEqual(await fillSecretInput(b.host, 's1', REQUEST, undefined, inputs), { text: 'page_changed' });
  assert.deepEqual(b.fills, [], 'nothing reaches a page on another origin');
  assert.equal(inputs.has(REQUEST), false, 'the value is dropped, never kept for another page');
  // A page of another session, or a request never bound, is no target either.
  inputs.provide(REQUEST, SENTINEL);
  assert.deepEqual(await fillSecretInput(b.host, 's2', REQUEST, undefined, inputs), { text: 'blocked' });
  assert.deepEqual(b.fills, []);
});

test("the session's lock is checked before the value is used: a refusal drops it unused", async () => {
  const inputs = createSecretInputs();
  const blocked = boundHost(() => 'https://bank.example/login', { free: false });
  inputs.bind(REQUEST, { sessionId: 's1', pageId: 'p1', origin: 'https://bank.example', form: 'password', ...BOUND });
  inputs.provide(REQUEST, SENTINEL);
  assert.deepEqual(await fillSecretInput(blocked.host, 's1', REQUEST, undefined, inputs), { text: 'blocked' });
  assert.deepEqual(blocked.order, ['lock:s1'], 'asked for this session only, before any fill');
  assert.equal(inputs.has(REQUEST), false, 'the refused value leaves memory, never filled');
  assert.equal(inputs.binding(REQUEST), null, 'and so does its binding');
  inputs.bind(REQUEST, { sessionId: 's1', pageId: 'p1', origin: 'https://bank.example', form: 'password', ...BOUND });
  inputs.provide(REQUEST, SENTINEL);
  const free = boundHost(() => 'https://bank.example/login');
  assert.deepEqual(await fillSecretInput(free.host, 's1', REQUEST, undefined, inputs), { text: 'entered' });
  assert.deepEqual(free.order, ['lock:s1', 'fill']);
  // Computer Use: the same order.
  inputs.provide(REQUEST, SENTINEL);
  inputs.bindComputer(REQUEST, { sessionId: 's1', windowId: 'hwnd:0x2', ref: 'e7' });
  const typed = [];
  const refused = await typeComputerSecret(
    { session_id: 's1', request_id: REQUEST },
    async (command) => typed.push(command),
    inputs,
    () => {
      throw new Error('blocked');
    }
  );
  assert.deepEqual(refused, { text: 'blocked' });
  assert.deepEqual(typed, []);
  assert.equal(inputs.has(REQUEST), false, 'dropped unused after the refusal');
});

test('a refused secret leaves memory on every terminal refusal: blocked, page changed, no field', async () => {
  const bindAndProvide = (inputs) => {
    inputs.bind(REQUEST, { sessionId: 's1', pageId: 'p1', origin: 'https://bank.example', form: 'login', ...BOUND });
    inputs.provide(REQUEST, SENTINEL);
    inputs.provide(`${REQUEST}-username`, 'data-team');
    inputs.provide(`${REQUEST}-save`, '1');
  };
  const gone = (inputs) =>
    [REQUEST, `${REQUEST}-username`, `${REQUEST}-save`].every((id) => !inputs.has(id)) &&
    inputs.binding(REQUEST) === null;
  for (const [outcome, host] of [
    ['blocked', boundHost(() => 'https://bank.example/login', { free: false })],
    ['page_changed', boundHost(() => 'https://elsewhere.example/')],
    ['no_field', boundHost(() => 'https://bank.example/login', { filled: false })],
  ]) {
    const inputs = createSecretInputs();
    bindAndProvide(inputs);
    assert.deepEqual(await fillSecretInput(host.host, 's1', REQUEST, undefined, inputs), { text: outcome });
    assert.equal(gone(inputs), true, `${outcome}: every slot and the binding are gone`);
    assert.deepEqual(host.saved, [], `${outcome}: nothing saved`);
  }
});

test('secret slots and bindings expire on their own timers (unref, cleared on use), with no later call', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mockSet = globalThis.setTimeout;
  const mockClear = globalThis.clearTimeout;
  const unrefed = new Set();
  const cleared = new Set();
  const created = [];
  globalThis.setTimeout = (...args) => {
    const handle = mockSet(...args);
    const unref = handle.unref.bind(handle);
    handle.unref = () => {
      unrefed.add(handle);
      return unref();
    };
    created.push(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    cleared.add(handle);
    return mockClear(handle);
  };
  try {
    const inputs = createSecretInputs({ timeoutMs: 1_000, bindingTimeoutMs: 2_000 });
    inputs.bind(REQUEST, {
      sessionId: 's1',
      pageId: 'p1',
      origin: 'https://bank.example',
      form: 'password',
      ...BOUND,
    });
    inputs.provide(REQUEST, SENTINEL);
    assert.equal(created.length, 2, 'one timer per entry');
    assert.ok(
      created.every((handle) => unrefed.has(handle)),
      'no timer keeps the app alive'
    );
    t.mock.timers.tick(999);
    assert.equal(inputs.has(REQUEST), true);
    t.mock.timers.tick(1);
    assert.equal(inputs.has(REQUEST), false, 'the value expired by itself');
    assert.notEqual(inputs.binding(REQUEST), null);
    t.mock.timers.tick(1_000);
    assert.equal(inputs.binding(REQUEST), null, 'the binding too');
    // Used before expiry: its timer is cleared at once.
    inputs.provide(REQUEST, SENTINEL);
    const timer = created.at(-1);
    assert.equal(inputs.take(REQUEST), SENTINEL);
    assert.equal(cleared.has(timer), true, 'taking it clears its timer');
    inputs.provide(REQUEST, SENTINEL);
    inputs.discard(REQUEST);
    assert.equal(cleared.has(created.at(-1)), true, 'discarding it too');
  } finally {
    globalThis.setTimeout = mockSet;
    globalThis.clearTimeout = mockClear;
  }
});

test('a sign-in typed in chat fills 아이디 + 비밀번호 and is saved for the origin only when chosen', async () => {
  const inputs = createSecretInputs();
  const b = boundHost(() => 'https://bank.example/login');
  const bindLogin = () =>
    inputs.bind(REQUEST, { sessionId: 's1', pageId: 'p1', origin: 'https://bank.example', form: 'login', ...BOUND });
  bindLogin();
  inputs.provide(REQUEST, SENTINEL);
  inputs.provide(`${REQUEST}-username`, 'data-team');
  inputs.provide(`${REQUEST}-save`, '1');
  assert.deepEqual(await fillSecretInput(b.host, 's1', REQUEST, undefined, inputs), { text: 'entered' });
  assert.deepEqual(b.fills, [{ form: 'login', value: SENTINEL, username: 'data-team', ...BOUND }]);
  assert.deepEqual(b.saved, [{ origin: 'https://bank.example', username: 'data-team', password: SENTINEL }]);
  assert.equal(inputs.has(`${REQUEST}-username`), false, 'every slot of the request is gone');
  bindLogin();
  inputs.provide(REQUEST, SENTINEL);
  inputs.provide(`${REQUEST}-username`, 'data-team');
  await fillSecretInput(b.host, 's1', REQUEST, undefined, inputs);
  assert.equal(b.saved.length, 1, 'unchecked: not saved');
  // No such field on the page any more: said so.
  const none = boundHost(() => 'https://bank.example/login', { filled: false });
  bindLogin();
  inputs.provide(REQUEST, SENTINEL);
  assert.deepEqual(await fillSecretInput(none.host, 's1', REQUEST, undefined, inputs), { text: 'no_field' });
  assert.deepEqual(none.saved, []);
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

test("a pending screen takeover blocks Computer Use and its session's Browser Use until it leaves the snapshot", async () => {
  const gate = createTakeoverGate();
  const takeover = (id) => ({
    sessionId: 's1',
    snapshot: { toolApproval: id ? { id, kind: 'takeover', takeover: { surface: 'computer' } } : null },
  });
  gate.onSessionState(takeover('t1'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => beginComputerOperation(), /blocked/);
  assert.throws(() => gate.assertFree('s1'), /taken over/);
  gate.assertFree('s2');
  gate.onSessionState(takeover(null));
  await new Promise((resolve) => setImmediate(resolve));
  gate.assertFree('s1');
  beginComputerOperation()();
  gate.onSessionState({ sessionId: 's1', snapshot: { toolApproval: { id: 'a1', kind: 'approval' } } });
  gate.assertFree('s1');
});

const device = () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey().toString('base64url') };
};
const until = (ready) => waitUntil(ready, 'the push to be sent');

function preferencesIn(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mute-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = notificationPreferencesPath(dir);
  const store = createNotificationPreferencesStore({
    filePath: file,
    readLegacy: async () => ({ turnNotifications: true, mutedAgents: [] }),
  });
  return { store, file };
}

function notifier(t, preferences) {
  const phone = device();
  const sent = [];
  const instance = createPushNotifier({
    store: { keys: async () => ({}), list: async () => [], remove: async () => true, removeByClient: async () => true },
    isEnabled: () => true,
    readFinalAnswer: async () => null,
    isClientForeground: () => false,
    preferences: {
      device: (id) => preferences.device(id),
      overrides: () => preferences.overrides(),
      desktopActive: async () => false,
    },
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
  const f = notifier(t, preferencesIn(t).store);
  f.instance.onHeldRequest({ sessionId: 'sess_home_reviewer', agentName: '리뷰어', requestId: 'held_1' });
  await until(() => f.sent.length >= 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].body, '리뷰어가 승인을 기다립니다');
  assert.equal(f.sent[0].body, heldRequestPushText('리뷰어'));
  assert.equal(f.sent[0].approvalId, 'held_1');
  assert.deepEqual(Object.keys(f.sent[0]).sort(), ['approvalId', 'body', 'reason', 'sessionId', 'title']);
});

test('a muted bot pushes nothing — approvals, waits, held requests — while in-app state stays', async (t) => {
  const { store: preferences, file } = preferencesIn(t);
  const f = notifier(t, preferences);
  const mute = (setting) => preferences.setConversation({ kind: 'agent', id: 'reviewer' }, setting);
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
  await mute({ mode: 'muted', until: null });
  assert.deepEqual(
    JSON.parse(readFileSync(file, 'utf8')).overrides.map((entry) => entry.target),
    [{ kind: 'agent', id: 'reviewer' }],
    'stored on the host'
  );
  // An approval, a blocked goal and a held request, all muted.
  f.instance.onSessionState({ sessionId: home, frameSource: 'live', snapshot: { toolApproval: { id: 'a1' } } });
  f.instance.onSessionState({
    sessionId: home,
    frameSource: 'live',
    snapshot: { goal: { id: 'g1', status: 'blocked', blocker: 'build failed' } },
  });
  f.instance.onHeldRequest({ sessionId: home, agentName: 'reviewer', requestId: 'held_2' });
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
  await until(() => f.sent.length >= 1);
  assert.deepEqual(
    f.sent.map((push) => push.approvalId),
    ['w1'],
    'no push while muted: the writer, sent after the muted reviewer events, is the only one'
  );
  await mute({ mode: 'inherit' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).overrides, []);
  f.instance.onSessionState({ sessionId: home, frameSource: 'live', snapshot: { toolApproval: { id: 'a2' } } });
  f.instance.onHeldRequest({ sessionId: home, agentName: 'reviewer', requestId: 'held_3' });
  await until(() => f.sent.length >= 3);
  assert.equal(f.sent.length, 3);
  assert.deepEqual(
    f.sent.slice(1).map((push) => push.approvalId),
    ['a2', 'held_3']
  );
});
