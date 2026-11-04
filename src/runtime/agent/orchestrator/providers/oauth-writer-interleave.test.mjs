// Sign-in and sign-out landing while a refresh holds a provider's token-store
// lock must wait for it: a synchronous writer against the asynchronous holder
// fails with ELOCKCONTENDED instead of saving the new login.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'oauth-interleave-')));
process.env.MIXDOG_DATA_DIR = dir;
process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
delete process.env.OPENAI_OAUTH_CREDENTIALS_PATH;
delete process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH;
process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH = join(dir, 'anthropic-oauth-credentials.json');
test.after(() => rmSync(dir, { recursive: true, force: true }));

const { withFileLock } = await import('../../../shared/atomic-file.mjs');
const openai = await import('./openai-oauth-tokens.mjs');
const antigravity = await import('./antigravity-oauth-tokens.mjs');
const anthropic = await import('./anthropic-oauth-credentials.mjs');

// The writer is started while another (async) holder owns the store lock.
async function whileLockHeld(storePath, start) {
  let writer;
  await withFileLock(`${storePath}.lock`, async () => {
    writer = Promise.resolve().then(start);
    writer.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  return writer;
}

test('openai sign-in waits for a refresh holding the token lock', async () => {
  const path = openai.getOwnTokenPath();
  await whileLockHeld(path, () => openai.saveTokens({ access_token: 'at-new', refresh_token: 'rt-new' }));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).access_token, 'at-new');
});

test('antigravity sign-in and sign-out wait for a refresh holding the token lock', async () => {
  const path = antigravity.getOwnTokenPath();
  await whileLockHeld(path, () => antigravity.saveTokens({ access_token: 'at-new', refresh_token: 'rt-new' }));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).access_token, 'at-new');
  assert.equal(await whileLockHeld(path, () => antigravity.forgetAntigravityOAuthCredentials()), true);
});

test('anthropic sign-out waits for a refresh holding the credentials lock', async () => {
  const path = process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } }));
  const result = await whileLockHeld(path, () => anthropic.forgetAnthropicOAuthCredentials());
  assert.deepEqual(result, { removed: true });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).claudeAiOauth, undefined);
});
