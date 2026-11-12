// #301: a secrets-less config load (explore) marks every OAuth entry
// probe-unavailable, so an OAuth-only setup has no enabled entry. The live
// OAuth instance must be preserved instead of the init failing as all-disabled.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// A private data dir holds no account bindings, so the probe reads only the
// credential file below, never the user's real (or selected-account) one.
const dir = mkdtempSync(join(tmpdir(), 'mixdog-oauth-only-'));
const credentials = join(dir, 'anthropic.json');
writeFileSync(
  credentials,
  JSON.stringify({ claudeAiOauth: { accessToken: 'token', scopes: ['user:inference'], expiresAt: 0 } })
);
const previous = {
  MIXDOG_DATA_DIR: process.env.MIXDOG_DATA_DIR,
  ANTHROPIC_OAUTH_CREDENTIALS_PATH: process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH,
};
process.env.MIXDOG_DATA_DIR = dir;
process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH = credentials;
test.after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const { _withRegisteredProviderForTestAsync, getProvider, initProviders, syncProviders } = await import(
  './registry.mjs'
);
const live = { name: 'anthropic-oauth' };

test('an OAuth-only secrets-less init keeps the live OAuth provider instead of failing', async () => {
  await _withRegisteredProviderForTestAsync('anthropic-oauth', live, async () => {
    await initProviders({ 'anthropic-oauth': { enabled: false, credentialProbeUnavailable: true } });
    assert.equal(getProvider('anthropic-oauth'), live);
  });
});

test('a record whose OAuth credential could not be read keeps the live provider; a stored opt-out removes it', async () => {
  await _withRegisteredProviderForTestAsync('anthropic-oauth', live, async () => {
    const record = { 'anthropic-oauth': { enabled: false, credentialProbeUnavailable: true } };
    await syncProviders(record, { decisions: {} });
    assert.equal(getProvider('anthropic-oauth'), live);
    // Logout writes enabled:false: the provider leaves, and its credential
    // file (still readable here) does not lazily bring it back.
    await syncProviders({ 'anthropic-oauth': { enabled: false } }, { decisions: { 'anthropic-oauth': { enabled: false } } });
    assert.equal(getProvider('anthropic-oauth'), undefined);
  });
});
