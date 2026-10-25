import assert from 'node:assert/strict';
import test from 'node:test';

import { createSecretInputs } from '../secret-input.ts';
import { createBrowserCredentialFill } from './credential-autofill.ts';
import { fillBoundLogin, handoffPageFacts } from './host-agent.ts';

const BIND = 'secret_login-0123456789';
const CREDENTIAL = 'c'.repeat(24);
const SENTINEL = 'S3NT1NEL-saved-login-77';
const LOGIN = 'https://bank.example/login';
const EVIL = 'https://evil.example/login';
/** The main frame's document the bound page shows (frame id : loader id). */
const DOCUMENT = 'main:L1';
/** The password and username elements bound at request time. */
const TARGETS = [
  { node: 42, type: 'password' },
  { node: 43, type: 'text' },
];

/** A refusal answered for the card to word (never a raw error). */
async function pageChanged(promise, message) {
  assert.deepEqual(await promise, { usernameFilled: false, passwordFilled: false, reason: 'page-changed' }, message);
}

/** A guest whose address is whatever `at.url` holds. */
function page(at) {
  return { getURL: () => at.url, isDestroyed: () => false };
}

/** The real isolated fill over a CDP port that records what was dispatched;
 *  `onSent(method)` runs once a call went out (a navigation can follow it). */
function isolatedFill(onSent = () => {}) {
  const sent = [];
  const fill = createBrowserCredentialFill({
    cdp: {
      call: async (_guest, method, params, _signal, options) => {
        options.beforeDispatch();
        sent.push({ method, params });
        onSent(method);
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'L1' } } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
        if (method === 'DOM.resolveNode') return { object: { objectId: `node-${params.backendNodeId}` } };
        if (method === 'Runtime.releaseObjectGroup') return {};
        return { result: { value: { filled: true, usernameFilled: true } } };
      },
    },
    rememberSecret() {},
    forgetSecret() {},
    redactText: (_guest, text) => text,
  });
  const credentialsSent = () =>
    sent.some(({ method, params }) => method === 'Runtime.callFunctionOn' && JSON.stringify(params).includes(SENTINEL));
  return { fill, sent, credentialsSent };
}

/** The vault read: `during()` runs while it is being read (a navigation, say). */
function vault(during = () => {}) {
  const reads = [];
  return {
    reads,
    useCredential: async (url, id, use) => {
      reads.push([url, id]);
      during();
      return use({ username: 'data-team', password: SENTINEL });
    },
  };
}

test("a login takeover's saved logins are offered and bound only for a page on its origin", async () => {
  const inputs = createSecretInputs();
  const at = { url: LOGIN };
  const host = (guest) => ({
    guest: () => guest,
    pageId: () => 'p1',
    document: async () => DOCUMENT,
    // Request time binds the password and username elements the fill writes.
    inspect: async (_guest, request) => {
      assert.equal(request.form, 'login');
      return { form: 'login', targets: TARGETS, document: DOCUMENT };
    },
    accounts: async () => [{ id: CREDENTIAL, label: 'd•••m' }],
  });
  assert.deepEqual(
    await handoffPageFacts(host(page(at)), 's1', 'login_accounts', { url: 'https://bank.example/signin', request_id: BIND }, undefined, inputs),
    { accounts: [{ id: CREDENTIAL, label: 'd•••m' }] }
  );
  assert.deepEqual(inputs.binding(BIND), {
    sessionId: 's1',
    pageId: 'p1',
    document: DOCUMENT,
    origin: 'https://bank.example',
    form: 'login',
    targets: TARGETS,
  });
  const other = 'secret_login-9876543210';
  assert.deepEqual(
    await handoffPageFacts(host(page({ url: EVIL })), 's1', 'login_accounts', { url: LOGIN, request_id: other }, undefined, inputs),
    { accounts: [] },
    'the session page is elsewhere: nothing to fill, nothing offered'
  );
  assert.equal(inputs.binding(other), null);
});

test('the saved-login fill goes to the bound page only, and a navigation after the URL check sends nothing to the new origin', async () => {
  const bind = (inputs) =>
    inputs.bind(BIND, {
      sessionId: 's1',
      pageId: 'p1',
      document: DOCUMENT,
      origin: 'https://bank.example',
      form: 'login',
      targets: TARGETS,
    });
  const selected = { getURL: () => 'https://bank.example/elsewhere', isDestroyed: () => assert.fail('never the selected tab') };
  const pages = (bound) => (_session, pageId) => (pageId === 'p1' ? bound : selected);

  // A navigation while the vault is read.
  let inputs = createSecretInputs();
  bind(inputs);
  let at = { url: LOGIN };
  let iso = isolatedFill();
  let v = vault(() => {
    at.url = EVIL;
  });
  await pageChanged(
    fillBoundLogin({ pageById: pages(page(at)), useCredential: v.useCredential, fill: iso.fill.fillSecretField }, 's1', BIND, CREDENTIAL, undefined, inputs)
  );
  assert.deepEqual(v.reads, [[LOGIN, CREDENTIAL]], 'the vault was asked for the checked page');
  assert.deepEqual(iso.sent, [], 'nothing was dispatched');

  // A navigation after the post-vault check, just before the fill reaches the page.
  at = { url: LOGIN };
  iso = isolatedFill((method) => {
    if (method === 'Page.createIsolatedWorld') at.url = EVIL;
  });
  await pageChanged(
    fillBoundLogin({ pageById: pages(page(at)), useCredential: vault().useCredential, fill: iso.fill.fillSecretField }, 's1', BIND, CREDENTIAL, undefined, inputs)
  );
  assert.equal(iso.credentialsSent(), false, 'no credential reached the new origin');

  // The bound page left the origin before anything ran, or another session asks.
  at = { url: EVIL };
  v = vault();
  await pageChanged(
    fillBoundLogin({ pageById: pages(page(at)), useCredential: v.useCredential, fill: iso.fill.fillSecretField }, 's1', BIND, CREDENTIAL, undefined, inputs)
  );
  at = { url: LOGIN };
  await pageChanged(
    fillBoundLogin({ pageById: pages(page(at)), useCredential: v.useCredential, fill: iso.fill.fillSecretField }, 's2', BIND, CREDENTIAL, undefined, inputs)
  );
  assert.deepEqual(v.reads, [], 'the vault is not read for a page that cannot take the login');

  // Still there: filled into the bound page, and the binding is used up.
  iso = isolatedFill();
  const filled = await fillBoundLogin(
    { pageById: pages(page(at)), useCredential: vault().useCredential, fill: iso.fill.fillSecretField },
    's1',
    BIND,
    CREDENTIAL,
    undefined,
    inputs
  );
  assert.equal(filled.passwordFilled, true);
  assert.equal(iso.credentialsSent(), true);
  assert.equal(inputs.binding(BIND), null);
  inputs = createSecretInputs();
  await pageChanged(
    fillBoundLogin({ pageById: pages(page(at)), useCredential: vault().useCredential, fill: iso.fill.fillSecretField }, 's1', BIND, CREDENTIAL, undefined, inputs),
    'never bound: no page to fill'
  );
  // A failure that is no page change (a login of another site, say) stays an error.
  inputs = createSecretInputs();
  bind(inputs);
  await assert.rejects(
    fillBoundLogin(
      {
        pageById: pages(page(at)),
        useCredential: async () => {
          throw new Error('savedAccount is not a stored login for https://bank.example');
        },
        fill: iso.fill.fillSecretField,
      },
      's1',
      BIND,
      CREDENTIAL,
      undefined,
      inputs
    ),
    /not a stored login/
  );
});

test('the saved-login fill refuses a login bound to no element, and answers a stale one as unfillable', async () => {
  const inputs = createSecretInputs();
  inputs.bind(BIND, { sessionId: 's1', pageId: 'p1', document: DOCUMENT, origin: 'https://bank.example', form: 'login' });
  const iso = isolatedFill();
  const v = vault();
  const unfillable = { usernameFilled: false, passwordFilled: false, reason: 'password-field-unavailable' };
  assert.deepEqual(
    await fillBoundLogin(
      { pageById: () => page({ url: LOGIN }), useCredential: v.useCredential, fill: iso.fill.fillSecretField },
      's1',
      BIND,
      CREDENTIAL,
      undefined,
      inputs
    ),
    unfillable
  );
  assert.deepEqual(v.reads, [], 'the vault is not read');
  assert.equal(iso.credentialsSent(), false);
});

test('a stored-login fill is held to the address checked before the vault read, not the page it went to', async () => {
  // The pane's fill (profile-host-methods.ts) checks the page, reads the
  // vault, then fills with that address bound.
  const at = { url: LOGIN };
  const iso = isolatedFill();
  const guest = page(at);
  const checked = guest.getURL();
  const v = vault(() => {
    at.url = EVIL;
  });
  await assert.rejects(
    v.useCredential(checked, CREDENTIAL, (credential) =>
      iso.fill.fillCredentialInGuest(guest, credential, undefined, checked)
    ),
    /page changed/
  );
  assert.deepEqual(iso.sent, [], 'nothing was dispatched to the page it navigated to');
});
