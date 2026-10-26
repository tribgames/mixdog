import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// No OS keychain in the unit lane: a reversible stand-in seals the file, and
// every store call runs through the vault's real sealed-file format.
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url: 'data:text/javascript,export const app={getPath:()=>""};export const safeStorage={isEncryptionAvailable:()=>true};',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});

const { createBrowserLinkedSignIns, linkedSignInFor, linkedSignInId, linkedSignInLine } = await import(
  './linked-sign-in.ts'
);
const { LINKED_SIGN_IN_FILE_NAME, LinkedSignInStore } = await import('./linked-sign-in-store.ts');

const seal = (plaintext) => Buffer.from(plaintext, 'utf8').reverse();
const unseal = (sealed) => Buffer.from(sealed).reverse().toString('utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const enc = encodeURIComponent;

function memoryStore() {
  const links = new Map();
  let clock = 1_000;
  return {
    links,
    async list() {
      return [...links.values()];
    },
    async record(input) {
      const id = linkedSignInId(input.site, input.provider);
      links.set(id, { id, ...input, lastUsedAt: (clock += 1) });
    },
  };
}

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return 'null';
  }
};

/** A frame as Electron's WebFrameMain shows it: its tree node, origin and top frame. */
function frameOf(node, origin, top = null) {
  const frame = { frameTreeNodeId: node, isDestroyed: () => false };
  Object.defineProperty(frame, 'origin', { get: origin });
  frame.top = top ?? frame;
  return frame;
}

function fakeGuest(id) {
  const guest = new EventEmitter();
  guest.id = id;
  guest.url = 'about:blank';
  guest.destroyed = false;
  guest.getURL = () => guest.url;
  guest.isDestroyed = () => guest.destroyed;
  guest.mainFrame = frameOf(id * 100, () => originOf(guest.url));
  return guest;
}

/** The host side over a store, with the snapshot refs the agent may click or
 *  type into (a name, or { name, url, role, sensitive }) and the attributes
 *  each ref's input declares. */
function setup({ store = memoryStore(), refs = {}, fields = {}, onError } = {}) {
  const linked = createBrowserLinkedSignIns({
    store,
    onError,
    ref: (guest, ref) => {
      const entry = typeof refs[ref] === 'string' ? { name: refs[ref] } : refs[ref];
      return entry ? { url: guest.getURL(), role: 'textbox', ...entry } : null;
    },
    pageId: (guest) => `p${guest.id}`,
  });
  const tab = (id) => {
    const guest = fakeGuest(id);
    linked.watch(guest);
    /** One main-frame navigation: started by `by` (this tab's main frame by
     *  default; null for an address the agent sent; another frame), its
     *  form_post `body`, redirected through the rest of `urls`, committing the
     *  last one with `status` unless `commit` is false. */
    guest.go = (urls, { by = guest.mainFrame, body, commit = true, status = 200 } = {}) => {
      guest.emit('did-start-navigation', { url: urls[0], isMainFrame: true, isSameDocument: false, initiator: by });
      if (body !== undefined) linked.navigationPost(guest.id, urls[0], [Buffer.from(body)]);
      for (const url of urls.slice(1)) guest.emit('did-redirect-navigation', { url, isMainFrame: true });
      if (!commit) return;
      guest.url = urls.at(-1);
      guest.emit('did-navigate', {}, guest.url, status);
    };
    guest.act = (action, command) => linked.beforeAction(guest, action, command, async (ref) => fields[ref] ?? null);
    return guest;
  };
  return { store, linked, tab };
}

const records = (store) =>
  [...store.links.values()].map(({ site, redirectHost, provider, identity }) => ({
    site,
    redirectHost,
    provider,
    identity,
  }));

const OPENAI_CB = 'https://auth.openai.com/api/accounts/callback/google';
const googleAuthorize = (redirect, state = 'G0OGLE', extra = '') =>
  `https://accounts.google.com/o/oauth2/v2/auth?client_id=123.apps.googleusercontent.com&redirect_uri=${enc(redirect)}&response_type=code&scope=openid%20email&state=${state}${extra}`;
const googleChooser = (redirect, state = 'G0OGLE') =>
  `https://accounts.google.com/v3/signin/accountchooser?client_id=123.apps.googleusercontent.com&redirect_uri=${enc(redirect)}&response_type=code&state=${state}`;

/** A Google flow left from `site`'s page, now on the chooser. */
function toGoogleChooser(guest, site, callback, state = 'G0OGLE') {
  guest.go([site], { by: null });
  guest.go([googleAuthorize(callback, state), googleChooser(callback, state)]);
}

test('a field that cannot be read never fails the action: expected losses are silent, others reported, cancellation propagates', async () => {
  const errors = [];
  const { linked, tab } = setup({ refs: { e1: 'Email or phone' }, onError: (error) => errors.push(error.message) });
  const guest = tab(60);
  toGoogleChooser(guest, 'https://chatgpt.com/', OPENAI_CB);
  const fill = (readField, signal) => linked.beforeAction(guest, 'fill', { ref: 'e1', text: 'a@gmail.com' }, readField, signal);

  await fill(async () => {
    throw new Error('ref e1 is stale or unknown; take a fresh snapshot first');
  });
  await fill(async () => {
    throw new Error('ref e1 is stale or detached; take a fresh snapshot first');
  });
  await fill(async () => {
    throw new Error('Inspected target navigated or closed');
  });
  assert.deepEqual(errors, [], 'a stale ref or a document that went away is expected');

  await fill(async () => {
    throw new Error('debugger detached');
  });
  assert.deepEqual(errors, ['debugger detached'], 'anything else is reported, and the action still goes on');

  const url = guest.url;
  await fill(async () => {
    guest.url = 'https://elsewhere.example/';
    throw new Error('Target closed');
  });
  guest.url = url;
  await fill(async () => {
    guest.destroyed = true;
    throw new Error('Object has been destroyed');
  });
  guest.destroyed = false;
  assert.deepEqual(errors, ['debugger detached'], 'a page that moved or was destroyed is expected');

  const controller = new AbortController();
  await assert.rejects(
    fill(async () => {
      controller.abort(new Error('stop'));
      throw new Error('aborted');
    }, controller.signal),
    /stop/
  );
  assert.deepEqual(errors, ['debugger detached']);
});

test('Google OIDC inside a site auth server: the state round trip records the account the agent clicked', async () => {
  const { store, tab } = setup({ refs: { e7: '박재영 tempest1033@gmail.com', e9: 'Use another account' } });
  const guest = tab(1);
  guest.go(['https://chatgpt.com/'], { by: null });
  // chatgpt.com → its auth server's own authorization → Google's (a login_hint the site sent).
  guest.go([
    `https://auth.openai.com/api/accounts/authorize?client_id=app_X&redirect_uri=${enc('https://chatgpt.com/api/auth/callback/openai')}&response_type=code&state=OUTER`,
    googleAuthorize(OPENAI_CB, 'G0OGLE', '&login_hint=forged%40gmail.com'),
    googleChooser(OPENAI_CB),
  ]);
  await guest.act('click', { ref: 'e9' });
  await guest.act('click', { ref: 'e7' });
  guest.go([
    'https://accounts.google.com/signin/oauth/id?authuser=1&part=x',
    `${OPENAI_CB}?code=C0DE&state=G0OGLE&authuser=forged%40gmail.com`,
    'https://chatgpt.com/api/auth/callback/openai?code=C1&state=OUTER',
    'https://chatgpt.com/',
  ]);
  await flush();
  // One sign-in, Google's: the auth server's wrapping round trip is no second one.
  assert.deepEqual(records(store), [
    { site: 'chatgpt.com', redirectHost: 'auth.openai.com', provider: 'google.com', identity: 'tempest1033@gmail.com' },
  ]);
  const saved = [...store.links.values()];
  const line = 'Linked sign-in: chatgpt.com last signed in with Google as tempest1033@gmail.com';
  assert.equal(linkedSignInLine(linkedSignInFor(saved, 'https://chatgpt.com/c/1')), line);
  // Another site's page, or a provider page with no verified flow from chatgpt.com: nothing.
  for (const url of [
    'https://auth.openai.com/log-in',
    'https://platform.openai.com/',
    'https://accounts.google.com/',
    googleChooser(OPENAI_CB, 'NEXT'),
  ]) {
    assert.equal(linkedSignInFor(saved, url), null, url);
  }
  // Google's page while a verified flow from chatgpt.com is open names it.
  assert.equal(linkedSignInLine(linkedSignInFor(saved, googleChooser(OPENAI_CB), ['chatgpt.com'])), line);
  assert.equal(
    linkedSignInFor(saved, 'https://appleid.apple.com/auth/authorize', ['chatgpt.com']),
    null,
    'not its provider'
  );
});

test('a page whose address merely names a recorded site in its parameters gets no line', async () => {
  const { store, linked, tab } = setup();
  // evil.example legitimately records its own sign-in through fake-idp.example.
  const cb = 'https://evil.example/cb';
  const own = tab(90);
  own.go(['https://evil.example/login'], { by: null });
  own.go([`https://fake-idp.example/authorize?client_id=x&redirect_uri=${enc(cb)}&response_type=code&state=OWN`]);
  own.go(['https://fake-idp.example/approve', `${cb}?code=C0DE&state=OWN`, 'https://evil.example/']);
  await flush();
  assert.deepEqual(
    records(store).map((link) => link.site),
    ['evil.example']
  );
  // The reviewer probe: a victim page carrying an authorization-shaped query for evil.example.
  const probe = `https://victim.example/?client_id=x&redirect_uri=${enc(cb)}&state=s`;
  const victim = tab(91);
  victim.go(['https://news.example/'], { by: null });
  victim.go([probe]);
  assert.equal(await linked.replyLine({ guest: victim, sessionId: 's', turnId: 1 }), '');
  assert.equal(linkedSignInFor([...store.links.values()], probe), null);
  // Even on fake-idp.example's own page: no verified flow from evil.example in this tab.
  const bare = tab(92);
  bare.go([`https://fake-idp.example/authorize?client_id=x&redirect_uri=${enc(cb)}&response_type=code&state=NEW`], {
    by: null,
  });
  assert.equal(await linked.replyLine({ guest: bare, sessionId: 's', turnId: 1 }), '');
  // With one (started on evil.example's page in this tab) it is named there.
  const again = tab(93);
  again.go(['https://evil.example/login'], { by: null });
  again.go([`https://fake-idp.example/authorize?client_id=x&redirect_uri=${enc(cb)}&response_type=code&state=NEW`]);
  assert.equal(
    await linked.replyLine({ guest: again, sessionId: 's', turnId: 1 }),
    'Linked sign-in: evil.example last signed in with fake-idp.example'
  );
});

test('GitHub OAuth: recorded with no account when the agent named none', async () => {
  const { store, tab } = setup();
  const guest = tab(2);
  const callback = 'https://vercel.com/api/registration/login-with-github';
  guest.go(['https://vercel.com/login'], { by: null });
  guest.go([
    `https://github.com/login/oauth/authorize?client_id=Iv1.abc&redirect_uri=${enc(callback)}&scope=user&state=GH5`,
  ]);
  // Authorize: a form post GitHub answers with the redirect.
  guest.go([
    'https://github.com/login/oauth/authorize',
    `${callback}?code=C0DE&state=GH5`,
    'https://vercel.com/dashboard',
  ]);
  await flush();
  assert.deepEqual(records(store), [
    { site: 'vercel.com', redirectHost: 'vercel.com', provider: 'github.com', identity: '' },
  ]);
  assert.equal(linkedSignInLine(records(store)[0]), 'Linked sign-in: vercel.com last signed in with GitHub');
});

test('X OAuth 1.0a: the same oauth_token with a verifier, back on the site; the handle the agent typed', async () => {
  const { store, tab } = setup({
    refs: { user: 'Phone, email, or username', pass: { name: 'Password', sensitive: true } },
    fields: {
      user: { type: 'text', autocomplete: 'username', name: 'text', id: '' },
      pass: { type: 'password', autocomplete: 'current-password', name: 'password', id: '' },
    },
  });
  const guest = tab(3);
  guest.go(['https://app.example.com/login'], { by: null });
  guest.go(['https://app.example.com/auth/x', 'https://api.x.com/oauth/authenticate?oauth_token=T0K']);
  await guest.act('type', { ref: 'pass', text: '@not_a_handle' });
  await guest.act('type', { ref: 'user', text: '@tempest' });
  guest.go([
    'https://api.x.com/oauth/authorize',
    'https://app.example.com/auth/x/callback?oauth_token=T0K&oauth_verifier=V3R',
    'https://app.example.com/home',
  ]);
  await flush();
  assert.deepEqual(records(store), [
    { site: 'example.com', redirectHost: 'app.example.com', provider: 'x.com', identity: '@tempest' },
  ]);
  assert.equal(linkedSignInLine(records(store)[0]), 'Linked sign-in: example.com last signed in with X as @tempest');
});

test('Apple form_post: the state comes back in the posted form', async () => {
  const { store, tab } = setup({
    refs: { account: 'Email or Phone Number' },
    fields: { account: { type: 'text', autocomplete: 'off', name: '', id: 'account_name_text_field' } },
  });
  const callback = 'https://www.notion.so/applecallback';
  const authorize = `https://appleid.apple.com/auth/authorize?client_id=so.notion&redirect_uri=${enc(callback)}&response_type=code%20id_token&response_mode=form_post&scope=name%20email&state=APL`;
  const guest = tab(4);
  guest.go(['https://www.notion.so/login'], { by: null });
  guest.go([authorize]);
  await guest.act('fill', { fields: [{ ref: 'account', text: 'me@icloud.com' }] });
  guest.go([callback, 'https://www.notion.so/'], { body: 'state=APL&code=C0DE&id_token=eyJ.S3CR3T' });
  // Without the posted form there is no state to match.
  const bare = tab(5);
  bare.go(['https://www.notion.so/login'], { by: null });
  bare.go([authorize.replace('so.notion', 'so.notion2')]);
  bare.go([callback, 'https://www.notion.so/']);
  await flush();
  assert.deepEqual(records(store), [
    { site: 'notion.so', redirectHost: 'www.notion.so', provider: 'apple.com', identity: 'me@icloud.com' },
  ]);
});

test('Kakao: a request carried in the provider continue address completes the same way', async () => {
  const { store, tab } = setup({ refs: { go: '계속하기' } });
  const callback = 'https://www.example.kr/oauth/kakao';
  const authorize = `https://kauth.kakao.com/oauth/authorize?client_id=K1&redirect_uri=${enc(callback)}&response_type=code&state=KKO`;
  const guest = tab(6);
  guest.go(['https://www.example.kr/'], { by: null });
  guest.go([authorize, `https://accounts.kakao.com/login/?continue=${enc(authorize)}`]);
  await guest.act('click', { ref: 'go' });
  guest.go([authorize, `${callback}?code=C0DE&state=KKO`, 'https://www.example.kr/me']);
  await flush();
  assert.deepEqual(records(store), [
    { site: 'example.kr', redirectHost: 'www.example.kr', provider: 'kakao.com', identity: '' },
  ]);
  assert.equal(linkedSignInLine(records(store)[0]), 'Linked sign-in: example.kr last signed in with Kakao');
});

test('no protocol proof, no record', async () => {
  const { store, tab } = setup();
  const callback = 'https://www.notion.so/google-callback';
  const done = (guest, url, options) => guest.go([url, 'https://www.notion.so/'], options);

  // Another state, or a request with no state at all.
  const other = tab(10);
  toGoogleChooser(other, 'https://www.notion.so/login', callback);
  done(other, `${callback}?code=C0DE&state=OTHER`);
  const stateless = tab(11);
  stateless.go(['https://www.notion.so/login'], { by: null });
  stateless.go([
    `https://accounts.google.com/o/oauth2/v2/auth?client_id=1&redirect_uri=${enc(callback)}&response_type=code`,
  ]);
  done(stateless, `${callback}?code=C0DE`);
  // The provider answered with an error, or with no code / token.
  const refused = tab(12);
  toGoogleChooser(refused, 'https://www.notion.so/login', callback);
  done(refused, `${callback}?error=access_denied&state=G0OGLE`);
  const empty = tab(13);
  toGoogleChooser(empty, 'https://www.notion.so/login', callback);
  done(empty, `${callback}?state=G0OGLE`);
  // The agent typed the callback itself (no initiating frame).
  const typed = tab(14);
  toGoogleChooser(typed, 'https://www.notion.so/login', callback);
  done(typed, `${callback}?code=C0DE&state=G0OGLE`, { by: null });
  // An opener in another tab navigates this one — even from a Google page.
  const opener = tab(15);
  opener.go(['https://evil.example/'], { by: null });
  const googleTab = tab(16);
  googleTab.go(['https://accounts.google.com/'], { by: null });
  for (const [id, by] of [
    [17, opener.mainFrame],
    [18, googleTab.mainFrame],
  ]) {
    const victim = tab(id);
    toGoogleChooser(victim, 'https://www.notion.so/login', callback);
    done(victim, `${callback}?code=C0DE&state=G0OGLE`, { by });
  }
  // The callback reached through the site's own redirector, not the provider.
  const relayed = tab(19);
  toGoogleChooser(relayed, 'https://www.notion.so/login', callback);
  relayed.go([`https://www.notion.so/redirect?to=cb`, `${callback}?code=C0DE&state=G0OGLE`, 'https://www.notion.so/']);
  // Sent by the provider, but that navigation failed or never committed.
  const failed = tab(20);
  toGoogleChooser(failed, 'https://www.notion.so/login', callback);
  failed.go([`${callback}?code=C0DE&state=G0OGLE`], { status: 500 });
  const replaced = tab(21);
  toGoogleChooser(replaced, 'https://www.notion.so/login', callback);
  replaced.go([`${callback}?code=C0DE&state=G0OGLE`], { commit: false });
  replaced.go(['https://www.notion.so/elsewhere']);
  // A page that closed mid-flow is forgotten.
  const closed = tab(22);
  toGoogleChooser(closed, 'https://www.notion.so/login', callback);
  closed.emit('destroyed');
  done(closed, `${callback}?code=C0DE&state=G0OGLE`);
  // Cross-site: evil.example sends this tab through victim.example's app; the
  // sign-in lands on victim.example, not back on evil.example.
  const crossed = tab(23);
  const victimCb = 'https://victim.example/auth/google/callback';
  toGoogleChooser(crossed, 'https://evil.example/', victimCb, 'V1CT1M');
  crossed.go([`${victimCb}?code=C0DE&state=V1CT1M`, 'https://victim.example/home']);
  // The authorize address typed by the agent on the site's page: no S page started it.
  const sent = tab(24);
  sent.go(['https://www.notion.so/login'], { by: null });
  sent.go([googleAuthorize(callback)], { by: null });
  done(sent, `${callback}?code=C0DE&state=G0OGLE`);
  // A subframe of the site's page (not its main frame) starting the request.
  const framed = tab(25);
  framed.go(['https://www.notion.so/login'], { by: null });
  framed.go([googleAuthorize(callback)], { by: frameOf(2_599, () => 'https://www.notion.so', framed.mainFrame) });
  done(framed, `${callback}?code=C0DE&state=G0OGLE`);
  await flush();
  assert.deepEqual(records(store), []);
});

test('a popup with no site page behind it records nothing, even from a fake provider', async () => {
  const { store, linked, tab } = setup();
  // The reviewer probe: a fresh popup goes to a fake IdP whose redirect_uri
  // is an ordinary victim page; the IdP sends it there with its own state
  // and a fake code, and the victim page commits.
  const victim = 'https://victim.example/welcome';
  const popup = tab(70);
  popup.go([
    `https://fake-idp.example/authorize?client_id=x&redirect_uri=${enc(victim)}&response_type=code&state=FAKE`,
  ]);
  popup.go(['https://fake-idp.example/approve', `${victim}?code=FAKE&state=FAKE`]);
  // The same with a real provider: still no S page, no record.
  const real = tab(71);
  real.go([googleAuthorize('https://victim.example/cb', 'P0PUP')]);
  real.go([`https://victim.example/cb?code=C0DE&state=P0PUP`, 'https://victim.example/']);
  await flush();
  assert.deepEqual(records(store), []);
  const page = fakeGuest(72);
  page.url = 'https://victim.example/welcome';
  assert.equal(await linked.replyLine({ guest: page, sessionId: 's', turnId: 1 }), '');
});

test('only a POST a form_post request waits for is read, its size counted before any copy', async (t) => {
  const { store, linked, tab } = setup();
  const callback = 'https://www.notion.so/applecallback';
  const authorize = (state) =>
    `https://appleid.apple.com/auth/authorize?client_id=so.notion&redirect_uri=${enc(callback)}&response_type=code%20id_token&response_mode=form_post&state=${state}`;
  const concat = Buffer.concat;
  let copies = 0;
  Buffer.concat = (...args) => {
    copies += 1;
    return concat(...args);
  };
  t.after(() => {
    Buffer.concat = concat;
  });
  const mib = Buffer.alloc(1024 * 1024, 0x61);
  // An unrelated 1 MiB form post on a page with an open request: not read.
  const unrelated = tab(80);
  unrelated.go(['https://www.notion.so/login'], { by: null });
  unrelated.go([authorize('BIG')]);
  unrelated.go(['https://www.notion.so/upload'], { commit: false });
  linked.navigationPost(80, 'https://www.notion.so/upload', [mib]);
  // The awaited callback, but over 64 KiB (in bytes): skipped before copying.
  unrelated.go([callback], { commit: false });
  linked.navigationPost(80, callback, [Buffer.from(`state=BIG&code=C0DE&pad=`), mib]);
  unrelated.go(['https://www.notion.so/']);
  // A POST with no open form_post request at all: not read either.
  const none = tab(81);
  none.go(['https://www.notion.so/login'], { by: null });
  none.go([callback], { commit: false });
  linked.navigationPost(81, callback, [Buffer.from('state=X&code=Y')]);
  assert.equal(copies, 0);
  // The awaited callback within the limit is read once and completes.
  const fits = tab(82);
  fits.go(['https://www.notion.so/login'], { by: null });
  fits.go([authorize('OK')]);
  fits.go([callback, 'https://www.notion.so/'], { body: 'state=OK&code=C0DE' });
  assert.equal(copies, 1);
  await flush();
  assert.deepEqual(
    records(store).map((link) => link.provider),
    ['apple.com']
  );
});

test('the account is only what the agent clicked or typed on the provider pages, as an email or @handle', async () => {
  const { store, tab } = setup({
    refs: {
      stale: { name: '박재영 a@gmail.com', url: 'https://evil.example/look-alike' },
      two: 'a@gmail.com or b@gmail.com',
      field: 'Email or phone',
      secret: 'Secret',
      masked: { name: 'Email', sensitive: true },
      unread: 'Email address',
      next: 'Next',
    },
    fields: {
      field: { type: 'email', autocomplete: 'username', name: 'identifier', id: 'identifierId' },
      // The reviewer probe: a plain text input labelled "Secret".
      secret: { type: 'text', autocomplete: '', name: 'secret', id: 'secret' },
      // Labelled as an email, but a password input the snapshot marked secret.
      masked: { type: 'password', autocomplete: 'email', name: 'email', id: 'email' },
    },
  });
  const callback = 'https://www.notion.so/google-callback';
  const guest = tab(30);
  toGoogleChooser(guest, 'https://www.notion.so/login', callback);
  // URL parameters (login_hint, authuser) are never read; neither is page text.
  await guest.act('click', { ref: 'stale' }); // a snapshot of another page
  await guest.act('click', { ref: 'two' }); // two accounts named
  await guest.act('click', { target: { text: 'forged@gmail.com' } }); // the agent's own words
  await guest.act('type', { ref: 'field', text: 'tempest' }); // no email, no @handle
  await guest.act('type', { ref: 'secret', text: 'secret@example.com' }); // not an identifier input
  await guest.act('fill', { fields: [{ ref: 'masked', text: 'pw@example.com' }] }); // a secret field
  await guest.act('type', { ref: 'unread', text: 'unknown@example.com' }); // its attributes unread
  await guest.act('hover', { ref: 'field' });
  await guest.act('click', { ref: 'next' });
  guest.go([
    `${callback}?code=C0DE&state=G0OGLE&login_hint=forged%40gmail.com&authuser=forged%40gmail.com`,
    'https://www.notion.so/',
  ]);
  // Typing on the site's own page (not the provider's) names no account either.
  const site = tab(31);
  site.go(['https://www.notion.so/login'], { by: null });
  await site.act('type', { ref: 'field', text: 'site@notion.so' });
  site.go([googleAuthorize(callback, 'S2')]);
  site.go([`${callback}?code=C0DE&state=S2`, 'https://www.notion.so/']);
  await flush();
  assert.deepEqual(
    records(store).map((link) => link.identity),
    ['']
  );
});

test('the reply line: once per page and site per turn, for that page only', async () => {
  const store = memoryStore();
  await store.record({
    site: 'chatgpt.com',
    redirectHost: 'auth.openai.com',
    provider: 'google.com',
    identity: 'a@gmail.com',
  });
  await store.record({ site: 'chatgpt.com', redirectHost: 'auth.openai.com', provider: 'github.com', identity: '' });
  const { linked, tab } = setup({ store });
  const page = fakeGuest(40);
  page.url = 'https://chatgpt.com/';
  const line = (guest, turnId) => linked.replyLine({ guest, sessionId: 's', turnId });
  // The latest sign-in of the site is the one named.
  assert.equal(await line(page, 1), 'Linked sign-in: chatgpt.com last signed in with GitHub');
  assert.equal(await line(page, 1), '', 'once per page per turn');
  page.url = 'https://chatgpt.com/settings';
  assert.equal(await line(page, 1), '', 'the same site on the same page');
  page.url = 'https://auth.openai.com/log-in';
  assert.equal(await line(page, 2), '', 'another site (its auth server) names no record');
  page.url = 'https://chatgpt.com/';
  assert.equal(await line(page, 2), 'Linked sign-in: chatgpt.com last signed in with GitHub', 'a new turn');
  const second = fakeGuest(41);
  second.url = 'https://chatgpt.com/c/2';
  assert.match(await line(second, 2), /^Linked sign-in: chatgpt\.com /, 'another page');
  // On Google's chooser in a flow chatgpt.com's page started here, its Google
  // sign-in is named; the chooser's address alone names nothing.
  const chooserPage = tab(42);
  toGoogleChooser(chooserPage, 'https://chatgpt.com/', OPENAI_CB);
  assert.equal(await line(chooserPage, 2), 'Linked sign-in: chatgpt.com last signed in with Google as a@gmail.com');
  const addressOnly = fakeGuest(44);
  addressOnly.url = googleChooser(OPENAI_CB);
  assert.equal(await line(addressOnly, 2), '');
  const elsewhere = fakeGuest(43);
  elsewhere.url = 'https://example.com/';
  assert.equal(await line(elsewhere, 2), '');
});

test('records persist sealed, one per site and provider, with nothing but the account', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-linked-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = 5_000;
  const open = () => new LinkedSignInStore({ userDataDirectory: dir, seal, unseal, now: () => (clock += 1) });
  const store = open();
  const { tab } = setup({ store, refs: { e7: '박재영 tempest1033@gmail.com' } });
  const guest = tab(50);
  guest.go(['https://chatgpt.com/'], { by: null });
  guest.go([googleAuthorize(OPENAI_CB, 'ST4TE', '&login_hint=hint%40gmail.com'), googleChooser(OPENAI_CB, 'ST4TE')]);
  await guest.act('click', { ref: 'e7' });
  guest.go([
    `${OPENAI_CB}?code=4%2F0S3CR3T-CODE&state=ST4TE#access_token=S3CR3T-TOKEN&id_token=S3CR3T-ID`,
    'https://chatgpt.com/',
  ]);
  await flush();
  await store.list();
  const file = join(dir, LINKED_SIGN_IN_FILE_NAME);
  const plain = unseal(readFileSync(file));
  assert.doesNotMatch(plain, /S3CR3T|code|token|client_id|ST4TE|hint/);
  assert.deepEqual(JSON.parse(plain), {
    version: 1,
    links: [
      {
        site: 'chatgpt.com',
        redirectHost: 'auth.openai.com',
        provider: 'google.com',
        identity: 'tempest1033@gmail.com',
        lastUsedAt: 5_001,
      },
    ],
  });
  assert.doesNotMatch(readFileSync(file, 'latin1'), /tempest1033/, 'sealed at rest');

  // Another instance reads it back; a new sign-in of the pair replaces it,
  // and one that named no account (or no valid one) keeps none.
  const again = open();
  assert.deepEqual(await again.list(), [
    {
      id: linkedSignInId('chatgpt.com', 'google.com'),
      site: 'chatgpt.com',
      redirectHost: 'auth.openai.com',
      provider: 'google.com',
      identity: 'tempest1033@gmail.com',
      lastUsedAt: 5_001,
    },
  ]);
  await again.record({ site: 'chatgpt.com', redirectHost: 'auth.openai.com', provider: 'google.com', identity: '' });
  await again.record({ site: 'example.com', redirectHost: 'app.example.com', provider: 'x.com', identity: '@tempest' });
  await again.record({ site: 'x.dev', redirectHost: '', provider: 'kakao.com', identity: 'not an account' });
  await again.record({ site: 'bad site', redirectHost: '', provider: 'kakao.com', identity: '' });
  assert.deepEqual(
    (await open().list()).map(({ site, provider, identity, lastUsedAt }) => [site, provider, identity, lastUsedAt]),
    [
      ['chatgpt.com', 'google.com', '', 5_002],
      ['example.com', 'x.com', '@tempest', 5_003],
      ['x.dev', 'kakao.com', '', 5_004],
    ]
  );

  // Delete one; clear-all takes the file and its last good copy.
  assert.equal(await again.remove(linkedSignInId('chatgpt.com', 'google.com')), true);
  assert.equal(await again.remove(linkedSignInId('chatgpt.com', 'google.com')), false);
  assert.deepEqual(
    (await open().list()).map((link) => link.site),
    ['example.com', 'x.dev']
  );
  assert.ok(existsSync(`${file}.bak`));
  await again.clear();
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(await again.list(), []);
  assert.deepEqual(await open().list(), []);
});

test('a file any number of records long stays readable after one more is recorded', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-linked-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const links = Array.from({ length: 10_001 }, (_, index) => ({
    site: `s${index}.example`,
    redirectHost: '',
    provider: 'google.com',
    identity: '',
    lastUsedAt: 1,
  }));
  writeFileSync(join(dir, LINKED_SIGN_IN_FILE_NAME), seal(JSON.stringify({ version: 1, links })));
  const store = new LinkedSignInStore({ userDataDirectory: dir, seal, unseal });
  assert.equal((await store.list()).length, 10_001);
  await store.record({ site: 'another.example', redirectHost: '', provider: 'google.com', identity: '' });
  const reopened = new LinkedSignInStore({ userDataDirectory: dir, seal, unseal });
  assert.equal((await reopened.list()).length, 10_002);
});

test('a linked sign-in file of another shape is refused, never overwritten', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-linked-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, LINKED_SIGN_IN_FILE_NAME);
  writeFileSync(file, seal(JSON.stringify({ version: 1, credentials: [] })));
  const store = new LinkedSignInStore({ userDataDirectory: dir, seal, unseal });
  await assert.rejects(store.list(), /could not be opened/);
  await assert.rejects(
    store.record({ site: 'a.dev', redirectHost: '', provider: 'github.com', identity: '' }),
    /could not be opened/
  );
  assert.equal(unseal(readFileSync(file)), JSON.stringify({ version: 1, credentials: [] }));
});
