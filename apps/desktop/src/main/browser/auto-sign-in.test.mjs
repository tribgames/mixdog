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
  onSubmit,
  approveSubmit,
} = {}) {
  const page = { url, password: true, challenge: false, wording: false, check: 'none' };
  const calls = { suggestions: [], fills: 0, submits: 0, sent: 0, credentials: [], probes: 0, approvals: 0 };
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
    submit: async (_guest, _signal, beforeDispatch) => {
      calls.submits++;
      // The host waits for the debugger here; the page may move meanwhile.
      await onSubmit?.(page);
      beforeDispatch?.();
      calls.sent++;
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
    ...(approveSubmit
      ? {
          approveSubmit: async () => {
            calls.approvals++;
            await approveSubmit(page);
          },
        }
      : {}),
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

test('a navigation while the submit waits for the debugger never sends Enter to the new page', async () => {
  const f = fixture({
    onSubmit: (page) => {
      page.url = 'https://shop.example.com.evil.test/login';
    },
  });
  f.page.check = 'solved';
  assert.ok(handedOff(await f.run()));
  assert.equal(f.calls.fills, 1);
  assert.equal(f.calls.submits, 1);
  assert.equal(f.calls.sent, 0, 'the key guard saw the new address and refused');
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

test('the submit follows the approval policy: an approval lets it through, a block sends nothing', async () => {
  // Approved: the fill happens, approval is asked once, then Enter is sent.
  const ok = fixture({ approveSubmit: async () => {} });
  assert.ok(signedIn(await ok.run()));
  assert.equal(ok.calls.fills, 1);
  assert.equal(ok.calls.approvals, 1);
  assert.equal(ok.calls.submits, 1);
  assert.equal(ok.calls.sent, 1);

  // Blocked: the password was filled, but no Enter is sent and the sign-in
  // is handed to the user — exactly one attempt, no retry that turn.
  const blocked = fixture({
    approveSubmit: async () => {
      throw new Error('tool "browser" was not approved');
    },
  });
  assert.ok(handedOff(await blocked.run()));
  assert.equal(blocked.calls.fills, 1);
  assert.equal(blocked.calls.approvals, 1);
  assert.equal(blocked.calls.submits, 0);
  assert.equal(await blocked.run(), null);
  assert.equal(blocked.calls.submits, 0);
});

test('with the setting off nothing changes: no vault read, no fill', async () => {
  const f = fixture({ enabled: false });
  assert.equal(await f.run(), null);
  assert.deepEqual(f.calls.suggestions, []);
  assert.equal(f.calls.fills, 0);
});

// ---- Multi-step sign-in: a username page, the password, a one-time code ----

const ACCOUNT_A = 'a'.repeat(24);
const ACCOUNT_B = 'b'.repeat(24);
const CODE = '482910';

/** A scripted site: `pages[i]` is what the probe sees; each submit moves to the next page. */
function flow({ pages, suggestions, code, approveSubmit, afterLast = {} }) {
  let index = 0;
  const log = { fills: [], codes: [], submits: 0, used: [], prefilled: [], credentialIds: [], codeValueCalls: 0 };
  const defaults = {
    password: false, challenge: false, wording: false, check: 'none', code: false, captcha: false,
    username: false, identifier: '', sent: false,
  };
  const at = () => pages[Math.min(index, pages.length - 1)];
  const guest = { isDestroyed: () => false, getURL: () => at().url ?? 'https://shop.example.com/login' };
  const signIn = createBrowserAutoSignIn({
    enabled: () => true,
    suggestions: async (_url, prefilled) => {
      log.prefilled.push(prefilled);
      return suggestions ?? [{ id: ACCOUNT_A, label: 'm•••e@example.com' }];
    },
    withCredential: async (_url, id, use) => {
      log.credentialIds.push(id);
      return use({ username: 'me@example.com', password: PASSWORD });
    },
    fill: async (_guest, credential, _signal, step) => {
      log.fills.push({ credential: { ...credential }, step });
      return step === 'username'
        ? { usernameFilled: true, passwordFilled: false }
        : { usernameFilled: Boolean(credential.username), passwordFilled: true };
    },
    submit: async (_guest, _signal, beforeDispatch) => {
      beforeDispatch?.();
      log.submits += 1;
      index += 1;
    },
    ...(approveSubmit ? { approveSubmit } : {}),
    recordUsed: async (_url, id) => {
      log.used.push(id);
    },
    ...(code
      ? {
          code: {
            value: async () => {
              log.codeValueCalls += 1;
              return code.value;
            },
            fill: async (_guest, typed) => {
              log.codes.push(typed);
              return true;
            },
          },
        }
      : {}),
    collect: async () => [{ ...defaults, ...afterLast, ...at().state }],
    invalidate: () => {},
    humanCheck: { waitMs: 100, graceMs: 20, pollMs: 5, stepMs: 60 },
  });
  const run = () =>
    signIn.afterCommand({
      guest,
      sessionId: 'sess-1',
      turnId: 1,
      observe: async () => ({ text: `URL: ${guest.getURL()}\n- heading "Page"` }),
    });
  return { run, log };
}

const USER_PAGE = { state: { username: true }, url: 'https://shop.example.com/login' };
const PASSWORD_PAGE = { state: { password: true }, url: 'https://shop.example.com/login/password' };
const SIGNED_IN = { state: {}, url: 'https://shop.example.com/account' };
const CODE_PAGE = { state: { code: true, challenge: true }, url: 'https://shop.example.com/login/code' };

test('a username-only sign-in page: the username, Enter, then the password and Enter — one attempt', async () => {
  const f = flow({ pages: [USER_PAGE, PASSWORD_PAGE, SIGNED_IN] });
  const reply = await f.run();
  assert.ok(signedIn(reply), reply.text);
  assert.deepEqual(
    f.log.fills.map((fill) => fill.step),
    ['username', undefined]
  );
  assert.equal(f.log.fills[0].credential.password, '', 'the password is not sent to the username page');
  assert.deepEqual(f.log.fills[1].credential, { username: '', password: PASSWORD });
  assert.equal(f.log.submits, 2);
  assert.deepEqual(f.log.used, [ACCOUNT_A], 'the account is recorded as last used');
  assert.doesNotMatch(JSON.stringify(reply), new RegExp(PASSWORD));
  assert.equal(await f.run(), null, 'no second attempt this turn');
});

test('a username step whose next page never shows a password field hands off after one submit', async () => {
  const f = flow({ pages: [USER_PAGE, { state: {}, url: 'https://shop.example.com/login/wait' }] });
  const reply = await f.run();
  assert.ok(handedOff(reply), reply.text);
  assert.equal(f.log.submits, 1);
  assert.deepEqual(f.log.used, []);
  // ...and so does a username step that leaves the origin.
  const away = flow({ pages: [USER_PAGE, { state: { password: true }, url: 'https://sso.example.org/password' }] });
  assert.ok(handedOff(await away.run()));
  assert.equal(away.log.fills.length, 1, 'the password page of another origin gets nothing');
});

test('several saved accounts: the first the vault ranks is used, after the identifier prefilled on the page', async () => {
  const f = flow({
    pages: [{ state: { password: true, identifier: 'me@example.com' } }, SIGNED_IN],
    suggestions: [
      { id: ACCOUNT_B, label: 'o•••r' },
      { id: ACCOUNT_A, label: 'm•••e@example.com' },
    ],
  });
  assert.ok(signedIn(await f.run()));
  assert.deepEqual(f.log.prefilled, ['me@example.com'], 'the prefilled identifier reaches the ranking');
  assert.deepEqual([...new Set(f.log.credentialIds)], [ACCOUNT_B], 'the head of the ranking, nobody else');
  assert.deepEqual(f.log.used, [ACCOUNT_B]);
});

test('a one-time code after the password is made on the host and typed with a stored key; without one it hands off', async () => {
  const withKey = flow({ pages: [{ state: { password: true } }, CODE_PAGE, SIGNED_IN], code: { value: CODE } });
  const reply = await withKey.run();
  assert.ok(signedIn(reply), reply.text);
  assert.deepEqual(withKey.log.codes, [CODE]);
  assert.equal(withKey.log.submits, 2, 'password and code, nothing more');
  assert.doesNotMatch(JSON.stringify(reply), new RegExp(`${CODE}|${PASSWORD}`));

  // From a username page all the way: three steps, the bounded maximum.
  const three = flow({ pages: [USER_PAGE, PASSWORD_PAGE, CODE_PAGE, SIGNED_IN], code: { value: CODE } });
  assert.ok(signedIn(await three.run()));
  assert.equal(three.log.submits, 3);

  const noKey = flow({ pages: [{ state: { password: true } }, CODE_PAGE, CODE_PAGE], code: { value: '' } });
  assert.ok(handedOff(await noKey.run()));
  assert.deepEqual(noKey.log.codes, []);
  assert.equal(noKey.log.submits, 1);

  // A code the site sends by SMS or email, a CAPTCHA next to it, or a wrong
  // code that leaves the field standing: the user's.
  for (const state of [
    { code: true, challenge: true, sent: true },
    { code: true, challenge: true, captcha: true },
  ]) {
    const f = flow({ pages: [{ state: { password: true } }, { state }], code: { value: CODE } });
    assert.ok(handedOff(await f.run()), JSON.stringify(state));
    assert.deepEqual(f.log.codes, []);
    assert.equal(f.log.codeValueCalls, 0, 'no code is even made');
  }
  const wrong = flow({ pages: [{ state: { password: true } }, CODE_PAGE, CODE_PAGE, CODE_PAGE], code: { value: CODE } });
  assert.ok(handedOff(await wrong.run()));
  assert.equal(wrong.log.submits, 2, 'never a second code');
});

test('the sign-in submit still goes through the approval policy: a block sends nothing', async () => {
  const f = flow({
    pages: [USER_PAGE, PASSWORD_PAGE, SIGNED_IN],
    approveSubmit: async () => {
      throw new Error('blocked by this bot\'s permission');
    },
  });
  assert.ok(handedOff(await f.run()));
  assert.equal(f.log.submits, 0);
});

// The real probe for the new steps.
function domAt(url, html) {
  const dom = new JSDOM(`<!doctype html><title>Page</title><body>${html}</body>`, { url, runScripts: 'outside-only' });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
  dom.window.Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20 });
  return dom;
}
const state = (url, html) => domAt(url, html).window.eval(SIGN_IN_STATE);

test('probe: a username-only step is one username/email field alone on a page that says sign-in', () => {
  const email = '<form><input type="email" name="email"></form>';
  assert.equal(state('https://shop.example.com/login', email).username, true);
  assert.equal(state('https://shop.example.com/signin?next=/', '<input name="username" type="text">').username, true);
  assert.equal(state('https://shop.example.com/blog', email).username, false, 'a newsletter box on a content page');
  assert.equal(state('https://shop.example.com/blog', '<input name="x" autocomplete="username">').username, true, 'explicit autocomplete');
  assert.equal(state('https://shop.example.com/login', email + '<input name="q" type="search">').username, false, 'not alone');
  assert.equal(state('https://shop.example.com/login', '<input name="nickname" type="text">').username, false, 'not an identifier');
  assert.equal(state('https://shop.example.com/login', email + '<input type="password">').username, false, 'a password page');
  assert.equal(state('https://shop.example.com/login', '<input type="email" name="email" value="me@example.com">').identifier, 'me@example.com');
});

test('probe: a code field, one box per digit, and a code sent by SMS', () => {
  const boxes = Array.from({ length: 6 }, () => '<input maxlength="1" inputmode="numeric">').join('');
  const split = state('https://shop.example.com/verify', boxes);
  assert.equal(split.code, true);
  assert.equal(split.challenge, true);
  assert.equal(split.captcha, false);
  assert.equal(state('https://shop.example.com/verify', '<input autocomplete="one-time-code">').code, true);
  assert.equal(state('https://shop.example.com/verify', '<input name="q">').code, false);
  const sms = domAt('https://shop.example.com/verify', '<input autocomplete="one-time-code"><p>We sent a text message with a code.</p>');
  assert.equal(sms.window.eval(SIGN_IN_STATE).sent, true);
  const app = domAt('https://shop.example.com/verify', '<input autocomplete="one-time-code"><p>Open your authenticator app. Text message is off.</p>');
  assert.equal(app.window.eval(SIGN_IN_STATE).sent, false);
});

test('probe: an email field alone is no sign-in evidence; a form that says sign in, or autocomplete username, is', () => {
  const field = (attrs, button = 'Continue') => `<form><input ${attrs}><button>${button}</button></form>`;
  const at = (path, html) => state(`https://shop.example.com${path}`, html).username;
  assert.equal(at('/about', field('type="email" autocomplete="email"')), false, 'autocomplete email alone');
  assert.equal(at('/about', field('type="email" name="email"')), false, 'an email box with no context');
  assert.equal(at('/news', field('type="email" name="email"', 'Subscribe')), false, 'a newsletter form');
  assert.equal(at('/login', field('type="email" name="email"', 'Subscribe to our newsletter')), false, 'subscribe beats the URL');
  assert.equal(at('/about', field('type="email" name="email"', 'Sign up')), false);
  assert.equal(at('/about', field('type="email" name="email"', 'Log in')), true, 'its own form says log in');
  assert.equal(at('/about', field('type="email" name="email"', '로그인')), true);
  assert.equal(at('/login', field('type="email" name="email"')), true, 'the page says sign in');
  assert.equal(at('/about', field('type="text" autocomplete="username"')), true, 'autocomplete username');
  assert.equal(at('/about', '<h1>Log in</h1><input type="email" name="email">'), true, 'a heading, no form');
  assert.equal(at('/about', '<nav><button>Log in</button></nav><input type="email" name="email">'), false, 'a nav button is not context');
});

test('a newsletter form with one email field and a saved login for the origin: nothing is filled or submitted', async () => {
  const dom = domAt('https://shop.example.com/blog/post', '<form><input type="email" name="email" autocomplete="email"><button>Subscribe</button></form>');
  const calls = { fills: 0, submits: 0, approvals: 0, credentials: 0 };
  const signIn = createBrowserAutoSignIn({
    enabled: () => true,
    suggestions: async () => [{ id: ACCOUNT_A, label: 'm•••e@example.com' }],
    withCredential: async (_url, _id, use) => {
      calls.credentials += 1;
      return use({ username: 'me@example.com', password: PASSWORD });
    },
    fill: async () => {
      calls.fills += 1;
      return { usernameFilled: true, passwordFilled: false };
    },
    submit: async () => {
      calls.submits += 1;
    },
    approveSubmit: async () => {
      calls.approvals += 1;
    },
    collect: async () => [dom.window.eval(SIGN_IN_STATE)],
    invalidate: () => {},
  });
  const guest = { isDestroyed: () => false, getURL: () => 'https://shop.example.com/blog/post' };
  const reply = await signIn.afterCommand({ guest, sessionId: 's', turnId: 1, observe: async () => ({ text: 'page' }) });
  assert.equal(reply, null);
  assert.deepEqual(calls, { fills: 0, submits: 0, approvals: 0, credentials: 0 });
});

test('every automatic step is bound to the main-frame document its state was read on', async () => {
  let reads = 0;
  const documents = [];
  const fills = [];
  const make = (documentFor) =>
    createBrowserAutoSignIn({
      enabled: () => true,
      suggestions: async () => [{ id: ACCOUNT_A, label: 'm•••e@example.com' }],
      withCredential: async (_url, _id, use) => use({ username: 'me@example.com', password: PASSWORD }),
      document: async () => documentFor(),
      fill: async (_guest, _credential, _signal, _step, document) => {
        fills.push(document);
        return { usernameFilled: true, passwordFilled: true };
      },
      submit: async () => {},
      collect: async () => [{ password: true, challenge: false, wording: false, check: 'none' }],
      invalidate: () => {},
      humanCheck: { waitMs: 20, graceMs: 5, pollMs: 2, stepMs: 10 },
    });
  const guest = { isDestroyed: () => false, getURL: () => 'https://shop.example.com/login' };
  const run = (signIn, turnId) => signIn.afterCommand({ guest, sessionId: 's', turnId, observe: async () => ({ text: 'page' }) });
  // The same document before and after the probe: the fill is bound to it.
  await run(make(() => 'main:L1'), 1);
  assert.equal(fills[0], 'main:L1');
  // A document swapped while the state was read is no reading: nothing is filled.
  fills.length = 0;
  assert.equal(await run(make(() => `main:L${++reads}`), 2), null);
  assert.deepEqual(fills, []);
  // A browser that reports no document leaves nothing to bind to: nothing is filled.
  assert.equal(await run(make(() => ''), 3), null);
  assert.deepEqual(fills, []);
  void documents;
});

test('a sign-up or subscribe form never qualifies, even with autocomplete="username"', async () => {
  const html = '<form><input autocomplete="username"><button>Sign up</button></form>';
  assert.equal(state('https://shop.example.com/login', html).username, false);
  assert.equal(state('https://shop.example.com/about', '<form><input autocomplete="username"><button>Subscribe</button></form>').username, false);
  assert.equal(state('https://shop.example.com/about', '<form><input autocomplete="username"><button>Continue</button></form>').username, true);
  const dom = domAt('https://shop.example.com/login', html);
  const calls = { fills: 0, submits: 0 };
  const signIn = createBrowserAutoSignIn({
    enabled: () => true,
    suggestions: async () => [{ id: ACCOUNT_A, label: 'm•••e@example.com' }],
    withCredential: async (_url, _id, use) => use({ username: 'me@example.com', password: PASSWORD }),
    fill: async () => {
      calls.fills += 1;
      return { usernameFilled: true, passwordFilled: false };
    },
    submit: async () => {
      calls.submits += 1;
    },
    collect: async () => [dom.window.eval(SIGN_IN_STATE)],
    invalidate: () => {},
  });
  const guest = { isDestroyed: () => false, getURL: () => 'https://shop.example.com/login' };
  assert.equal(await signIn.afterCommand({ guest, sessionId: 's', turnId: 1, observe: async () => ({ text: 'page' }) }), null);
  assert.deepEqual(calls, { fills: 0, submits: 0 });
});
