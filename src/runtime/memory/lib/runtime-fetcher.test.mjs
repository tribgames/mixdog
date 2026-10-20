import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { _runtimeLayoutInternals } from './runtime-fetcher.mjs';

const {
  acquireStagingLock,
  cachedRuntimeDir,
  discardRuntimeDir,
  gcRuntimeDir,
  publishRuntimeDir,
  releaseStagingLock,
  runtimeInstallKey,
} = _runtimeLayoutInternals;
const VERSION = 'pg16.4+pgvector-0.8.2';
const OLD_SHA = 'a'.repeat(64);
const NEW_SHA = 'b'.repeat(64);
const POSTGRES = process.platform === 'win32' ? 'postgres.exe' : 'postgres';

function runtimeBase(t) {
  const base = mkdtempSync(join(tmpdir(), 'mixdog-runtime-layout-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

function installed(base, key, sha) {
  const dir = join(base, `runtime-${key}`);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(join(dir, 'share'), { recursive: true });
  writeFileSync(join(dir, 'share', 'errcodes.txt'), 'x');
  writeFileSync(join(dir, '.version-sha256'), sha);
  return dir;
}

test('the active pointer accepts bare-version installs and digest-keyed installs with a matching stamp', (t) => {
  const base = runtimeBase(t);
  const legacy = installed(base, VERSION, OLD_SHA);
  writeFileSync(join(base, 'active-version'), VERSION);
  assert.equal(cachedRuntimeDir(base, VERSION, OLD_SHA), legacy);
  assert.equal(cachedRuntimeDir(base, VERSION, NEW_SHA), null);

  const key = runtimeInstallKey(VERSION, NEW_SHA);
  assert.equal(key, `${VERSION}-bbbbbbbbbbbb`);
  const keyed = installed(base, key, NEW_SHA);
  writeFileSync(join(base, 'active-version'), key);
  assert.equal(cachedRuntimeDir(base, VERSION, NEW_SHA), keyed);
});

test('gc removes inactive runtimes and tarballs whole and keeps the active one', (t) => {
  const base = runtimeBase(t);
  const active = runtimeInstallKey(VERSION, NEW_SHA);
  installed(base, VERSION, OLD_SHA);
  installed(base, active, NEW_SHA);
  writeFileSync(join(base, 'runtime-win32-x64-1-2-abc.tar.gz'), 'partial');
  gcRuntimeDir(base, active);
  assert.deepEqual(readdirSync(base).sort(), [`runtime-${active}`]);
});

test("gc keeps a sibling's in-flight download and reaps it once its lock is gone", (t) => {
  const base = runtimeBase(t);
  const stagingDir = join(base, 'staging-1-2-abc');
  const lock = acquireStagingLock(stagingDir);
  writeFileSync(`${stagingDir}.tar.gz`, 'partial');
  gcRuntimeDir(base, VERSION);
  assert.equal(existsSync(`${stagingDir}.tar.gz`), true);
  releaseStagingLock(lock);
  gcRuntimeDir(base, VERSION);
  assert.equal(existsSync(`${stagingDir}.tar.gz`), false);
});

test('publishing reuses a racing sibling install of the same asset and replaces an unstamped leftover', (t) => {
  const base = runtimeBase(t);
  const key = runtimeInstallKey(VERSION, NEW_SHA);
  const sibling = installed(base, key, NEW_SHA);
  writeFileSync(join(sibling, 'share', 'sibling.txt'), 'published first');
  const staging = installed(base, 'staging-mine', NEW_SHA);
  assert.equal(publishRuntimeDir(base, staging, key, NEW_SHA), sibling);
  assert.equal(existsSync(join(sibling, 'share', 'sibling.txt')), true);
  assert.equal(existsSync(staging), false);
  assert.equal(cachedRuntimeDir(base, VERSION, NEW_SHA), sibling);

  rmSync(join(sibling, '.version-sha256'));
  const next = installed(base, 'staging-next', NEW_SHA);
  publishRuntimeDir(base, next, key, NEW_SHA);
  assert.equal(existsSync(join(sibling, 'share', 'sibling.txt')), false);
  assert.equal(cachedRuntimeDir(base, VERSION, NEW_SHA), sibling);
});

test('a runtime whose postgres is running is never removed, stamp included', {
  skip: process.platform === 'darwin' && 'not run on macOS',
}, async (t) => {
  const base = runtimeBase(t);
  const dir = installed(base, VERSION, OLD_SHA);
  copyFileSync(process.execPath, join(dir, 'bin', POSTGRES));
  const child = spawn(join(dir, 'bin', POSTGRES), ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(async () => {
    child.kill();
    await exited;
  });
  await new Promise((resolve) => child.once('spawn', resolve));

  assert.throws(() => discardRuntimeDir(base, dir), /runtime dir is in use/);
  gcRuntimeDir(base, runtimeInstallKey(VERSION, NEW_SHA));
  assert.equal(existsSync(join(dir, '.version-sha256')), true);
  assert.equal(existsSync(join(dir, 'share', 'errcodes.txt')), true);

  child.kill();
  await exited;
  gcRuntimeDir(base, runtimeInstallKey(VERSION, NEW_SHA));
  assert.equal(existsSync(dir), false);
});

test('a runtime whose postgres executable is NUL-filled is not reused', (t) => {
  const base = runtimeBase(t);
  const dir = installed(base, VERSION, OLD_SHA);
  writeFileSync(join(base, 'active-version'), VERSION);
  writeFileSync(join(dir, 'bin', POSTGRES), 'binary');
  assert.equal(cachedRuntimeDir(base, VERSION, OLD_SHA), dir);
  writeFileSync(join(dir, 'bin', POSTGRES), Buffer.alloc(64));
  assert.equal(cachedRuntimeDir(base, VERSION, OLD_SHA), null);
});
