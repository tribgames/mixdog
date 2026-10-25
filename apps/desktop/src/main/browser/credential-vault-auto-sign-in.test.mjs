// Auto sign-in over the real vault: the identifier the page prefilled picks the
// account, and logins that differ only by username case are never guessed.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

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

const { CredentialVault } = await import('./credential-vault.ts');
const { createBrowserAutoSignIn, SAVED_SIGN_IN_DONE, SAVED_SIGN_IN_NEEDS_USER } = await import('./auto-sign-in.ts');

const seal = (plaintext) => Buffer.from(plaintext, 'utf8').reverse();
const unseal = (sealed) => Buffer.from(sealed).reverse().toString('utf8');
const ORIGIN = 'https://shop.example.com';

/** A vault holding `usernames` (each with its own password), and a sign-in page
 *  prefilling `identifier`; the run reports who was filled and submitted. */
async function signInWith(t, usernames, identifier) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-cred-autosignin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const vault = new CredentialVault({ userDataDirectory: dir, seal, unseal });
  for (const username of usernames) {
    await vault.upsert({ origin: ORIGIN, username, password: `pw-${username}`, source: 'chat' });
  }
  const names = Object.fromEntries((await vault.list()).map((login) => [login.id, login.username]));
  const log = { read: [], filled: [], submits: 0, used: [] };
  const pages = [
    { state: { password: true, identifier }, url: `${ORIGIN}/login` },
    { state: {}, url: `${ORIGIN}/account` },
  ];
  let index = 0;
  const defaults = {
    password: false, challenge: false, wording: false, check: 'none', code: false, captcha: false,
    username: false, identifier: '', sent: false,
  };
  const signIn = createBrowserAutoSignIn({
    enabled: () => true,
    suggestions: (url, prefilled) => vault.preferredAccountsFor(url, prefilled),
    withCredential: async (_url, id, use) => {
      log.read.push(names[id]);
      return use({ username: names[id], password: `pw-${names[id]}` });
    },
    fill: async (_guest, credential) => {
      log.filled.push(credential.username);
      return { usernameFilled: true, passwordFilled: true };
    },
    submit: async (_guest, _signal, beforeDispatch) => {
      beforeDispatch?.();
      log.submits += 1;
      index += 1;
    },
    recordUsed: async (_url, id) => {
      log.used.push(names[id]);
    },
    collect: async () => [{ ...defaults, ...pages[index].state }],
    invalidate: () => {},
    humanCheck: { waitMs: 100, graceMs: 20, pollMs: 5, stepMs: 60, submitMs: 60 },
  });
  const guest = { isDestroyed: () => false, getURL: () => pages[index].url, isLoading: () => false };
  const reply = await signIn.afterCommand({
    guest,
    sessionId: 'sess-1',
    turnId: 1,
    observe: async () => ({ text: `URL: ${guest.getURL()}\n- heading "Page"` }),
  });
  return { reply, log };
}

const handedOff = ({ reply }) => reply.text.startsWith(`${SAVED_SIGN_IN_NEEDS_USER}shop.example.com:`);
const signedIn = ({ reply }) => reply.text.startsWith(`${SAVED_SIGN_IN_DONE}shop.example.com`);

test('PAT on the page, Pat and pat saved: no guess — nothing is read, filled or submitted, the user is asked', async (t) => {
  const run = await signInWith(t, ['Pat', 'pat'], 'PAT');
  assert.ok(handedOff(run), run.reply.text);
  assert.deepEqual(run.log, { read: [], filled: [], submits: 0, used: [] });
});

test('the same with an email identifier and with an unrelated account saved last', async (t) => {
  const email = await signInWith(t, ['Pat@example.com', 'pat@example.com'], 'PAT@example.com');
  assert.ok(handedOff(email), email.reply.text);
  assert.deepEqual(email.log, { read: [], filled: [], submits: 0, used: [] });
  const crowded = await signInWith(t, ['Pat', 'pat', 'zed'], 'PAT');
  assert.ok(handedOff(crowded), crowded.reply.text);
  assert.deepEqual(crowded.log.filled, []);
});

test('the exact username Pat signs in as Pat, though pat exists', async (t) => {
  const run = await signInWith(t, ['Pat', 'pat'], 'Pat');
  assert.ok(signedIn(run), run.reply.text);
  assert.deepEqual([...new Set(run.log.read)], ['Pat']);
  assert.deepEqual(run.log.filled, ['Pat']);
  assert.deepEqual(run.log.used, ['Pat']);
  const lower = await signInWith(t, ['Pat', 'pat'], 'pat');
  assert.ok(signedIn(lower), lower.reply.text);
  assert.deepEqual(lower.log.filled, ['pat']);
});

test('a lone pat with PAT on the page signs in as pat', async (t) => {
  const run = await signInWith(t, ['pat'], 'PAT');
  assert.ok(signedIn(run), run.reply.text);
  assert.deepEqual(run.log.filled, ['pat']);
  assert.deepEqual(run.log.used, ['pat']);
});
