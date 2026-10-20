import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserAutoSignIn, SAVED_SIGN_IN_DONE, SAVED_SIGN_IN_NEEDS_USER } from './auto-sign-in.ts';

const PASSWORD = 'S3NT1NEL-saved-password';
const VAULT = [{ id: 'a'.repeat(24), origin: 'https://shop.example.com', username: 'me@example.com' }];

/** A page whose sign-in state each step reads, and a host around it. */
function fixture({ url = 'https://shop.example.com/login', enabled = true, after = 'signed-in' } = {}) {
  const page = { url, password: true, challenge: false, wording: false };
  const calls = { suggestions: [], fills: 0, submits: 0, credentials: [] };
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
      return use({ username: entry.username, password: PASSWORD });
    },
    fill: async () => {
      calls.fills++;
      return { usernameFilled: true, passwordFilled: true };
    },
    submit: async () => {
      calls.submits++;
      if (after === 'signed-in') Object.assign(page, { password: false, url: 'https://shop.example.com/account' });
      if (after === 'two-factor') Object.assign(page, { password: false, challenge: true });
      if (after === 'error') Object.assign(page, { password: true });
    },
    collect: async () => [{ password: page.password, challenge: page.challenge, wording: page.wording }],
    invalidate: () => {},
  });
  const run = (turnId = 1) =>
    signIn.afterCommand({
      guest,
      sessionId: 'sess-1',
      turnId,
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

test('with the setting off nothing changes: no vault read, no fill', async () => {
  const f = fixture({ enabled: false });
  assert.equal(await f.run(), null);
  assert.deepEqual(f.calls.suggestions, []);
  assert.equal(f.calls.fills, 0);
});
