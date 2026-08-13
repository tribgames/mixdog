import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DESKTOP_CAPABILITIES } from '../shared/contract';
import { desktopPermissionAllowed } from './permission-policy';
import {
  REMOTE_BLOCKED_CAPABILITIES,
  assertRemoteCapability,
} from './remote-methods';
import {
  MAX_ACTIVE_REMOTE_CLIENTS,
  MAX_PENDING_REMOTE_FRAME_BYTES,
  MAX_PENDING_REMOTE_FRAMES,
  relayDeviceSocketOptions,
  remoteFrameBudgetAvailable,
  resolveRelayUrl,
} from './remote-relay';
import {
  parseSelectedFileGrants,
  selectedFileGrantKey,
  serializeSelectedFileGrants,
} from './selected-file-grants';
import { writeSecretFile } from './secret-file';

const SENSITIVE_REMOTE_CAPABILITIES = new Set([
  'saveProviderApiKey',
  'authenticateProvider',
  'saveOpenAIUsageSessionKey',
  'saveOpenCodeGoUsageAuth',
  'saveDiscordToken',
  'saveTelegramToken',
  'loginOAuthProvider',
  'beginOAuthProviderLogin',
  'getOAuthProviderLoginStatus',
  'completeOAuthProviderLogin',
  'cancelOAuthProviderLogin',
  'loginOpenCodeGoUsage',
  'resolveMediaFile',
]);

test('desktop permission policy preserves media and rejects every other permission', () => {
  const trusted = {};
  assert.equal(desktopPermissionAllowed('media', trusted, trusted), true);
  assert.equal(desktopPermissionAllowed('media', {}, trusted), false);
  assert.equal(desktopPermissionAllowed('clipboard-read', trusted, trusted), false);
  assert.equal(desktopPermissionAllowed('geolocation', trusted, trusted), false);
});

test('remote capability denylist preserves existing non-secret capabilities', () => {
  assert.deepEqual(
    [...REMOTE_BLOCKED_CAPABILITIES].sort(),
    [...SENSITIVE_REMOTE_CAPABILITIES].sort(),
  );
  for (const capability of DESKTOP_CAPABILITIES) {
    if (SENSITIVE_REMOTE_CAPABILITIES.has(capability)) {
      assert.throws(() => assertRemoteCapability(capability), /not available over remote access/);
    } else {
      assert.doesNotThrow(() => assertRemoteCapability(capability));
    }
  }
});

test('relay URL policy requires encryption except for loopback development', () => {
  assert.match(resolveRelayUrl({}) || '', /^wss:\/\//);
  assert.equal(resolveRelayUrl({ MIXDOG_RELAY_URL: 'off' }), null);
  assert.equal(resolveRelayUrl({ MIXDOG_RELAY_URL: 'ws://127.0.0.1:9800' }), 'ws://127.0.0.1:9800/');
  assert.throws(
    () => resolveRelayUrl({ MIXDOG_RELAY_URL: 'ws://relay.example' }),
    /must use wss/,
  );
});

test('desktop relay credentials use an authorization header, not the URL', () => {
  const connection = relayDeviceSocketOptions('wss://relay.example', {
    deviceId: 'device-id',
    deviceSecret: 'device-secret-value',
  });
  const url = new URL(connection.url);
  assert.equal(url.pathname, '/desktop');
  assert.equal(url.search, '');
  assert.equal(
    Buffer.from(connection.headers.Authorization.slice('Basic '.length), 'base64').toString('utf8'),
    'device-id:device-secret-value',
  );
});

test('remote client and frame budgets retain normal traffic and bound floods', () => {
  assert.equal(MAX_ACTIVE_REMOTE_CLIENTS, 32);
  assert.equal(remoteFrameBudgetAvailable(0, 0, 1024), true);
  assert.equal(remoteFrameBudgetAvailable(MAX_PENDING_REMOTE_FRAMES, 0, 1), false);
  assert.equal(remoteFrameBudgetAvailable(0, MAX_PENDING_REMOTE_FRAME_BYTES, 1), false);
});

test('selected-file grant storage migrates plaintext tokens to hashes', () => {
  const token = 'legacy-selected-file-token';
  const parsed = parseSelectedFileGrants(JSON.stringify([
    { token, file: process.cwd() },
  ]));
  assert.equal(parsed.migrated, true);
  assert.equal(parsed.grants.get(selectedFileGrantKey(token)), process.cwd());
  const serialized = serializeSelectedFileGrants(parsed.grants);
  assert.doesNotMatch(serialized, new RegExp(token));
  assert.match(serialized, /"tokenHash":"[0-9a-f]{64}"/);
});

test('secret files are atomically replaced owner-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-secret-file-'));
  const file = join(dir, 'secret.json');
  await Promise.all([
    writeSecretFile(file, '{"value":"first"}'),
    writeSecretFile(file, '{"value":"second"}'),
  ]);
  assert.match(readFileSync(file, 'utf8'), /^\{"value":"(?:first|second)"\}$/);
  assert.deepEqual(readdirSync(dir), ['secret.json']);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});
