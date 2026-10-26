import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  BROWSER_CREDENTIAL_AUTOFILL_FUNCTION,
  BROWSER_SECRET_FIELD_FUNCTION,
  BROWSER_SECRET_FILL_FUNCTION,
  createBrowserCredentialFill,
} from './credential-autofill.ts';

/** Plain objects of this realm, as returnByValue hands them back. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** A page whose inputs all lay out visibly, with the secret field functions. */
function secretPage(html) {
  const dom = new JSDOM(`<!doctype html>${html}`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://accounts.example.test/verify',
  });
  for (const input of dom.window.document.querySelectorAll('input')) {
    input.getBoundingClientRect = () => ({ left: 0, top: 0, right: 40, bottom: 30, width: 40, height: 30 });
  }
  const pick = dom.window.eval(`(${BROWSER_SECRET_FIELD_FUNCTION})`);
  const fill = dom.window.eval(`(${BROWSER_SECRET_FILL_FUNCTION})`);
  return {
    dom,
    pick,
    fill,
    // Request time reads the form (and a code's length); a fill goes to the
    // elements picked then, bound as the host binds them.
    run: async (request) => {
      const bound = await pick({ form: request.form, hint: request.hint });
      if (typeof request.value !== 'string') {
        return bound ? { form: bound.form, ...(bound.codeLength ? { length: bound.codeLength } : {}) } : { form: '' };
      }
      const targets = bound ? [...bound] : [];
      const { value, username } = request;
      return plain(
        await fill({ form: bound?.form || request.form, value, username, types: bound?.types || '' }, ...targets)
      );
    },
    value: (selector) => dom.window.document.querySelector(selector).value,
  };
}

test('a one-time code field is found (autocomplete, numeric, its own boxes) and filled; its length comes from maxlength', async () => {
  let page = secretPage(
    '<form><input id="pw" type="password"><input id="code" autocomplete="one-time-code" maxlength="8"></form>'
  );
  try {
    assert.deepEqual(await page.run({ form: 'otp' }), { form: 'otp', length: 8 });
    assert.deepEqual(await page.run({ form: 'otp', value: '73059123' }), { filled: true });
    assert.equal(page.value('#code'), '73059123');
    assert.equal(page.value('#pw'), '', 'a code never lands in the password');
  } finally {
    page.dom.window.close();
  }
  page = secretPage('<input id="pin" inputmode="numeric" maxlength="6">');
  try {
    assert.deepEqual(await page.run({}), { form: 'otp', length: 6 }, 'a short numeric field is a code');
  } finally {
    page.dom.window.close();
  }
  page = secretPage(
    `<form>${[1, 2, 3, 4, 5, 6].map((n) => `<input id="d${n}" inputmode="numeric" maxlength="1">`).join('')}</form>`
  );
  try {
    assert.deepEqual(await page.run({}), { form: 'otp', length: 6 }, 'one box per digit');
    assert.deepEqual(await page.run({ form: 'otp', value: '482190' }), { filled: true });
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6].map((n) => page.value(`#d${n}`)),
      ['4', '8', '2', '1', '9', '0']
    );
  } finally {
    page.dom.window.close();
  }
  // The field the agent names wins over the first one on the page.
  page = secretPage('<input id="a" type="password"><input id="b" name="sms_token" type="text">');
  try {
    assert.deepEqual(await page.run({ hint: 'sms_token' }), { form: 'otp', length: 6 });
  } finally {
    page.dom.window.close();
  }
});

test('only explicit signals make a code field: a verification email or a generic text field is never one', async () => {
  for (const html of [
    '<input name="verification_email" type="text">',
    '<input id="verificationEmail" type="text">',
    '<input name="nickname" type="text">',
    '<input name="promo_code" type="text">',
    '<input id="footprint" type="text">',
    '<input name="zip" inputmode="numeric" maxlength="5" autocomplete="postal-code">',
    '<input name="phone" type="tel" maxlength="6">',
  ]) {
    const page = secretPage(html);
    try {
      assert.deepEqual(await page.run({}), { form: '' }, html);
    } finally {
      page.dom.window.close();
    }
  }
  // The field the agent names is no code either when it reads as an ordinary field.
  for (const [html, hint] of [
    ['<input name="verification_email" type="text">', 'verification_email'],
    ['<input name="nickname" type="text">', 'nickname'],
  ]) {
    const page = secretPage(html);
    try {
      assert.deepEqual(await page.run({ hint }), { form: '' }, `named ${hint}`);
      assert.deepEqual(await page.run({ form: 'otp', hint, value: '123456' }), { filled: false, stale: true });
      assert.equal(page.value('input'), '', 'nothing typed into it');
    } finally {
      page.dom.window.close();
    }
  }
  for (const [html, request, expected] of [
    ['<input autocomplete="one-time-code">', {}, { form: 'otp', length: 6 }],
    ['<input name="verificationCode" type="text">', {}, { form: 'otp', length: 6 }],
    ['<input id="sms-code" type="text" maxlength="8">', {}, { form: 'otp', length: 8 }],
    ['<input name="pin" pattern="[0-9]*" maxlength="6">', {}, { form: 'otp', length: 6 }],
    // Named by the agent: a short field, or one labeled as a code.
    ['<input name="token_field" type="text" maxlength="6">', { hint: 'token_field' }, { form: 'otp', length: 6 }],
    ['<label>인증번호 <input name="num" type="text"></label>', { hint: 'num' }, { form: 'otp', length: 6 }],
  ]) {
    const page = secretPage(html);
    try {
      assert.deepEqual(await page.run(request), expected, html);
    } finally {
      page.dom.window.close();
    }
  }
});

test('request time may rank: the named field, else the focused one, else the first of the kind (pinned to those elements)', async () => {
  const html =
    '<form><input id="a" name="otp_a" autocomplete="one-time-code" maxlength="6"><input id="b" name="otp_b" autocomplete="one-time-code" maxlength="6"><input id="pw" type="password"></form>';
  const ids = async (request, focus = '') => {
    const page = secretPage(html);
    try {
      if (focus) page.dom.window.document.querySelector(focus).focus();
      const bound = await page.pick(request);
      return bound ? [...bound].map((element) => element.id) : null;
    } finally {
      page.dom.window.close();
    }
  };
  // The label names one field: that one, though another has focus.
  assert.deepEqual(await ids({ form: 'otp', hint: 'otp_b' }, '#a'), ['b']);
  // No label match: the focused field, else the first of the kind.
  assert.deepEqual(await ids({ form: 'otp', hint: 'nonesuch' }, '#b'), ['b']);
  assert.deepEqual(await ids({ form: 'otp', hint: 'nonesuch' }), ['a']);
  // Several matches: the focused one among them, else the first in document order.
  assert.deepEqual(await ids({ form: 'otp', hint: 'otp' }, '#b'), ['b']);
  assert.deepEqual(await ids({ form: 'otp', hint: 'otp' }), ['a']);
  // A match of another kind is no code field: the kind's own focused/first.
  assert.deepEqual(await ids({ form: 'otp', hint: 'pw' }, '#b'), ['b']);
  // No label: the focused field, else the first of the requested kind.
  assert.deepEqual(await ids({ form: 'otp' }, '#b'), ['b']);
  assert.deepEqual(await ids({ form: 'otp' }), ['a']);
  assert.deepEqual(await ids({}, '#b'), ['b']);
  assert.deepEqual(await ids({}), ['pw'], 'no kind asked: a password, then a new password, then a code');
  // Several password fields: the focused one, else the first.
  const two = '<form><input id="p1" type="password"></form><form><input id="p2" type="password"></form>';
  for (const [focus, expected] of [
    ['#p2', ['p2']],
    ['', ['p1']],
  ]) {
    const page = secretPage(two);
    try {
      if (focus) page.dom.window.document.querySelector(focus).focus();
      assert.deepEqual(
        [...(await page.pick({ form: 'login' }))].map((element) => element.id),
        expected
      );
    } finally {
      page.dom.window.close();
    }
  }
});

test("a login's username is the best-ranked candidate of the password's own form (the document without one)", async () => {
  const run = async (html, request = { form: 'login' }) => {
    const page = secretPage(html);
    try {
      const bound = await page.pick(request);
      return bound ? { form: bound.form, ids: [...bound].map((element) => element.id), types: bound.types } : null;
    } finally {
      page.dom.window.close();
    }
  };
  const pw = '<input id="pw" type="password">';
  assert.deepEqual(await run(`<form><input id="u" name="whatever" type="text">${pw}</form>`), {
    form: 'login',
    ids: ['pw', 'u'],
    types: 'password text',
  });
  // The best of several.
  assert.deepEqual(
    (
      await run(
        `<form><input id="n" name="note" type="text"><input id="u" name="userid" autocomplete="username" type="text">${pw}</form>`
      )
    ).ids,
    ['pw', 'u']
  );
  // Search, url and checkbox inputs are no username: password only.
  for (const other of [
    '<input id="x" type="search" name="user">',
    '<input id="x" type="url">',
    '<input id="x" type="checkbox">',
  ]) {
    assert.deepEqual((await run(`<form>${other}${pw}</form>`)).form, 'password', other);
  }
  // Another form's input is not a candidate; without a form element the document is the scope.
  assert.deepEqual(
    (await run(`<form><input id="u" type="text">${pw}</form><form><input id="o" name="user" type="text"></form>`)).ids,
    ['pw', 'u']
  );
  assert.deepEqual((await run(`<input id="a" type="text"><input id="b" name="email" type="text">${pw}`)).ids, [
    'pw',
    'b',
  ]);
});

test("a sign-in's username-only first step binds the username field alone; other pages and other requests bind none", async () => {
  const run = async (html, request) => {
    const page = secretPage(html);
    try {
      const bound = await page.pick(request);
      return bound ? { form: bound.form, ids: [...bound].map((element) => element.id), types: bound.types } : null;
    } finally {
      page.dom.window.close();
    }
  };
  assert.deepEqual(await run('<form><input id="u" type="email" name="email"></form>', { form: 'login' }), {
    form: 'login',
    ids: ['u'],
    types: 'email',
  });
  assert.equal(await run('<input id="q" type="search">', { form: 'login' }), null, 'no username candidate: none');
  assert.equal(
    await run('<form><input id="u" type="email"></form>', {}),
    null,
    'only a sign-in request binds a username'
  );
  assert.equal(await run('<form><input id="u" type="email"></form>', { form: 'otp' }), null);
  // The username step's field is filled as a username: the one bound element, nothing else.
  const page = secretPage('<form><input id="u" type="email"><input id="o" type="text"></form>');
  try {
    const bound = await page.pick({ form: 'login' });
    const result = plain(await page.fill({ form: 'username', value: 'data-team', types: bound.types }, ...bound));
    assert.deepEqual(result, { filled: true });
    assert.equal(page.value('#u'), 'data-team');
    assert.equal(page.value('#o'), '');
  } finally {
    page.dom.window.close();
  }
});

test('a new password goes into the new-password field and its confirmation, never the current password', async () => {
  const page = secretPage(
    `<form>
      <input id="current" type="password" autocomplete="current-password">
      <input id="next" type="password" autocomplete="new-password">
      <input id="again" type="password" autocomplete="new-password">
    </form>`
  );
  try {
    assert.deepEqual(await page.run({ form: 'new-password' }), { form: 'new-password' });
    assert.deepEqual(await page.run({ form: 'new-password', value: 'N3w-pass' }), { filled: true });
    assert.equal(page.value('#next'), 'N3w-pass');
    assert.equal(page.value('#again'), 'N3w-pass');
    assert.equal(page.value('#current'), '');
    // A sign-in form reads as a login (아이디 + 비밀번호), filled together.
    const login = secretPage('<form><input id="user" name="userid" type="text"><input id="pw" type="password"></form>');
    try {
      assert.deepEqual(await login.run({}), { form: 'login' });
      assert.deepEqual(await login.run({ form: 'login', value: 'pw-1', username: 'data-team' }), {
        filled: true,
        usernameFilled: true,
      });
      assert.equal(login.value('#user'), 'data-team');
      assert.equal(login.value('#pw'), 'pw-1');
    } finally {
      login.dom.window.close();
    }
    const none = secretPage('<input type="search" name="q">');
    try {
      assert.deepEqual(await none.run({}), { form: '' }, 'no secret field: none');
    } finally {
      none.dom.window.close();
    }
  } finally {
    page.dom.window.close();
  }
});

test('a secret goes only to the elements bound at request time: moved focus, a removed or changed field never redirects it', async () => {
  const page = secretPage(
    '<form><input id="code" autocomplete="one-time-code" maxlength="6"><input id="other" autocomplete="one-time-code" maxlength="6"></form>'
  );
  const doc = page.dom.window.document;
  try {
    const bound = await page.pick({ form: 'otp', hint: 'code' });
    assert.deepEqual([...bound], [doc.querySelector('#code')], 'request time answers the element itself');
    assert.equal(bound.types, 'text');
    const fill = async (request, ...targets) =>
      plain(await page.fill({ form: 'otp', types: 'text', ...request }, ...targets));
    // The user (or the page) moves focus to another code field meanwhile.
    doc.querySelector('#other').focus();
    assert.deepEqual(await fill({ value: '482190' }, ...bound), { filled: true });
    assert.equal(page.value('#code'), '482190');
    assert.equal(page.value('#other'), '', 'never the focused field');
    // The bound field changed its type, or left the page: refused, with no
    // fallback to the other one.
    doc.querySelector('#code').type = 'password';
    assert.deepEqual(await fill({ value: '111111' }, ...bound), { filled: false, stale: true });
    doc.querySelector('#code').type = 'text';
    doc.querySelector('#code').remove();
    assert.deepEqual(await fill({ value: '111111' }, ...bound), { filled: false, stale: true });
    assert.equal(page.value('#other'), '', 'nothing typed anywhere');
    // Nothing bound, a count other than the bound one, or an element of
    // another document: refused too.
    const other = doc.querySelector('#other');
    assert.deepEqual(await fill({ value: '222222', types: '' }), { filled: false, stale: true });
    assert.deepEqual(await fill({ value: '222222', types: 'text text' }, other), { filled: false, stale: true });
    const foreign = doc.implementation.createHTMLDocument('').body.appendChild(doc.createElement('input'));
    assert.deepEqual(await fill({ value: '222222' }, foreign), { filled: false, stale: true });
    assert.equal(other.value, '');
    assert.equal(foreign.value, '');
  } finally {
    page.dom.window.close();
  }
});

test("a secret fill binds each element's node and the main-frame document, and refuses — sending nothing — once either is gone", async () => {
  const SECRET = 'S3NT1NEL-bound-node-55';
  const sent = [];
  const remembered = [];
  const page = { loaderId: 'L1', nodeAlive: true, onSent: () => {} };
  const service = createBrowserCredentialFill({
    cdp: {
      call: async (_guest, method, params, _signal, options) => {
        options?.beforeDispatch?.();
        sent.push({ method, params });
        page.onSent(method);
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: page.loaderId } } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
        if (method === 'Runtime.getProperties') {
          return {
            result: [
              { name: '0', value: { type: 'object', objectId: 'pw-then' } },
              { name: '1', value: { type: 'object', objectId: 'user-then' } },
              { name: 'length', value: { type: 'number', value: 2 } },
              { name: 'form', value: { type: 'string', value: 'login' } },
              { name: 'types', value: { type: 'string', value: 'password email' } },
            ],
          };
        }
        if (method === 'DOM.describeNode') return { node: { backendNodeId: params.objectId === 'pw-then' ? 42 : 43 } };
        if (method === 'DOM.resolveNode') {
          if (!page.nodeAlive) throw new Error('No node with given id found');
          return { object: { objectId: `node-${params.backendNodeId}` } };
        }
        if (method === 'Runtime.releaseObjectGroup') return {};
        if (params.returnByValue === false) return { result: { type: 'object', subtype: 'array', objectId: 'picked' } };
        return { result: { value: { filled: true, usernameFilled: true } } };
      },
    },
    rememberSecret: (_guest, value) => remembered.push(value),
    forgetSecret() {},
    redactText: (_guest, text) => text,
  });
  const guest = { getURL: () => 'https://bank.example/login', isDestroyed: () => false };
  const secretSent = () => sent.some(({ params }) => JSON.stringify(params ?? {}).includes(SECRET));
  const targets = [
    { node: 42, type: 'password' },
    { node: 43, type: 'email' },
  ];
  const request = { form: 'login', value: SECRET, username: 'data-team', targets, document: 'main:L1' };

  assert.deepEqual(await service.inspectSecretField(guest, { hint: 'pw' }), {
    form: 'login',
    targets,
    document: 'main:L1',
  });
  assert.equal(await service.pageDocument(guest), 'main:L1');

  sent.length = 0;
  assert.deepEqual(await service.fillSecretField(guest, request), { filled: true, usernameFilled: true });
  assert.deepEqual(
    sent.filter(({ method }) => method === 'DOM.resolveNode').map(({ params }) => params.backendNodeId),
    [42, 43],
    'exactly the bound nodes'
  );
  const fill = sent.find(({ method }) => method === 'Runtime.callFunctionOn');
  assert.deepEqual(fill.params.arguments.slice(1), [{ objectId: 'node-42' }, { objectId: 'node-43' }]);
  assert.equal(fill.params.arguments[0].value.types, 'password email');

  // A bound node is gone: stale, and the value never left this process.
  page.nodeAlive = false;
  sent.length = 0;
  remembered.length = 0;
  assert.deepEqual(await service.fillSecretField(guest, request), { filled: false, stale: true });
  assert.equal(secretSent(), false);
  assert.deepEqual(remembered, []);
  // Never bound to an element or a document: refused before anything is dispatched.
  sent.length = 0;
  assert.deepEqual(await service.fillSecretField(guest, { ...request, targets: [] }), { filled: false, stale: true });
  assert.deepEqual(await service.fillSecretField(guest, { ...request, document: '' }), { filled: false, stale: true });
  assert.deepEqual(sent, []);
  // Another document at the same address (a reload): a page change.
  page.nodeAlive = true;
  page.loaderId = 'L2';
  await assert.rejects(service.fillSecretField(guest, request), (error) => error.name === 'BrowserPageChangedError');
  // ...or one loaded while the isolated world was being made.
  page.loaderId = 'L1';
  page.onSent = (method) => {
    if (method === 'Page.createIsolatedWorld') page.loaderId = 'L3';
  };
  await assert.rejects(service.fillSecretField(guest, request), /page changed.*input was not sent/);
  assert.equal(secretSent(), false);
  assert.deepEqual(remembered, [], 'nothing is remembered for a page that moved');
});

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
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'L1' } } };
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
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'L1' } } };
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
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'L1' } } };
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

test('an automatic fill is pinned to the main-frame document: a same-address swap mid-step types nothing', async () => {
  const SENTINEL = 'S3NT1NEL-auto-pin-31';
  const sent = [];
  const page = { loaderId: 'L1', onSent: () => {} };
  const service = createBrowserCredentialFill({
    cdp: {
      call: async (_guest, method, params, _signal, options) => {
        options?.beforeDispatch?.();
        sent.push({ method, params });
        page.onSent(method);
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: page.loaderId } } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
        if (method === 'Runtime.releaseObjectGroup') return {};
        return { result: { value: { usernameFilled: true, passwordFilled: true } } };
      },
    },
    rememberSecret() {},
    forgetSecret() {},
    redactText: (_guest, text) => text,
  });
  const guest = { getURL: () => 'https://bank.example/login', isDestroyed: () => false };
  const credential = { username: 'data-team', password: SENTINEL };
  const typed = () =>
    sent.some(({ method, params }) => method === 'Runtime.callFunctionOn' && JSON.stringify(params).includes(SENTINEL));
  // Unchanged: filled.
  assert.equal((await service.fillCredentialInGuest(guest, credential, undefined, '')).passwordFilled, true);
  // The document is swapped (same address, new loader) while the world is made.
  sent.length = 0;
  page.onSent = (method) => {
    if (method === 'Page.createIsolatedWorld') page.loaderId = 'L2';
  };
  await assert.rejects(
    service.fillCredentialInGuest(guest, credential, undefined, ''),
    (error) => error.name === 'BrowserPageChangedError'
  );
  assert.equal(typed(), false);
  // A step bound to the document it was read on refuses another one at once.
  page.onSent = () => {};
  sent.length = 0;
  await assert.rejects(
    service.fillCredentialInGuest(guest, credential, undefined, '', false, 'main:L1'),
    (error) => error.name === 'BrowserPageChangedError'
  );
  assert.equal(typed(), false);
  assert.equal(
    (await service.fillCredentialInGuest(guest, credential, undefined, '', false, 'main:L2')).passwordFilled,
    true
  );
});
