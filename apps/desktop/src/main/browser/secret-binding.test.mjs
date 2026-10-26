import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { createSecretInputs } from '../secret-input.ts';
import { createTakeoverGate } from '../takeover-gate.ts';
import { createBrowserCredentialFill } from './credential-autofill.ts';
import { createBrowserVisualPrivacy, protectSecretNodes } from './visual-privacy.ts';
import { fillBoundLogin, fillSecretInput, handoffPageFacts } from './host-agent.ts';

const SENTINEL = 'S3NT1NEL-bound-secret-90';
const REQUEST = 'secret_0123456789abcdef';
const BIND = 'secret_login-0123456789';
const CREDENTIAL = 'c'.repeat(24);
const LOGIN = 'https://bank.example/login';
const LOGIN_FORM = '<form><input id="user" name="userid" type="text"><input id="pw" type="password"></form>';

/**
 * One browser page over JSDOM behind a CDP port that runs what the isolated
 * fill sends, the way the browser answers it: main frame `main` with a new
 * loader id per document load (a reload included), an isolated world as a
 * context of the document it was made in (gone with it), backend node ids
 * per element, and remote objects for what a call returns by reference.
 */
function browserPage(url, html) {
  const page = { url: '', dom: null, loaderId: '', loads: 0 };
  const load = (nextUrl, nextHtml) => {
    page.dom?.window.close();
    page.url = nextUrl;
    page.dom = new JSDOM(`<!doctype html>${nextHtml}`, {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      url: nextUrl,
    });
    for (const input of page.dom.window.document.querySelectorAll('input')) {
      input.getBoundingClientRect = () => ({ left: 0, top: 0, right: 40, bottom: 30, width: 40, height: 30 });
    }
    page.loaderId = `L${++page.loads}`;
  };
  load(url, html);
  const sent = [];
  const objects = new Map();
  const nodeIds = new Map();
  const contexts = new Map();
  const remote = (value) => {
    if (value === null || typeof value !== 'object') return { type: typeof value, value };
    const objectId = `object-${objects.size + 1}`;
    objects.set(objectId, value);
    return { type: 'object', objectId };
  };
  const call = async (_guest, method, params = {}, _signal, options) => {
    options?.beforeDispatch?.();
    sent.push({ method, params });
    switch (method) {
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'main', loaderId: page.loaderId } } };
      case 'Page.createIsolatedWorld':
        contexts.set(contexts.size + 1, page.dom.window);
        return { executionContextId: contexts.size };
      case 'Runtime.callFunctionOn': {
        if (params.objectId) {
          // A call on a remote object in the page's main world.
          const onObject = page.dom.window.eval(`(${params.functionDeclaration})`);
          return { result: { value: onObject.call(objects.get(params.objectId)) } };
        }
        const window = contexts.get(params.executionContextId);
        if (window !== page.dom.window) throw new Error('Cannot find context with specified id');
        const fn = window.eval(`(${params.functionDeclaration})`);
        const value = await fn(
          ...params.arguments.map((arg) => ('objectId' in arg ? objects.get(arg.objectId) : arg.value))
        );
        return { result: params.returnByValue ? { value: JSON.parse(JSON.stringify(value ?? null)) } : remote(value) };
      }
      case 'Runtime.getProperties': {
        const object = objects.get(params.objectId);
        return { result: Object.getOwnPropertyNames(object).map((name) => ({ name, value: remote(object[name]) })) };
      }
      case 'DOM.describeNode': {
        const node = objects.get(params.objectId);
        let id = [...nodeIds].find(([, known]) => known === node)?.[0];
        if (!id) {
          id = nodeIds.size + 1;
          nodeIds.set(id, node);
        }
        return { node: { backendNodeId: id } };
      }
      case 'DOM.resolveNode': {
        const node = nodeIds.get(params.backendNodeId);
        if (!node) throw new Error('No node with given id found');
        return { object: remote(node) };
      }
      case 'Runtime.releaseObjectGroup':
        return {};
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  const service = createBrowserCredentialFill({
    cdp: { call },
    rememberSecret() {},
    forgetSecret() {},
    redactText: (_guest, text) => text,
    protectNodes: (target, nodes) => protectSecretNodes(target, nodes),
  });
  const guest = { getURL: () => page.url, isDestroyed: () => false };
  return {
    guest,
    service,
    cdp: { call },
    load,
    document: () => page.dom.window.document,
    value: (selector) => page.dom.window.document.querySelector(selector).value,
    /** Whether any CDP call carried `secret` to the page. */
    reached: (secret) => sent.some(({ params }) => JSON.stringify(params).includes(secret)),
    /** The request-time facts host and the fill host of a session's page `p1`. */
    facts: () => ({
      guest: () => guest,
      pageId: () => 'p1',
      document: service.pageDocument,
      inspect: service.inspectSecretField,
      accounts: async () => [{ id: CREDENTIAL, label: 'd•••m' }],
    }),
    fills: (assertFree = () => {}) => ({
      pageById: (_session, pageId) => (pageId === 'p1' ? guest : null),
      fill: service.fillSecretField,
      assertFree,
    }),
  };
}

/** Bind `requestId` for `sessionId` at request time, then hand it the card's value. */
async function bindAndProvide(
  page,
  inputs,
  value = SENTINEL,
  { sessionId = 's1', field = '', requestId = REQUEST } = {}
) {
  const facts = await handoffPageFacts(
    page.facts(),
    sessionId,
    'secret_bind',
    { request_id: requestId, field },
    undefined,
    inputs
  );
  inputs.provide(requestId, value);
  return facts;
}

/** Nothing of the secret reaches a log line. */
function quietConsole(t) {
  return ['log', 'info', 'warn', 'error', 'debug'].map((name) => t.mock.method(console, name, () => {}));
}
const logged = (mocks, secret) =>
  mocks.some((mock) => mock.mock.calls.some((call) => JSON.stringify(call.arguments).includes(secret)));

test('a takeover holds only its own session: its secret is refused before the value is taken, another session’s is entered', async (t) => {
  const gate = createTakeoverGate();
  t.after(() => gate.dispose());
  gate.onSessionState({
    sessionId: 'A',
    snapshot: { toolApproval: { id: 't1', kind: 'takeover', takeover: { surface: 'browser' } } },
  });
  assert.throws(() => gate.assertFree('A'), /taken over/);
  // Session ids compare exactly: no session, or any other id, is not A.
  for (const other of ['B', 'a', 'A ', '', undefined]) gate.assertFree(other);

  const page = browserPage(LOGIN, '<input id="pw" type="password">');
  const inputs = createSecretInputs();
  const taken = [];
  const take = inputs.take;
  inputs.take = (id) => {
    taken.push(id);
    return take(id);
  };
  const lock = (sessionId) => gate.assertFree(sessionId);
  // A's own secret: refused before anything is taken, dropped unused.
  await bindAndProvide(page, inputs, SENTINEL, { sessionId: 'A' });
  assert.deepEqual(await fillSecretInput(page.fills(lock), 'A', REQUEST, undefined, inputs), { text: 'blocked' });
  assert.deepEqual(taken, [], 'the one-use value was never taken');
  assert.equal(inputs.has(REQUEST), false);
  assert.equal(page.value('#pw'), '');
  // B's, meanwhile: entered.
  await bindAndProvide(page, inputs, SENTINEL, { sessionId: 'B' });
  assert.deepEqual(await fillSecretInput(page.fills(lock), 'B', REQUEST, undefined, inputs), { text: 'entered' });
  assert.equal(page.value('#pw'), SENTINEL);
});

test('a secret bound on /login is refused after a navigation, same origin or same address: nothing reaches the new document', async (t) => {
  const logs = quietConsole(t);
  for (const next of ['https://bank.example/other', LOGIN]) {
    const page = browserPage(LOGIN, LOGIN_FORM);
    const inputs = createSecretInputs();
    assert.deepEqual(await bindAndProvide(page, inputs), { origin: 'https://bank.example', form: 'login' });
    inputs.provide(`${REQUEST}-username`, 'data-team');
    page.load(next, LOGIN_FORM);
    assert.deepEqual(
      await fillSecretInput(page.fills(), 's1', REQUEST, undefined, inputs),
      { text: 'page_changed' },
      next
    );
    assert.equal(page.value('#pw'), '', `${next}: nothing typed into the new document`);
    assert.equal(page.value('#user'), '');
    assert.equal(page.reached(SENTINEL), false, 'the value never left this process');
    assert.equal(inputs.has(REQUEST), false, 'and is dropped');
  }
  // Still on its document: entered there.
  const page = browserPage(LOGIN, LOGIN_FORM);
  const inputs = createSecretInputs();
  await bindAndProvide(page, inputs);
  inputs.provide(`${REQUEST}-username`, 'data-team');
  assert.deepEqual(await fillSecretInput(page.fills(), 's1', REQUEST, undefined, inputs), { text: 'entered' });
  assert.equal(page.value('#pw'), SENTINEL);
  assert.equal(page.value('#user'), 'data-team');
  assert.equal(logged(logs, SENTINEL), false);
});

test('a saved login bound on /login is refused after a same-origin navigation: nothing reaches the new document', async () => {
  const vault = async (_url, _id, use) => use({ username: 'data-team', password: SENTINEL });
  for (const next of ['https://bank.example/other', LOGIN]) {
    const page = browserPage(LOGIN, LOGIN_FORM);
    const inputs = createSecretInputs();
    assert.deepEqual(
      await handoffPageFacts(page.facts(), 's1', 'login_accounts', { url: LOGIN, request_id: BIND }, undefined, inputs),
      { accounts: [{ id: CREDENTIAL, label: 'd•••m' }] }
    );
    page.load(next, LOGIN_FORM);
    const fill = { pageById: () => page.guest, useCredential: vault, fill: page.service.fillSecretField };
    assert.deepEqual(
      await fillBoundLogin(fill, 's1', BIND, CREDENTIAL, undefined, inputs),
      { usernameFilled: false, passwordFilled: false, reason: 'page-changed' },
      next
    );
    assert.equal(page.value('#pw'), '', `${next}: nothing typed into the new document`);
    assert.equal(page.reached(SENTINEL), false);
  }
  const page = browserPage(LOGIN, LOGIN_FORM);
  const inputs = createSecretInputs();
  await handoffPageFacts(page.facts(), 's1', 'login_accounts', { url: LOGIN, request_id: BIND }, undefined, inputs);
  const fill = { pageById: () => page.guest, useCredential: vault, fill: page.service.fillSecretField };
  assert.equal((await fillBoundLogin(fill, 's1', BIND, CREDENTIAL, undefined, inputs)).passwordFilled, true);
  assert.equal(page.value('#pw'), SENTINEL, 'still on its document: filled there');
  assert.equal(page.value('#user'), 'data-team');
});

const layOut = (doc) => {
  for (const input of doc.querySelectorAll('input')) {
    input.getBoundingClientRect = () => ({ left: 0, top: 0, right: 40, bottom: 30, width: 40, height: 30 });
  }
};
const savedVault = async (_url, _id, use) => use({ username: 'data-team', password: SENTINEL });
const ONE_FORM = '<form id="a"><input id="user" name="userid" type="text"><input id="pw" type="password"></form>';
const SECOND_FORM = '<form id="b"><input id="user2" name="userid" type="text"><input id="pw2" type="password"></form>';
const USER_STEP = '<form><input id="user" name="email" type="email"></form>';
const PASSWORD_STEP = '<form><input id="pw" type="password"></form>';

/** The login card's request-time binding on `html` (focus on `focus`), and its fill host. */
async function bindLogin(html, focus = '') {
  const page = browserPage(LOGIN, html);
  const inputs = createSecretInputs();
  if (focus) page.document().querySelector(focus).focus();
  const offered = await handoffPageFacts(
    page.facts(),
    's1',
    'login_accounts',
    { url: LOGIN, request_id: BIND },
    undefined,
    inputs
  );
  const fill = {
    pageById: () => page.guest,
    useCredential: savedVault,
    fill: page.service.fillSecretField,
    inspect: page.service.inspectSecretField,
  };
  return { page, inputs, fill, offered, click: () => fillBoundLogin(fill, 's1', BIND, CREDENTIAL, undefined, inputs) };
}

test('a saved login goes only to the elements bound at request time: moved focus or a replaced form never redirects it', async () => {
  // Another form with a password appears and takes focus meanwhile: still the bound one.
  let { page, click } = await bindLogin(ONE_FORM);
  page.document().body.insertAdjacentHTML('beforeend', SECOND_FORM);
  layOut(page.document());
  page.document().querySelector('#pw2').focus();
  assert.deepEqual(await click(), { usernameFilled: true, passwordFilled: true });
  assert.equal(page.value('#pw'), SENTINEL);
  assert.equal(page.value('#user'), 'data-team');
  assert.equal(page.value('#pw2'), '', 'never the focused field');
  assert.equal(page.value('#user2'), '');
  // The bound form is replaced inside the same document: refused, nothing typed.
  ({ page, click } = await bindLogin(ONE_FORM));
  const doc = page.document();
  const form = doc.querySelector('#a');
  form.outerHTML = form.outerHTML;
  layOut(doc);
  doc.querySelector('#pw').focus();
  assert.deepEqual(await click(), {
    usernameFilled: false,
    passwordFilled: false,
    reason: 'password-field-unavailable',
  });
  for (const id of ['#pw', '#user']) assert.equal(page.value(id), '', id);
});

test('several password fields still get the saved-login offer: bound to the focused one, else the first', async () => {
  for (const [focus, filled, other] of [
    ['#pw2', 'pw2', 'pw'],
    ['', 'pw', 'pw2'],
  ]) {
    const { page, offered, click } = await bindLogin(ONE_FORM + SECOND_FORM, focus);
    assert.deepEqual(offered, { accounts: [{ id: CREDENTIAL, label: 'd•••m' }] });
    assert.equal((await click()).passwordFilled, true);
    assert.equal(page.value(`#${filled}`), SENTINEL, focus || 'first');
    assert.equal(page.value(`#${other}`), '');
  }
  // No password field and no username field: nothing to offer.
  const { offered, inputs } = await bindLogin('<input id="q" type="search">');
  assert.deepEqual(offered, { accounts: [] });
  assert.equal(inputs.binding(BIND), null);
});

test('without a label the secret goes to the focused field, else the first of the requested kind', async () => {
  const html =
    '<form><input id="a" autocomplete="one-time-code" maxlength="6"><input id="b" autocomplete="one-time-code" maxlength="6"></form>';
  for (const [focus, filled, other] of [
    ['#b', 'b', 'a'],
    ['', 'a', 'b'],
  ]) {
    const page = browserPage(LOGIN, html);
    const inputs = createSecretInputs();
    if (focus) page.document().querySelector(focus).focus();
    assert.deepEqual(await bindAndProvide(page, inputs, '482190'), {
      origin: 'https://bank.example',
      form: 'otp',
      length: 6,
    });
    // Focus moving meanwhile does not redirect it.
    page
      .document()
      .querySelector(focus ? '#a' : '#b')
      .focus();
    assert.deepEqual(await fillSecretInput(page.fills(), 's1', REQUEST, undefined, inputs), { text: 'entered' });
    assert.equal(page.value(`#${filled}`), '482190', focus || 'first');
    assert.equal(page.value(`#${other}`), '');
  }
});

test('a saved login fills its username into the best-ranked candidate of the password form', async () => {
  let { page, click } = await bindLogin(
    '<form><input id="a" name="whatever" type="text"><input id="pw" type="password"></form>'
  );
  assert.deepEqual(await click(), { usernameFilled: true, passwordFilled: true });
  assert.equal(page.value('#a'), 'data-team', 'a lone candidate is the username');
  ({ page, click } = await bindLogin(
    '<form><input id="a" name="note" type="text"><input id="b" name="userid" type="text"><input id="pw" type="password"></form>'
  ));
  assert.deepEqual(await click(), { usernameFilled: true, passwordFilled: true });
  assert.equal(page.value('#b'), 'data-team');
  assert.equal(page.value('#a'), '');
});

test('a label that names no field or several: the focused field, else the first match', async () => {
  const CODE = '482190';
  const html =
    '<form><input name="code_a" autocomplete="one-time-code" maxlength="6"><input name="code_b" autocomplete="one-time-code" maxlength="6"></form>';
  for (const [field, focus, filled, other] of [
    ['nonesuch', '[name=code_b]', 'code_b', 'code_a'],
    ['nonesuch', '', 'code_a', 'code_b'],
    ['code', '[name=code_b]', 'code_b', 'code_a'],
    ['code', '', 'code_a', 'code_b'],
    ['code_b', '[name=code_a]', 'code_b', 'code_a'],
  ]) {
    const page = browserPage(LOGIN, html);
    const inputs = createSecretInputs();
    if (focus) page.document().querySelector(focus).focus();
    assert.deepEqual(
      await bindAndProvide(page, inputs, CODE, { field }),
      { origin: 'https://bank.example', form: 'otp', length: 6 },
      `${field} ${focus}`
    );
    assert.deepEqual(await fillSecretInput(page.fills(), 's1', REQUEST, undefined, inputs), { text: 'entered' });
    assert.equal(page.value(`[name=${filled}]`), CODE, `${field} ${focus}`);
    assert.equal(page.value(`[name=${other}]`), '');
  }
});

test('a two-step sign-in: the username page offers and fills the username, the password page the password', async () => {
  const doc = (page) => page.document();
  // Step 1: a username-only page. The login is offered; only the username is typed, the takeover stays open.
  let { page, inputs, offered, click } = await bindLogin(USER_STEP);
  assert.deepEqual(offered, { accounts: [{ id: CREDENTIAL, label: 'd•••m' }] });
  assert.deepEqual(
    inputs.binding(BIND).targets.map((target) => target.type),
    ['email']
  );
  assert.deepEqual(await click(), { usernameFilled: true, passwordFilled: false });
  assert.equal(page.value('#user'), 'data-team');
  assert.equal(page.reached(SENTINEL), false, 'the password never reaches the username page');
  assert.notEqual(inputs.binding(BIND), null, 'the handoff continues');
  // Step 2, the same document (a single-page sign-in) shows the password field: this click binds it.
  doc(page).body.innerHTML = PASSWORD_STEP;
  layOut(doc(page));
  assert.deepEqual(await click(), { usernameFilled: false, passwordFilled: true });
  assert.equal(page.value('#pw'), SENTINEL);
  assert.equal(inputs.binding(BIND), null, 'used up');

  // Step 2 on a new document of the same origin.
  ({ page, inputs, click } = await bindLogin(USER_STEP));
  assert.equal((await click()).usernameFilled, true);
  page.load('https://bank.example/password', PASSWORD_STEP);
  assert.deepEqual(await click(), { usernameFilled: false, passwordFilled: true });
  assert.equal(page.value('#pw'), SENTINEL);

  // Step 2 as a new handoff on the password page.
  ({ page, offered, click } = await bindLogin(PASSWORD_STEP));
  assert.deepEqual(offered, { accounts: [{ id: CREDENTIAL, label: 'd•••m' }] });
  assert.deepEqual(await click(), { usernameFilled: false, passwordFilled: true });
  assert.equal(page.value('#pw'), SENTINEL);

  // The next page shows no field this login fits: refused, nothing typed.
  ({ page, click } = await bindLogin(USER_STEP));
  await click();
  page.load('https://bank.example/done', '<input id="q" type="search">');
  assert.deepEqual(await click(), {
    usernameFilled: false,
    passwordFilled: false,
    reason: 'password-field-unavailable',
  });
  assert.equal(page.reached(SENTINEL), false);
  // ...and one that left the origin is refused as a page change.
  ({ page, click } = await bindLogin(USER_STEP));
  await click();
  page.load('https://evil.example/password', PASSWORD_STEP);
  assert.deepEqual(await click(), { usernameFilled: false, passwordFilled: false, reason: 'page-changed' });
  assert.equal(page.reached(SENTINEL), false);
});

test('a secret goes only to the field bound at request time: moved focus or a removed field never redirects it', async (t) => {
  const logs = quietConsole(t);
  const CODE = '482190';
  const html =
    '<form><input id="code" autocomplete="one-time-code" maxlength="6"><input id="other" autocomplete="one-time-code" maxlength="6"></form>';
  let page = browserPage(LOGIN, html);
  let inputs = createSecretInputs();
  assert.deepEqual(await bindAndProvide(page, inputs, CODE, { field: 'code' }), {
    origin: 'https://bank.example',
    form: 'otp',
    length: 6,
  });
  // The user (or the page) moves focus to the other code field meanwhile.
  page.document().querySelector('#other').focus();
  assert.deepEqual(await fillSecretInput(page.fills(), 's1', REQUEST, undefined, inputs), { text: 'entered' });
  assert.equal(page.value('#code'), CODE);
  assert.equal(page.value('#other'), '', 'never the focused field');
  // The bound field leaves the page: no field, and no fallback to the other one.
  page = browserPage(LOGIN, html);
  inputs = createSecretInputs();
  await bindAndProvide(page, inputs, CODE, { field: 'code' });
  page.document().querySelector('#code').remove();
  page.document().querySelector('#other').focus();
  assert.deepEqual(await fillSecretInput(page.fills(), 's1', REQUEST, undefined, inputs), { text: 'no_field' });
  assert.equal(page.value('#other'), '', 'nothing typed anywhere');
  assert.equal(inputs.has(REQUEST), false);
  assert.equal(logged(logs, CODE), false);
});

test('a secret is bound to an https page only, loopback included: an http page is never asked for nor filled', async () => {
  for (const url of ['http://bank.example/login', 'http://localhost:8080/login', 'http://127.0.0.1/login']) {
    const page = browserPage(url, '<input id="pw" type="password">');
    const inputs = createSecretInputs();
    assert.deepEqual(await bindAndProvide(page, inputs), {}, `${url}: no origin, so the runtime refuses (blocked)`);
    assert.equal(inputs.binding(REQUEST), null, 'nothing bound');
    assert.deepEqual(await fillSecretInput(page.fills(), 's1', REQUEST, undefined, inputs), { text: 'blocked' });
    assert.equal(page.value('#pw'), '');
    assert.equal(page.reached(SENTINEL), false);
  }
  // The origin is the parsed one (scheme, host, port), compared exactly.
  const page = browserPage('https://Bank.Example:8443/login', '<input id="pw" type="password">');
  const inputs = createSecretInputs();
  assert.deepEqual(await bindAndProvide(page, inputs), { origin: 'https://bank.example:8443', form: 'password' });
  page.load('https://bank.example:9443/login', '<input id="pw" type="password">');
  assert.deepEqual(await fillSecretInput(page.fills(), 's1', REQUEST, undefined, inputs), { text: 'page_changed' });
  assert.equal(page.value('#pw'), '');
});

test('a code split over one box per digit is protected in captures by the boxes themselves, once the host filled them', async () => {
  const boxes = Array.from({ length: 6 }, (_, n) => `<input id="d${n + 1}" inputmode="numeric" maxlength="1">`).join(
    ''
  );
  const page = browserPage(LOGIN, `<form>${boxes}</form>`);
  const inputs = createSecretInputs();
  const privacy = createBrowserVisualPrivacy({
    // The code is registered nowhere as text: no value matching could find it.
    state: { peek: () => undefined },
    documents: { pageText: async () => '', collect: async () => [], revision: async () => ({}) },
    cdp: page.cdp,
  });
  // Before the host filled anything, a capture goes through.
  await (await privacy(page.guest))();
  assert.deepEqual(await bindAndProvide(page, inputs, '482190'), {
    origin: 'https://bank.example',
    form: 'otp',
    length: 6,
  });
  assert.deepEqual(await fillSecretInput(page.fills(), 's1', REQUEST, undefined, inputs), { text: 'entered' });
  assert.equal([1, 2, 3, 4, 5, 6].map((n) => page.value(`#d${n}`)).join(''), '482190');
  // Filled by the host: the capture is refused, before and after it is taken.
  await assert.rejects(privacy(page.guest), /Visual output withheld/);
  // Emptied by the page (or gone): the capture goes through again.
  for (let n = 1; n <= 6; n += 1) page.document().querySelector(`#d${n}`).value = '';
  await (await privacy(page.guest))();
  page.document().querySelector('#d1').value = '4';
  await assert.rejects(privacy(page.guest), /Visual output withheld/, 'a single box that holds a digit is enough');
  page.document().querySelector('#d1').remove();
  await (await privacy(page.guest))();
});

test('only a confirmed missing node clears a protected box: any other CDP failure withholds the capture', async () => {
  const boxes = Array.from({ length: 6 }, (_, n) => `<input id="d${n + 1}" inputmode="numeric" maxlength="1">`).join(
    ''
  );
  const page = browserPage(LOGIN, `<form>${boxes}</form>`);
  const inputs = createSecretInputs();
  await bindAndProvide(page, inputs, '482190');
  assert.deepEqual(await fillSecretInput(page.fills(), 's1', REQUEST, undefined, inputs), { text: 'entered' });
  const guardWith = (fail) =>
    createBrowserVisualPrivacy({
      state: { peek: () => undefined },
      documents: { pageText: async () => '', collect: async () => [], revision: async () => ({}) },
      cdp: {
        call: async (target, method, params, signal) => fail(method) ?? page.cdp.call(target, method, params, signal),
      },
    });
  const failing = (method, error) => (name) => {
    if (name === method) throw error;
    return undefined;
  };
  // A resolution failure that is no "node gone": the boxes may still hold the code.
  for (const error of [
    new Error('Target closed'),
    new Error('Session with given id not found'),
    new Error('Internal error'),
  ]) {
    await assert.rejects(
      guardWith(failing('DOM.resolveNode', error))(page.guest),
      /Visual output withheld/,
      error.message
    );
  }
  // So does a failed or excepting evaluation, and a resolution with no object.
  await assert.rejects(
    guardWith(failing('Runtime.callFunctionOn', new Error('Cannot find context')))(page.guest),
    /Visual output withheld/
  );
  await assert.rejects(
    guardWith((name) => (name === 'Runtime.callFunctionOn' ? { exceptionDetails: { text: 'boom' } } : undefined))(
      page.guest
    ),
    /Visual output withheld/
  );
  await assert.rejects(
    guardWith((name) => (name === 'DOM.resolveNode' ? { object: {} } : undefined))(page.guest),
    /Visual output withheld/
  );
  // CDP's own answer that the nodes no longer exist lets them go.
  await (await guardWith(failing('DOM.resolveNode', new Error('No node with given id found')))(page.guest))();
});
