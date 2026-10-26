import assert from 'node:assert/strict';
import test from 'node:test';

import { createSavedLoginRegistry } from '../saved-login-registry.ts';
import { createSecretInputs, REDACTED_MARKER, SAVED_LOGIN_MARKER, secretInputs } from '../secret-input.ts';
import { createSessionSecrets } from '../session-secrets.ts';
import { guardBrowserSecrets } from './agent-bridge.ts';

const PASSWORD = 'S3NT1NEL-echoed-password-61';
const signal = new AbortController().signal;

test('a page that echoes the filled password returns [redacted] to the model, whichever tab it reads', async () => {
  assert.equal(REDACTED_MARKER, '[redacted]');
  secretInputs.remember('s-echo', PASSWORD);
  try {
    const page = async () => ({
      text: `URL: https://shop.example/account\n- textbox "Password" value=${PASSWORD}\nconsole: ${PASSWORD}`,
    });
    const reply = await guardBrowserSecrets({ action: 'snapshot', session_id: 's-echo' }, signal, page);
    assert.equal(
      reply.text,
      'URL: https://shop.example/account\n- textbox "Password" value=[redacted]\nconsole: [redacted]'
    );
    // An error message travels the same way.
    await assert.rejects(
      guardBrowserSecrets({ action: 'evaluate', session_id: 's-echo' }, signal, async () => {
        throw new Error(`ReferenceError near ${PASSWORD}`);
      }),
      (error) => error.message === 'ReferenceError near [redacted]'
    );
    // Another session is untouched, and so is output without the secret.
    const other = await guardBrowserSecrets({ action: 'snapshot', session_id: 's-other' }, signal, async () => ({
      text: PASSWORD,
    }));
    assert.equal(other.text, PASSWORD);
    const plain = await guardBrowserSecrets({ action: 'snapshot', session_id: 's-echo' }, signal, async () => ({
      text: 'hello',
    }));
    assert.equal(plain.text, 'hello');
  } finally {
    secretInputs.forget('s-echo');
  }
  // Cleared when the session ends.
  const after = await guardBrowserSecrets({ action: 'snapshot', session_id: 's-echo' }, signal, async () => ({
    text: PASSWORD,
  }));
  assert.equal(after.text, PASSWORD);
});

test('the registry keeps every non-empty secret of a session, of any length and count, until it ends', () => {
  const inputs = createSecretInputs();
  inputs.remember('s1', '731');
  inputs.remember('s1', '');
  assert.deepEqual(inputs.secretsOf('s1'), ['731'], 'a three-character value is kept, an empty one is not');
  assert.equal(inputs.redact('s1', 'cvv 731 ok'), 'cvv [redacted] ok');
  // The 65th value (and every later one) leaves the first in place.
  for (let n = 1; n < 100; n += 1) inputs.remember('s1', `secret-${String(n).padStart(3, '0')}`);
  assert.equal(inputs.secretsOf('s1').length, 100);
  assert.equal(
    inputs.redact('s1', 'x 731 y secret-001 z secret-064 w secret-099'),
    'x [redacted] y [redacted] z [redacted] w [redacted]'
  );
  // A secret holding a shorter one is replaced whole, whichever came first.
  inputs.remember('s1', '7314242');
  assert.equal(inputs.redact('s1', 'n 7314242 m'), 'n [redacted] m');
  inputs.forget('s1');
  assert.deepEqual(inputs.secretsOf('s1'), []);
  assert.equal(inputs.redact('s1', 'cvv 731'), 'cvv 731');
});

import { createBrowserCredentialFill } from './credential-autofill.ts';

test("the toolkit's credential fill registers a typed secret with the owning session — end to end, usernames never", async () => {
  const { browserCredentialFillHost } = await import('./credential-fill-host.ts');
  const PW = 'S3NT1NEL-toolkit-pw-77';
  const remembered = new Set();
  const state = {
    rememberSecret: (_guest, value) => remembered.add(value),
    forgetSecret: (_guest, value) => remembered.delete(value),
    redactText: (_guest, value) => String(value),
  };
  const guest = { getURL: () => 'https://shop.example/login', isDestroyed: () => false };
  const sessions = {
    sessionIdForGuest: (page) => (page === guest ? 's-toolkit' : undefined),
    currentGuest: () => guest,
  };
  const cdp = {
    call: async (_guest, method, params) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'L1' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      if (method === 'DOM.resolveNode') return { object: { objectId: `node-${params.backendNodeId}` } };
      if (method === 'Runtime.releaseObjectGroup') return {};
      return { result: { value: { filled: true } } };
    },
  };
  const service = createBrowserCredentialFill(browserCredentialFillHost(state, cdp, sessions));
  const base = { document: 'main:L1', url: 'https://shop.example/login' };
  try {
    await service.fillSecretField(guest, {
      ...base,
      form: 'username',
      value: 'data-team',
      targets: [{ node: 1, type: 'email' }],
    });
    assert.deepEqual(secretInputs.secretsOf('s-toolkit'), [], 'a username is no secret');
    assert.deepEqual([...remembered], []);
    await service.fillSecretField(guest, {
      ...base,
      form: 'password',
      value: PW,
      targets: [{ node: 2, type: 'password' }],
    });
    assert.deepEqual(secretInputs.secretsOf('s-toolkit'), [PW], 'the session now knows it');
    assert.deepEqual([...remembered], [PW], 'and so does the page');
    // Any later output of that session hides it, never the username.
    const reply = await guardBrowserSecrets({ action: 'snapshot', session_id: 's-toolkit' }, signal, async () => ({
      text: `signed in as data-team; password echo ${PW}`,
    }));
    assert.equal(reply.text, 'signed in as data-team; password echo [redacted]');
  } finally {
    secretInputs.forget('s-toolkit');
  }
});

test('saved-login passwords are redacted whole, longest first, before session secrets; forget clears focus', () => {
  const inputs = createSecretInputs();
  const turn = { sessionId: 's2', turnId: 1, ownerId: '0123456789abcdef0123456789abcdef0123' };
  inputs.remember('s1', 'Pa55');
  assert.equal(inputs.rememberSavedLogin(turn, ['Pa55word', 'Pa55word-long']), true);
  assert.equal(
    inputs.redact('s1', 'a Pa55word-long b Pa55word c Pa55'),
    'a [saved login] b [saved login] c [redacted]'
  );
  assert.equal(inputs.redact('s3', 'Pa55word Pa55'), '[saved login] Pa55', 'saved logins for every session');
  // A short password is held too; an empty spelling hides nothing and is skipped.
  assert.equal(inputs.rememberSavedLogin(turn, ['abc', '']), true);
  assert.equal(inputs.redact('s3', 'abc and more'), '[saved login] and more');
  inputs.armFocus('s1');
  inputs.clearFocus('s1');
  assert.equal(inputs.focusArmed('s1'), false);
  inputs.armFocus('s1');
  inputs.forget('s1');
  assert.equal(inputs.focusArmed('s1'), false);
  assert.deepEqual(inputs.secretsOf('s1'), []);
});

test('a marker is opaque to every redaction: redacting twice is redacting once, and no redactor rewrites another’s marker', () => {
  assert.equal(SAVED_LOGIN_MARKER, '[saved login]');
  const turn = { sessionId: 's2', turnId: 1, ownerId: '0123456789abcdef0123456789abcdef0123' };
  const twice = (redact, text) => {
    const once = redact(text);
    assert.equal(redact(once), once, `redacting twice changes ${JSON.stringify(text)}`);
    return once;
  };

  // A one-character secret: the letters of a marker already written are not the secret.
  const single = createSessionSecrets();
  single.remember('s1', 'e');
  const redactSingle = (text) => single.redact('s1', text);
  assert.equal(twice(redactSingle, 'e [redacted] e'), '[redacted] [redacted] [redacted]');
  assert.equal(twice(redactSingle, 'see [saved login]'), 's[redacted][redacted] [saved login]');
  assert.equal(redactSingle(redactSingle(redactSingle('e'))), '[redacted]');

  // Overlapping secrets: a later one never matches inside the marker an earlier one wrote.
  const overlapping = createSessionSecrets();
  for (const secret of ['abc', 'bcd', 'red', 'cted']) overlapping.remember('s1', secret);
  const redactOverlapping = (text) => overlapping.redact('s1', text);
  assert.equal(twice(redactOverlapping, 'abcd red'), '[redacted]d [redacted]');
  assert.equal(twice(redactOverlapping, 'abc red [redacted] cted'), '[redacted] [redacted] [redacted] [redacted]');
  const registry = createSavedLoginRegistry();
  assert.equal(registry.rememberSavedLogin(turn, ['abc', 'ab', 'bc', 'ed']), true);
  const redactSaved = (text) => registry.redact(text);
  assert.equal(twice(redactSaved, 'abcbc ab ed'), '[saved login][saved login] [saved login] [saved login]');

  // A marker written by one redactor survives the other, in either order.
  assert.equal(redactSaved('[redacted] [saved login] ed'), '[redacted] [saved login] [saved login]');
  const inputs = createSecretInputs();
  inputs.remember('s1', 'e');
  inputs.remember('s1', 'in');
  assert.equal(inputs.rememberSavedLogin(turn, ['ed', 'Pa55word']), true);
  const redactAll = (text) => inputs.redact('s1', text);
  assert.equal(
    twice(redactAll, 'Pa55word [redacted] [saved login] e ed'),
    '[saved login] [redacted] [saved login] [redacted] [saved login]'
  );
});

test('a secret next to a marker is still redacted', () => {
  const inputs = createSecretInputs();
  const turn = { sessionId: 's2', turnId: 1, ownerId: '0123456789abcdef0123456789abcdef0123' };
  inputs.remember('s1', 'e');
  inputs.remember('s1', 'x');
  assert.equal(inputs.redact('s1', 'e[redacted]e'), '[redacted][redacted][redacted]');
  assert.equal(inputs.redact('s1', 'x[saved login]x'), '[redacted][saved login][redacted]');
  assert.equal(inputs.rememberSavedLogin(turn, ['pw']), true);
  assert.equal(
    inputs.redact('s1', 'pw[redacted]pw[saved login]pw'),
    '[saved login][redacted][saved login][saved login][saved login]'
  );
});

test('request bindings: a page binding and a window binding never answer for each other; bad targets bind nothing', () => {
  const inputs = createSecretInputs();
  const id = 'secret_0123456789abcdef';
  assert.equal(inputs.bindComputer(id, { sessionId: 's1', windowId: 'hwnd 0x2', ref: 'e7' }), false);
  assert.equal(inputs.bindComputer(id, { sessionId: 's1', windowId: 'h'.repeat(129), ref: 'e7' }), false);
  assert.equal(inputs.bindComputer(id, { sessionId: '', windowId: 'hwnd:0x2', ref: 'e7' }), false);
  assert.equal(inputs.computerBinding(id), null);
  assert.equal(inputs.bindComputer(id, { sessionId: 's1', windowId: 'hwnd:0x2', ref: 'e7' }), true);
  assert.equal(inputs.binding(id), null);
  assert.deepEqual(inputs.computerBinding(id), { sessionId: 's1', windowId: 'hwnd:0x2', ref: 'e7' });
  assert.equal(inputs.bind('bad', { sessionId: 's1', pageId: 'p', origin: 'o', form: 'otp', document: 'd' }), false);
  inputs.bind(id, { sessionId: 's1', pageId: 'p', origin: 'o', form: 'otp', document: 'd' });
  assert.equal(inputs.computerBinding(id), null);
  assert.equal(inputs.binding(id)?.pageId, 'p');
  inputs.provide(id, 'value');
  inputs.discard(id);
  assert.equal(inputs.has(id), false);
  assert.equal(inputs.binding(id), null);
});
