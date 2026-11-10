import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { preflightAnthropicOAuthCredentials } from './anthropic-oauth-credentials.mjs';

const REFRESH_DISABLED_ENV = 'MIXDOG_ANTHROPIC_OAUTH_REFRESH_DISABLED';

function credentialsFixture(directory, oauth) {
  const path = join(directory, 'anthropic-oauth-credentials.json');
  writeFileSync(path, JSON.stringify({ claudeAiOauth: oauth }), 'utf8');
  return path;
}

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'mixdog-anthropic-preflight-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('a valid lease is reported without refreshing and its snapshot carries no refresh token', async (t) => {
  const directory = workspace(t);
  const credentialsPath = credentialsFixture(directory, {
    accessToken: 'access-live',
    refreshToken: 'refresh-secret',
    expiresAt: Date.now() + 3_600_000,
    scopes: ['user:inference'],
    subscriptionType: 'max',
  });
  const snapshotPath = join(directory, 'snapshot.json');

  const result = await preflightAnthropicOAuthCredentials({
    credentialsPath,
    snapshotPath,
    minimumValidityMs: 60_000,
  });

  assert.equal(result.refreshed, false);
  assert.equal(result.snapshotWritten, true);
  assert.ok(result.remainingMs >= 60_000);

  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  assert.equal(snapshot.claudeAiOauth.accessToken, 'access-live');
  assert.equal('refreshToken' in snapshot.claudeAiOauth, false);
  assert.equal('refresh_token' in snapshot.claudeAiOauth, false);
  assert.equal(
    JSON.parse(readFileSync(credentialsPath, 'utf8')).claudeAiOauth.refreshToken,
    'refresh-secret',
    'the host credential file keeps its own refresh token'
  );
});

test('an expiring lease is renewed only when the refreshed token is persisted', async (t) => {
  const directory = workspace(t);
  const credentialsPath = credentialsFixture(directory, {
    accessToken: 'access-stale',
    refreshToken: 'refresh-secret',
    expiresAt: Date.now() + 5_000,
    scopes: ['user:inference'],
  });

  await assert.rejects(
    () =>
      preflightAnthropicOAuthCredentials({
        credentialsPath,
        minimumValidityMs: 600_000,
        refreshFn: async () => ({ accessToken: 'access-renewed' }),
      }),
    /refresh was not persisted/
  );

  const result = await preflightAnthropicOAuthCredentials({
    credentialsPath,
    minimumValidityMs: 600_000,
    refreshFn: async () => {
      writeFileSync(
        credentialsPath,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'access-renewed',
            refreshToken: 'refresh-rotated',
            expiresAt: Date.now() + 3_600_000,
            scopes: ['user:inference'],
          },
        }),
        'utf8'
      );
      return { accessToken: 'access-renewed' };
    },
  });

  assert.equal(result.refreshed, true);
  assert.ok(result.remainingMs >= 600_000);
});

test('a container-side process refuses to run the host preflight', async (t) => {
  const directory = workspace(t);
  const credentialsPath = credentialsFixture(directory, {
    accessToken: 'access-live',
    refreshToken: 'refresh-secret',
    expiresAt: Date.now() + 3_600_000,
    scopes: ['user:inference'],
  });
  const previous = process.env[REFRESH_DISABLED_ENV];
  process.env[REFRESH_DISABLED_ENV] = '1';
  t.after(() => {
    if (previous === undefined) delete process.env[REFRESH_DISABLED_ENV];
    else process.env[REFRESH_DISABLED_ENV] = previous;
  });

  await assert.rejects(() => preflightAnthropicOAuthCredentials({ credentialsPath }), /refresh is disabled/);
});

test('a lease the provider cannot satisfy fails instead of reporting a short lease', async (t) => {
  const directory = workspace(t);
  const credentialsPath = credentialsFixture(directory, {
    accessToken: 'access-live',
    expiresAt: Date.now() + 30_000,
    scopes: ['user:inference'],
  });

  await assert.rejects(
    () => preflightAnthropicOAuthCredentials({ credentialsPath, minimumValidityMs: 600_000 }),
    /refresh token is unavailable/
  );
});
