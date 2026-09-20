import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { BROWSER_CREDENTIAL_AUTOFILL_FUNCTION, createBrowserCredentialFill } from './credential-autofill.ts';

test('stored credential fill targets the current login form and emits framework events without returning secrets', async () => {
  const dom = new JSDOM(
    `<!doctype html>
    <form>
      <input id="identity" name="user_id" type="text">
      <input id="password" name="pw" type="password">
      <input id="new-password" type="password" autocomplete="new-password">
    </form>`,
    {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      url: 'https://accounts.example.test/login',
    }
  );
  try {
    const events = [];
    for (const input of dom.window.document.querySelectorAll('input')) {
      input.getBoundingClientRect = () => ({
        left: 10,
        top: 10,
        right: 210,
        bottom: 40,
        width: 200,
        height: 30,
        x: 10,
        y: 10,
        toJSON() {
          return this;
        },
      });
      input.addEventListener('input', () => events.push(`${input.id}:input`));
      input.addEventListener('change', () => events.push(`${input.id}:change`));
    }
    const fill = dom.window.eval(`(${BROWSER_CREDENTIAL_AUTOFILL_FUNCTION})`);
    const result = await fill({
      username: 'fixture-user',
      password: 'fixture-password',
    });
    assert.equal(dom.window.document.querySelector('#identity').value, 'fixture-user');
    assert.equal(dom.window.document.querySelector('#password').value, 'fixture-password');
    assert.equal(dom.window.document.querySelector('#new-password').value, '');
    assert.equal(result.usernameFilled, true);
    assert.equal(result.passwordFilled, true);
    assert.doesNotMatch(JSON.stringify(result), /fixture-user|fixture-password/);
    assert.deepEqual(events, ['identity:input', 'identity:change', 'password:input', 'password:change']);
  } finally {
    dom.window.close();
  }
});

test('stored credential cancellation reaches every CDP phase and prevents later dispatch', async () => {
  for (const abortAt of [0, 1, 2, 3]) {
    const controller = new AbortController();
    const reason = new Error('user took control');
    const sent = [];
    const guest = { getURL: () => 'https://fixture.example/login', isDestroyed: () => false };
    const service = createBrowserCredentialFill({
      cdp: {
        call: async (target, method, _params, signal, options) => {
          assert.equal(target, guest);
          assert.equal(signal, controller.signal);
          options.beforeDispatch();
          sent.push(method);
          if (sent.length === abortAt) controller.abort(reason);
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
          if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
          return { result: { value: { usernameFilled: true, passwordFilled: true } } };
        },
      },
      rememberSecret() {},
      forgetSecret() {},
      redactText: (_guest, text) => text,
    });
    if (abortAt === 0) controller.abort(reason);
    await assert.rejects(
      service.fillCredentialInGuest(
        guest,
        { username: 'fixture-user', password: 'fixture-password' },
        controller.signal
      ),
      (error) => error === reason
    );
    assert.equal(sent.length, abortAt);
  }
});

test('navigation while preparing a stored login prevents secret input on the replacement page', async () => {
  let url = 'https://fixture.example/login';
  const sent = [];
  const service = createBrowserCredentialFill({
    cdp: {
      call: async (_guest, method, _params, _signal, options) => {
        options.beforeDispatch();
        sent.push(method);
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
        url = 'https://other.example/login';
        return { executionContextId: 7 };
      },
    },
    rememberSecret: () => assert.fail('navigation must be refused before secret input'),
    forgetSecret() {},
    redactText: (_guest, text) => text,
  });
  await assert.rejects(
    service.fillCredentialInGuest(
      { getURL: () => url, isDestroyed: () => false },
      { username: 'fixture-user', password: 'fixture-password' }
    ),
    /page changed.*input was not sent/
  );
  assert.deepEqual(sent, ['Page.getFrameTree', 'Page.createIsolatedWorld']);
});

test('credential input dispatch failures stop before writing and are not reported as success', async () => {
  const dom = new JSDOM('<input type="password">', { runScripts: 'outside-only' });
  try {
    const input = dom.window.document.querySelector('input');
    input.getBoundingClientRect = () => ({ width: 200, height: 30 });
    const events = [];
    input.dispatchEvent = (event) => {
      events.push(event.type);
      if (event.type === 'beforeinput') throw new Error('input event rejected');
      return true;
    };
    const fill = dom.window.eval(`(${BROWSER_CREDENTIAL_AUTOFILL_FUNCTION})`);
    await assert.rejects(fill({ password: 'private-fixture' }), /input event rejected/);
    assert.equal(input.value, '');
    assert.deepEqual(events, ['focusin', 'keydown', 'beforeinput']);
  } finally {
    dom.window.close();
  }
});

test('credential script errors retain their reason without exposing a remembered password', async () => {
  const secret = 'private-fixture';
  const remembered = new Set();
  const service = createBrowserCredentialFill({
    cdp: {
      call: async (_guest, method) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
        return { exceptionDetails: { exception: { description: `input event rejected: ${secret}\nstack` } } };
      },
    },
    rememberSecret: (_guest, value) => remembered.add(value),
    forgetSecret: () => assert.fail('a failed dispatched fill must retain secret redaction'),
    redactText: (_guest, text) => text.replaceAll(secret, '[REDACTED]'),
  });
  await assert.rejects(
    service.fillCredentialInGuest(
      {
        getURL: () => 'https://fixture.example/',
        isDestroyed: () => false,
      },
      { username: 'fixture-user', password: secret }
    ),
    /^Error: input event rejected: \[REDACTED\]$/
  );
  assert.ok(remembered.has(secret));
});
