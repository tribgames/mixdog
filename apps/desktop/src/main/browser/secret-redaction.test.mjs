import assert from 'node:assert/strict';
import test from 'node:test';

import { createSecretInputs, REDACTED_MARKER, secretInputs } from '../secret-input.ts';
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
