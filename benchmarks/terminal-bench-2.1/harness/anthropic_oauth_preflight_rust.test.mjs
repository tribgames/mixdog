import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { anthropicRow, fileLeaseOf, leaseOf, preflight, scrubTokens, snapshotOf } from './anthropic_oauth_preflight_rust.mjs';

const NOW = 1_800_000_000_000;
let renewedPath = '';
const row = (overrides = {}) => ({ id: 'anthropic-oauth', authenticated: true, usable: true, reauthRequired: false, status: 'Valid', expiresAt: NOW + 3_600_000, detail: renewedPath, ...overrides });

test('the lease is read from the account status row', () => {
  assert.deepEqual(leaseOf(row(), 600_000, NOW), { expiresAt: NOW + 3_600_000, remainingMs: 3_600_000 });
  assert.throws(() => leaseOf(row({ expiresAt: NOW + 1000 }), 600_000, NOW), /cannot satisfy the 600s credential lease \(the credential has 1s\)/);
  assert.throws(() => leaseOf(row({ expiresAt: null }), 1, NOW), /has 0s/);
  assert.throws(() => leaseOf(row({ authenticated: false }), 0, NOW), /no credentials/);
  assert.throws(() => leaseOf(row({ reauthRequired: true, status: 'Reauth Required' }), 0, NOW), /new sign-in \(Reauth Required\)/);
  assert.throws(() => leaseOf(row({ usable: false, status: 'Missing Scope' }), 0, NOW), /not usable \(Missing Scope\)/);
  assert.throws(() => leaseOf(undefined, 0, NOW), /no anthropic-oauth provider/);
  assert.equal(anthropicRow({ oauth: [{ id: 'openai-oauth' }, row()] }).id, 'anthropic-oauth');
});

test('the uploaded credential is identified by its token, not by its expiry', () => {
  const at = NOW + 3_600_000;
  const doc = (accessToken) => ({ claudeAiOauth: { accessToken, expiresAt: at } });
  assert.deepEqual(fileLeaseOf(doc('tok-a-1234567890'), doc('tok-a-1234567890'), 600_000, NOW), { expiresAt: at, remainingMs: 3_600_000 });
  assert.throws(() => fileLeaseOf(doc('tok-b-1234567890'), doc('tok-a-1234567890'), 600_000, NOW), (error) => {
    assert.match(error.message, /not the credential the core renewed/);
    assert.equal(/tok-|[a-f0-9]{64}/.test(error.message), false, 'neither the token nor its digest is printed');
    return true;
  });
  assert.throws(() => fileLeaseOf(doc(''), doc(''), 0, NOW), /not the credential the core renewed/);
});

test('the snapshot never carries a refresh token, and the source document is left whole', () => {
  const raw = { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', refresh_token: 'r2', expiresAt: 5 }, other: 1 };
  assert.deepEqual(snapshotOf(raw), { claudeAiOauth: { accessToken: 'a', expiresAt: 5 }, other: 1 });
  assert.equal(raw.claudeAiOauth.refreshToken, 'r');
});

test('errors are scrubbed of token text', () => {
  const text = scrubTokens('failed with Bearer abcdefgh12345678 and sk-ant-oat01-abcdefgh and "accessToken": "zzzzzzzzzz" and secret-value-1', ['secret-value-1']);
  assert.equal(/abcdefgh|zzzzzzzzzz|secret-value-1/.test(text), false, text);
});

test('a preflight writes the owner-only snapshot only after the lease is established', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-'));
  try {
    const credentialsPath = join(dir, 'creds.json');
    const snapshotPath = join(dir, 'snapshot.json');
    renewedPath = join(dir, 'core-account.json');
    writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: 'tok-1234567890', refreshToken: 'ref-1234567890', expiresAt: NOW + 3_600_000 } }));
    writeFileSync(renewedPath, JSON.stringify({ claudeAiOauth: { accessToken: 'tok-1234567890', refreshToken: 'ref-1234567890', expiresAt: NOW + 3_600_000 } }));
    const calls = [];
    const setup = { oauth: [row()] };
    const attach = async () => ({
      client: {
        call: async (method, params) => calls.push([method, params]),
        subscribeApp: async () => calls.push(['subscribeApp']),
        store: { section: () => ({ value: setup }), subscribe: () => () => {} },
        close: async () => calls.push(['close']),
      },
      library: async () => ({ waitStore: async (_client, read) => read() }),
    });
    const lease = await preflight({ credentialsPath, minimumValidityMs: 600_000, snapshotPath, attach, now: () => NOW });
    assert.equal(lease.remainingMs, 3_600_000);
    assert.deepEqual(JSON.parse(readFileSync(snapshotPath, 'utf8')), { claudeAiOauth: { accessToken: 'tok-1234567890', expiresAt: NOW + 3_600_000 } });
    assert.deepEqual(calls.map(([name]) => name), ['account/refreshProviderSetup', 'subscribeApp', 'close']);
    assert.deepEqual(calls[0][1], { force: true, refresh: true, renewCredential: 'anthropic-oauth', minimumValidityMs: 600_000 }, 'the core is asked to renew the token for the lease');

    setup.oauth = [row({ expiresAt: NOW + 10 })];
    rmSync(snapshotPath);
    await assert.rejects(preflight({ credentialsPath, minimumValidityMs: 600_000, snapshotPath, attach, now: () => NOW }), /cannot satisfy/);
    assert.throws(() => readFileSync(snapshotPath), /ENOENT/, 'no snapshot when the lease is short');

    // A healthy core account never authorises another file's token, even one with the renewed token's expiry.
    setup.oauth = [row()];
    writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: 'old-1234567890', expiresAt: NOW + 3_600_000 } }));
    await assert.rejects(preflight({ credentialsPath, minimumValidityMs: 600_000, snapshotPath, attach, now: () => NOW }), /not the credential the core renewed/);
    assert.throws(() => readFileSync(snapshotPath), /ENOENT/, 'no snapshot of a token the core did not renew');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
