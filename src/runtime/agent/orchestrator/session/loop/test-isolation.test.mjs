import './test-isolation.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { dirname } from 'node:path';
import test from 'node:test';
import tls from 'node:tls';

test('session isolation installs temporary roots and in-memory credentials before application imports', async () => {
  const keys = [
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'MIXDOG_HOME',
    'MIXDOG_DATA_DIR',
    'MIXDOG_CONFIG_DIR',
    'MIXDOG_RUNTIME_ROOT',
  ];
  const root = dirname(process.env.HOME);
  for (const key of keys) {
    assert.equal(dirname(process.env[key]), root);
    assert.ok(existsSync(process.env[key]));
  }
  const { default: keychain } = await import('../../../../../lib/keychain-cjs.cjs');
  assert.equal(keychain.getSecret('session-isolation-fixture'), null);
  keychain.setSecret('session-isolation-fixture', 'synthetic-secret');
  assert.equal(keychain.getSecret('session-isolation-fixture'), 'synthetic-secret');
  keychain.deleteSecret('session-isolation-fixture');
  assert.equal(keychain.hasSecret('session-isolation-fixture'), false);

  const { getPluginData } = await import('../../config.mjs');
  assert.equal(getPluginData(), process.env.MIXDOG_DATA_DIR);
  await import('../store.mjs');
});

test('external provider transports and database connections fail closed', async () => {
  for (const request of [fetch, http.request, https.request, net.connect, tls.connect]) {
    assert.throws(() => request('https://example.invalid'), /external provider or database access/);
  }
  const { Client, Pool } = await import('pg');
  for (const database of [new Client(), new Pool()]) {
    assert.throws(() => database.connect(), /external database access/);
    assert.throws(() => database.query('select 1'), /external database access/);
  }
});
