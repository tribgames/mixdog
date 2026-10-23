import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';

import {
  createBrowserAutoSignIn,
  SAVED_SIGN_IN_DONE,
  SAVED_SIGN_IN_NEEDS_USER,
  SIGN_IN_STATE,
} from './auto-sign-in.ts';

const PASSWORD = 'S3NT1NEL-saved-password';
const VAULT = [{ id: 'a'.repeat(24), origin: 'https://shop.example.com', username: 'me@example.com' }];

/** A page whose sign-in state each step reads, and a host around it. */
function fixture({
  url = 'https://shop.example.com/login',
  enabled = true,
  after = 'signed-in',
  collect,
  resetTokenOnCredential = false,
  humanCheck = { waitMs: 150, graceMs: 30, pollMs: 5 },
  onProbe,
  onFill,
} = {}) {
  const page = { url, password: true, challenge: false, wording: false, check: 'none' };
  const calls = { suggestions: [], fills: 0, submits: 0, credentials: [], probes: 0 };
  const guest = { isDestroyed: () => false, getURL: () => page.url };
  const signIn = createBrowserAutoSignIn({
    enabled: () => enabled,
    // profile-import.ts credentialSuggestions: exactly the HTTPS origin, masked labels.
    suggestions: async (pageUrl) => {
      calls.suggestions.push(pageUrl);
      return VAULT.filter((entry) => new URL(pageUrl).origin === entry.origin).map((entry) => ({
        id: entry.id,
        label: 'm•••e@example.com',
      }));
    },
    withCredential: async (_url, id, use) => {
      const entry = VAULT.find((candidate) => candidate.id === id);
      calls.credentials.push(id);
      if (resetTokenOnCredential) page.check = 'pending';
      return use({ username: entry.username, password: PASSWORD });
    },
    fill: async () => {
      calls.fills++;
      onFill?.(page);
      return { usernameFilled: true, passwordFilled: true };
    },
    submit: async () => {
      calls.submits++;
      if (after === 'signed-in') Object.assign(page, { password: false, url: 'https://shop.example.com/account' });
      if (after === 'two-factor') Object.assign(page, { password: false, challenge: true });
      if (after === 'error') Object.assign(page, { password: true });
    },
    collect:
      collect ??
      (async () => {
        calls.probes++;
        onProbe?.(calls.probes, page);
        return [{ password: page.password, challenge: page.challenge, wording: page.wording, check: page.check }];
      }),
    invalidate: () => {},
    humanCheck,
  });
  const run = (turnId = 1, signal) =>
    signIn.afterCommand({
      guest,
      sessionId: 'sess-1',
      turnId,
      signal,
      observe: async () => ({ text: `URL: ${page.url}\n- heading "Page"` }),
    });
  return { page, calls, run };
}

test('a saved login for the exact origin signs in by itself, once, and says so without the secret', async () => {
  const f = fixture();
  const reply = await f.run();
  assert.equal(f.calls.fills, 1);
  assert.equal(f.calls.submits, 1);
  assert.ok(reply.text.startsWith(`${SAVED_SIGN_IN_DONE}shop.example.com`));
  assert.doesNotMatch(JSON.stringify(reply), new RegExp(PASSWORD));
  assert.doesNotMatch(JSON.stringify(reply), /me@example\.com/);
  // Back on a sign-in page in the same turn: no second try.
  Object.assign(f.page, { password: true, url: 'https://shop.example.com/login' });
  assert.equal(await f.run(), null);
  assert.equal(f.calls.fills, 1, 'one attempt per site per turn');
});

test('a lookalike origin, a plain HTTP page or a page with no password field never gets the saved login', async () => {
  for (const url of ['https://shop.example.com.evil.test/login', 'https://shop-example.com/login']) {
    const f = fixture({ url });
    assert.equal(await f.run(), null);
    assert.equal(f.calls.fills, 0);
    assert.deepEqual(f.calls.credentials, []);
  }
  const http = fixture({ url: 'http://shop.example.com/login' });
  assert.equal(await http.run(), null);
  assert.deepEqual(http.calls.suggestions, [], 'the vault is not even consulted');
  const plain = fixture();
  plain.page.password = false;
  assert.equal(await plain.run(), null);
  assert.equal(plain.calls.fills, 0);
});

test('a 2FA step or an error after the one try falls back to the user, never a retry', async () => {
  for (const after of ['two-factor', 'error']) {
    const f = fixture({ after });
    const reply = await f.run();
    assert.ok(reply.text.startsWith(`${SAVED_SIGN_IN_NEEDS_USER}shop.example.com:`), after);
    assert.match(reply.text, /Do not retry; hand the sign-in to the user/);
    assert.equal(await f.run(), null, 'no second attempt');
    assert.equal(f.calls.fills, 1);
  }
  // A page that already shows a challenge is left to the user.
  const challenged = fixture();
  challenged.page.challenge = true;
  assert.equal(await challenged.run(), null);
  assert.equal(challenged.calls.fills, 0);
});

const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const handedOff = (reply) => reply.text.startsWith(`${SAVED_SIGN_IN_NEEDS_USER}shop.example.com:`);
const signedIn = (reply) => reply.text.startsWith(`${SAVED_SIGN_IN_DONE}shop.example.com`);

test('no widget and an already solved one each take exactly one fill and one submit', async () => {
  const none = fixture();
  assert.ok(signedIn(await none.run()));
  assert.equal(none.calls.fills, 1);
  assert.equal(none.calls.submits, 1);
  assert.ok(none.calls.probes > 2, 'the grace polled for a late widget before filling');

  const solved = fixture();
  solved.page.check = 'solved';
  const started = Date.now();
  assert.ok(signedIn(await solved.run()));
  assert.equal(solved.calls.fills, 1);
  assert.equal(solved.calls.submits, 1);
  assert.ok(Date.now() - started < 25, 'no wait for a token that is already there');
});

test('an empty token holds fill and submit until it appears, then signs in once', async () => {
  const f = fixture();
  f.page.check = 'pending';
  const reply = f.run();
  await later(40);
  assert.equal(f.calls.fills, 0, 'the password is not sent while the check is unsolved');
  assert.equal(f.calls.submits, 0);
  assert.deepEqual(f.calls.credentials, []);
  f.page.check = 'solved';
  assert.ok(signedIn(await reply));
  assert.equal(f.calls.fills, 1);
  assert.equal(f.calls.submits, 1);
});

test('a page with no widget at first: one rendered during the grace is waited for', async () => {
  const f = fixture({ humanCheck: { waitMs: 300, graceMs: 100, pollMs: 5 } });
  const reply = f.run();
  await later(30);
  f.page.check = 'pending'; // the widget renders late
  await later(60);
  assert.equal(f.calls.fills, 0);
  f.page.check = 'solved';
  assert.ok(signedIn(await reply));
  assert.equal(f.calls.fills, 1);
  assert.equal(f.calls.submits, 1);
});

test('a token that never appears, then no retry that turn', async () => {
  const f = fixture();
  f.page.check = 'pending';
  assert.ok(handedOff(await f.run()));
  assert.equal(f.calls.fills, 0);
  assert.equal(f.calls.submits, 0);
  assert.equal(await f.run(), null);
  assert.equal(f.calls.fills, 0);
});

test('a widget that vanishes without a token is a hand-off, not a success', async () => {
  const gone = fixture({ humanCheck: { waitMs: 300, graceMs: 30, pollMs: 5 } });
  gone.page.check = 'pending';
  const reply = gone.run();
  await later(20);
  gone.page.check = 'none';
  assert.ok(handedOff(await reply));
  assert.equal(gone.calls.fills, 0);
  assert.equal(gone.calls.submits, 0);

  // Solved, then gone before the fill / after the fill.
  const afterFill = fixture({ onFill: (page) => (page.check = 'none') });
  afterFill.page.check = 'solved';
  assert.ok(handedOff(await afterFill.run()));
  assert.equal(afterFill.calls.fills, 1);
  assert.equal(afterFill.calls.submits, 0);
});

test('a visible challenge before or during the wait is a hand-off, and cancelling throws', async () => {
  const f = fixture();
  f.page.check = 'pending';
  const reply = f.run();
  await later(20);
  f.page.challenge = true;
  assert.ok(handedOff(await reply));
  assert.equal(f.calls.fills, 0);
  assert.equal(f.calls.submits, 0);
  assert.equal(await f.run(), null);

  const cancelled = fixture();
  cancelled.page.check = 'pending';
  const controller = new AbortController();
  const outcome = assert.rejects(cancelled.run(1, controller.signal));
  await later(20);
  controller.abort(new Error('stop'));
  await outcome;
  assert.equal(cancelled.calls.fills, 0);
  assert.equal(cancelled.calls.submits, 0);
});

test('a token reset or a challenge mounted by the fill itself means no submit', async () => {
  for (const mutate of [(page) => (page.check = 'pending'), (page) => (page.challenge = true)]) {
    const f = fixture({ onFill: mutate });
    f.page.check = 'solved';
    assert.ok(handedOff(await f.run()));
    assert.equal(f.calls.fills, 1);
    assert.equal(f.calls.submits, 0);
  }
});

test('a token reset between the wait and the hand-over stops the fill, for every initial state', async () => {
  for (const initial of ['solved', 'none']) {
    const f = fixture({ resetTokenOnCredential: true });
    f.page.check = initial;
    // 'none': nothing was seen before the credential was read; the re-probe still catches the widget.
    assert.ok(handedOff(await f.run()), initial);
    assert.equal(f.calls.credentials.length, 1);
    assert.equal(f.calls.fills, 0);
    assert.equal(f.calls.submits, 0);
  }
});

test('navigation during the awaited re-probe never gives the credential to the new page', async () => {
  // Probe 1 is the first look; probe 2 runs inside the credential callback.
  const f = fixture({
    onProbe: (count, page) => {
      if (count === 2) page.url = 'https://shop.example.com.evil.test/login';
    },
  });
  f.page.check = 'solved';
  assert.ok(handedOff(await f.run()));
  assert.equal(f.calls.credentials.length, 1);
  assert.equal(f.calls.fills, 0);
  assert.equal(f.calls.submits, 0);
});

test('cancelling during the in-callback probe sends nothing', async () => {
  const controller = new AbortController();
  const f = fixture({ onProbe: (count) => count === 2 && controller.abort(new Error('stop')) });
  f.page.check = 'solved';
  await assert.rejects(f.run(1, controller.signal));
  assert.equal(f.calls.fills, 0);
  assert.equal(f.calls.submits, 0);
});

// The real probe, evaluated in jsdom documents.
const PASSWORD_FIELD = '<form><input type="password" name="pw"></form>';
function pageDom(html) {
  const dom = new JSDOM(`<body>${PASSWORD_FIELD}${html}</body>`, { runScripts: 'outside-only' });
  dom.window.Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20 });
  return dom;
}
const probeDom = (dom) => dom.window.eval(SIGN_IN_STATE);
const probe = (html) => probeDom(pageDom(html));
const TURNSTILE_EMPTY = '<div class="cf-turnstile"><input type="hidden" name="cf-turnstile-response" value=""></div>';
const TURNSTILE_DONE = '<div class="cf-turnstile"><input type="hidden" name="cf-turnstile-response" value="tok"></div>';
const RECAPTCHA_DONE = '<div class="g-recaptcha"><textarea name="g-recaptcha-response">tok</textarea></div>';
const HCAPTCHA_DONE = '<div class="h-captcha"><textarea name="h-captcha-response">tok</textarea></div>';
const BADGE = '<div class="grecaptcha-badge"><textarea name="g-recaptcha-response"></textarea></div>';

test('probe: hidden response fields and provider containers, each judged alone', () => {
  assert.equal(probe(PASSWORD_FIELD).check, 'none');
  assert.equal(probe(TURNSTILE_EMPTY).check, 'pending');
  assert.equal(probe(TURNSTILE_DONE).check, 'solved');
  assert.equal(probe(RECAPTCHA_DONE + HCAPTCHA_DONE).check, 'solved');
  assert.equal(probe('<input type="hidden" name="cf-turnstile-response" value="">').check, 'pending');
  assert.equal(probe('<input type="hidden" name="cf-turnstile-response" value="tok">').check, 'solved');
  assert.equal(probe('<div class="cf-turnstile"></div>').check, 'pending', 'rendered, no field yet');
});

test('probe: no suppression and no sharing across widgets', () => {
  // Same provider: one solved, one empty.
  assert.equal(probe(TURNSTILE_DONE + TURNSTILE_EMPTY).check, 'pending');
  assert.equal(probe(TURNSTILE_DONE + '<div class="cf-turnstile"></div>').check, 'pending');
  // One loose token does not fill two containers.
  assert.equal(
    probe('<div class="cf-turnstile"></div><div class="cf-turnstile"></div><input type="hidden" name="cf-turnstile-response" value="tok">').check,
    'pending'
  );
  // A solved other provider does not cover a pending one.
  assert.equal(probe(RECAPTCHA_DONE + '<div class="cf-turnstile"></div>').check, 'pending');
  assert.equal(probe(RECAPTCHA_DONE + TURNSTILE_EMPTY).check, 'pending');
  // A deferred sibling is pending itself and hides nothing else.
  const deferred = '<div class="cf-turnstile" data-execution="execute"></div>';
  assert.equal(probe(deferred).check, 'pending');
  assert.equal(probe(TURNSTILE_DONE + deferred).check, 'pending');
  assert.equal(probe('<div class="h-captcha" data-size="invisible"></div>' + TURNSTILE_EMPTY).check, 'pending');
  // The badge (and its own field) is not evidence and suppresses nothing outside itself.
  assert.equal(probe(BADGE).check, 'none');
  assert.equal(probe(BADGE + TURNSTILE_EMPTY).check, 'pending');
  assert.equal(probe(BADGE + '<div class="g-recaptcha"></div>').check, 'pending');
  assert.equal(probe(BADGE + TURNSTILE_DONE).check, 'solved');
});

test('probe: a token solved and then emptied is pending again', () => {
  const dom = pageDom(TURNSTILE_DONE);
  assert.equal(probeDom(dom).check, 'solved');
  dom.window.document.querySelector('[name="cf-turnstile-response"]').value = '';
  assert.equal(probeDom(dom).check, 'pending');
});

test('probe: a bare site key, a script and widget frames are no evidence', () => {
  assert.equal(probe('<div data-sitekey="k"></div><button data-sitekey="k">Go</button>').check, 'none');
  assert.equal(probe('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>').check, 'none');
  assert.equal(probe('<script src="https://www.google.com/recaptcha/api.js?render=k"></script>').check, 'none');
  assert.equal(probe('<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/if/x"></iframe>').check, 'none');
  assert.equal(probe('<iframe src="https://www.google.com/recaptcha/api2/anchor?k=1"></iframe>').challenge, false);
});

test('probe: an image challenge frame or a generic CAPTCHA frame is a hand-off', () => {
  assert.equal(probe('<iframe src="https://www.google.com/recaptcha/api2/bframe?k=1"></iframe>').challenge, true);
  assert.equal(probe('<iframe src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=challenge"></iframe>').challenge, true);
  assert.equal(probe('<iframe src="https://x.test/captcha/img"></iframe>').challenge, true);
  assert.equal(probe('<iframe style="display:none" src="https://x.test/captcha/img"></iframe>').challenge, false, 'a hidden one is no challenge shown');
  assert.equal(probe(TURNSTILE_EMPTY).challenge, false);
});

test("probe: a badge's filled field inside an empty widget box does not solve the box", () => {
  const box = `<div class="g-recaptcha"><div class="grecaptcha-badge"><textarea name="g-recaptcha-response">tok</textarea></div></div>`;
  assert.equal(probe(box).check, 'pending');
});

/** A fixture whose collect runs the real probe over several frames. */
function framedFixture(...docs) {
  return fixture({
    collect: async (_guest, expression) => docs.map((dom) => dom.window.eval(expression)),
  });
}

test('frames merge: one pending frame holds the sign-in, then it goes through', async () => {
  const main = pageDom(TURNSTILE_DONE);
  const embedded = pageDom(TURNSTILE_EMPTY);
  const f = framedFixture(main, embedded);
  const reply = f.run();
  await later(40);
  assert.equal(f.calls.fills, 0);
  assert.equal(f.calls.submits, 0);
  embedded.window.document.querySelector('[name="cf-turnstile-response"]').value = 'tok';
  await reply;
  assert.equal(f.calls.fills, 1);
  assert.equal(f.calls.submits, 1);
});

test('frames merge: a challenge in any frame leaves the page to the user', async () => {
  const f = framedFixture(
    pageDom(TURNSTILE_DONE),
    pageDom('<iframe src="https://www.google.com/recaptcha/api2/bframe?k=1"></iframe>')
  );
  assert.equal(await f.run(), null);
  assert.equal(f.calls.fills, 0);
  assert.equal(f.calls.submits, 0);
});

test('with the setting off nothing changes: no vault read, no fill', async () => {
  const f = fixture({ enabled: false });
  assert.equal(await f.run(), null);
  assert.deepEqual(f.calls.suggestions, []);
  assert.equal(f.calls.fills, 0);
});
