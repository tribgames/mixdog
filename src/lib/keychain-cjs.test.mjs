import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
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
