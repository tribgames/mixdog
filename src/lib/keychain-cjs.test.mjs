import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('win32 setSecret passes the secret via stdin with a minimal env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-'));
  const realSpawnSync = childProcess.spawnSync;
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const oldData = process.env.MIXDOG_DATA_DIR;
  const oldSysRoot = process.env.SystemRoot;
  const calls = [];
  process.env.MIXDOG_DATA_DIR = dir;
  process.env.SystemRoot = process.env.SystemRoot || 'C:\\Windows';
  process.env.SOME_API_KEY = 'leaky';
  childProcess.spawnSync = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, stdout: 'Q0lQSEVS\n', stderr: '' };
  };
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const modPath = require.resolve('./keychain-cjs.cjs');
    delete require.cache[modPath];
    const keychain = require('./keychain-cjs.cjs');
    const secret = "pa'ss wörd";
    keychain.setSecret('acct', secret);
    assert.equal(calls.length, 1);
    const { args, opts } = calls[0];
    assert.ok(!args.join(' ').includes('pa'), 'secret must not be in argv');
    assert.equal(Buffer.from(opts.input, 'base64').toString('utf8'), secret);
    assert.equal(opts.env.SOME_API_KEY, undefined);
    assert.equal(fs.readFileSync(path.join(dir, 'secrets', 'acct.dpapi'), 'utf8'), 'Q0lQSEVS');
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
    childProcess.spawnSync = realSpawnSync;
    delete process.env.SOME_API_KEY;
    if (oldData === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = oldData;
    if (oldSysRoot === undefined) delete process.env.SystemRoot;
    delete require.cache[require.resolve('./keychain-cjs.cjs')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('linux setSecretAsync rejects with an install hint when secret-tool is missing, without blocking', async () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const oldPath = process.env.PATH;
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-empty-'));
  process.env.PATH = emptyDir;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    delete require.cache[require.resolve('./keychain-cjs.cjs')];
    const keychain = require('./keychain-cjs.cjs');
    let ticked = false;
    setImmediate(() => {
      ticked = true;
    });
    const pending = keychain.setSecretAsync('acct', 'v');
    assert.equal(ticked, false, 'call returns a promise instead of blocking');
    await assert.rejects(pending, /libsecret-tools/);
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
    process.env.PATH = oldPath;
    delete require.cache[require.resolve('./keychain-cjs.cjs')];
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

// Fake `secret-tool` child: `behavior(args)` returns { stdout, stderr, code } or
// { hang: true } (a locked keyring waiting on its unlock prompt) or { enoent }.
function fakeSpawn(behavior) {
  return (cmd, args) => {
    assert.equal(cmd, 'secret-tool');
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {
      child.stdout.end();
      child.stderr.end();
      child.emit('close', null);
    };
    const result = behavior(args);
    setImmediate(() => {
      if (result.enoent) return child.emit('error', Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' }));
      if (result.hang) return;
      child.stdout.end(result.stdout || '');
      child.stderr.end(result.stderr || '');
      setImmediate(() => child.emit('close', result.code ?? 0));
    });
    return child;
  };
}

async function withLinuxKeychain(behavior, env, fn) {
  const realSpawn = childProcess.spawn;
  const realSpawnSync = childProcess.spawnSync;
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  childProcess.spawn = fakeSpawn(behavior);
  childProcess.spawnSync = () => assert.fail('sync secret-tool must never run on the daemon path');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    delete require.cache[require.resolve('./keychain-cjs.cjs')];
    return await fn(require('./keychain-cjs.cjs'));
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
    childProcess.spawn = realSpawn;
    childProcess.spawnSync = realSpawnSync;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[require.resolve('./keychain-cjs.cjs')];
  }
}

test('linux: locked keyring never blocks the event loop and reports an unlock message', async () => {
  await withLinuxKeychain(() => ({ hang: true }), { MIXDOG_KEYCHAIN_PREWARM_TIMEOUT_MS: '300' }, async (keychain) => {
    const started = Date.now();
    assert.throws(() => keychain.getSecret('acct'), /keyring/i);
    assert.equal(keychain.hasSecret('acct'), false);
    assert.ok(Date.now() - started < 200, 'sync read returns immediately');
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    await keychain.prewarmSecrets();
    clearInterval(timer);
    assert.ok(ticks >= 5, `event loop kept running during the locked wait (${ticks} ticks)`);
    assert.equal(keychain.keychainStatus().state, 'locked');
    assert.match(keychain.keychainStatus().message, /Unlock your keyring/);
  });
});

test('linux: prewarm snapshot serves sync reads; absent accounts read as null; async delete clears', async () => {
  const search =
    '[/org/x/1]\nlabel = mixdog acct\nsecret = s3cret\ncreated = 2024\nschema = org.freedesktop.Secret.Generic\n' +
    'attribute.service = mixdog\nattribute.account = acct\n';
  await withLinuxKeychain(
    (args) => (args[0] === 'search' ? { stdout: search } : { code: 0 }),
    {},
    async (keychain) => {
      await keychain.prewarmSecrets();
      assert.equal(keychain.keychainStatus().state, 'ok');
      assert.equal(keychain.getSecret('acct'), 's3cret');
      assert.equal(keychain.hasSecret('acct'), true);
      assert.equal(keychain.getSecret('other'), null);
      await keychain.deleteSecretAsync('acct');
      assert.equal(keychain.getSecret('acct'), null);
      await keychain.setSecretAsync('fresh', 'v');
      assert.equal(keychain.getSecret('fresh'), 'v');
    }
  );
});

test('linux: missing secret-tool reports the libsecret-tools hint', async () => {
  await withLinuxKeychain(() => ({ enoent: true }), {}, async (keychain) => {
    await keychain.prewarmSecrets();
    assert.equal(keychain.keychainStatus().state, 'missing');
    assert.match(keychain.keychainStatus().message, /libsecret-tools/);
    assert.throws(() => keychain.getSecret('acct'), /libsecret-tools/);
    await assert.rejects(keychain.deleteSecretAsync('acct'), /libsecret-tools/);
  });
});
