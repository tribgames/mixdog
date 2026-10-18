import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  enforceOwnerOnlyAclWin32,
  enforceOwnerOnlyAclWin32Async,
  ownerOnlyAclHelperForTests,
  prewarmOwnerOnlyAclWin32,
} from './file-permissions.mjs';

const execute = promisify(childProcess.execFile);

async function aclSids(path, directory = false) {
  const quoted = path.replaceAll("'", "''");
  const { stdout } = await execute(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `[System.IO.${directory ? 'Directory' : 'File'}]::GetAccessControl('${quoted}').Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }`,
    ],
    { windowsHide: true }
  );
  return stdout.trim().split(/\r?\n/).filter(Boolean).sort();
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-existing-acl-'));
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });
  await execute('icacls.exe', [root, '/grant', '*S-1-1-0:(OI)(CI)(RX)'], { windowsHide: true });
  return root;
}

for (const directory of [false, true]) {
  test(`existing ${directory ? 'directory' : 'file'} ACL tightening removes inherited and explicit foreign grants`, {
    skip: process.platform !== 'win32' && 'Windows only',
  }, async (t) => {
    const root = await fixture(t);
    const path = join(root, 'protected');
    if (directory) await mkdir(path);
    else await writeFile(path, 'fixture');
    await execute('icacls.exe', [path, '/grant', '*S-1-5-32-545:(R)'], { windowsHide: true });
    await enforceOwnerOnlyAclWin32Async(path);
    const sids = await aclSids(path, directory);
    assert.equal(sids.includes('S-1-1-0'), false);
    assert.equal(sids.includes('S-1-5-32-545'), false);
    assert.equal(sids.length, 1);
  });
}

test('failed ACL tightening cannot restore broad parent permissions on a protected secret', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async (t) => {
  const root = await fixture(t);
  const path = join(root, 'protected');
  await writeFile(path, 'fixture');
  await enforceOwnerOnlyAclWin32Async(path, { fresh: true });
  const before = await aclSids(path);
  const executeSync = childProcess.execFileSync;
  t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    // Fail the permission-setting operation, but allow any preceding reset to
    // reach the filesystem so an unsafe multi-step implementation is observable.
    if (String(file).endsWith('whoami.exe') || args.includes('/reset')) {
      return executeSync(file, args, options);
    }
    throw new Error('injected ACL update failure');
  });
  syncBuiltinESMExports();
  assert.throws(() => enforceOwnerOnlyAclWin32(path), { code: 'EACLFAIL' });
  assert.deepEqual(await aclSids(path), before);
});

/** Counts the PowerShell processes the module starts (helper or one-shot update). */
function countPowerShell(t) {
  const { execFile, spawn } = childProcess;
  const counter = { spawned: 0, oneShot: 0 };
  const isPowerShell = (file) => String(file).toLowerCase().endsWith('powershell.exe');
  t.mock.method(childProcess, 'execFile', (file, ...rest) => {
    if (isPowerShell(file)) counter.oneShot += 1;
    return execFile(file, ...rest);
  });
  t.mock.method(childProcess, 'spawn', (file, ...rest) => {
    if (isPowerShell(file)) counter.spawned += 1;
    return spawn(file, ...rest);
  });
  syncBuiltinESMExports();
  return counter;
}

async function killHelper() {
  const child = ownerOnlyAclHelperForTests();
  if (!child) return;
  child.ref();
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

const widen = (path) => execute('icacls.exe', [path, '/grant', '*S-1-5-32-545:(R)'], { windowsHide: true });

test('every read verifies the real DACL through one shared helper, catching a widening right after enforcement', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async (t) => {
  const root = await fixture(t);
  const path = join(root, 'token');
  await writeFile(path, 'secret');
  await enforceOwnerOnlyAclWin32Async(path);
  const processes = countPowerShell(t);

  await Promise.all([enforceOwnerOnlyAclWin32Async(path), enforceOwnerOnlyAclWin32Async(path)]);
  for (let i = 0; i < 5; i += 1) await enforceOwnerOnlyAclWin32Async(path);
  // Widen with metadata restored so that nothing but the DACL itself differs.
  await enforceOwnerOnlyAclWin32Async(path);
  const before = await stat(path);
  await widen(path);
  await utimes(path, before.atime, before.mtime);
  assert.equal((await aclSids(path)).includes('S-1-5-32-545'), true);
  await enforceOwnerOnlyAclWin32Async(path);
  assert.deepEqual(processes, { spawned: 0, oneShot: 0 }, 'reads reuse the helper');
  const sids = await aclSids(path);
  assert.equal(sids.includes('S-1-5-32-545'), false);
  assert.equal(sids.length, 1);
});

test('a helper crashing mid-request falls back to a one-shot update, and a later read restarts it', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async (t) => {
  const root = await fixture(t);
  const path = join(root, 'token');
  await writeFile(path, 'secret');
  await enforceOwnerOnlyAclWin32Async(path);
  const processes = countPowerShell(t);
  await widen(path);
  const helper = ownerOnlyAclHelperForTests();
  helper.ref();
  const exited = once(helper, 'exit');
  const pending = enforceOwnerOnlyAclWin32Async(path);
  // The request is queued synchronously; kill before the helper can answer.
  helper.kill();
  await exited;
  await pending;
  assert.deepEqual(await aclSids(path).then((sids) => sids.includes('S-1-5-32-545')), false);
  assert.equal(processes.oneShot, 1);

  await widen(path);
  await enforceOwnerOnlyAclWin32Async(path);
  assert.equal(processes.spawned, 1, 'the next read starts a new helper');
  assert.equal((await aclSids(path)).length, 1);
});

test('a synchronous fresh-file ACL goes through the bridge helper: no process spawned, the loop held briefly', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async (t) => {
  const root = await fixture(t);
  await prewarmOwnerOnlyAclWin32();
  const first = join(root, 'first');
  await writeFile(first, 'secret');
  // Waits (once) for the bridge worker and its helper to come up.
  enforceOwnerOnlyAclWin32(first, { fresh: true });
  const spawned = { count: 0 };
  for (const name of ['execFileSync', 'execFile', 'spawn', 'spawnSync']) {
    const original = childProcess[name];
    t.mock.method(childProcess, name, (...args) => {
      spawned.count += 1;
      return original(...args);
    });
  }
  syncBuiltinESMExports();
  const paths = [];
  for (let i = 0; i < 5; i += 1) {
    const path = join(root, `fresh-${i}`);
    await writeFile(path, 'secret');
    await widen(path);
    paths.push(path);
  }
  const startedAt = performance.now();
  for (const path of paths) enforceOwnerOnlyAclWin32(path, { fresh: true });
  const elapsedMs = performance.now() - startedAt;
  assert.equal(spawned.count, 0, 'no process started on this thread');
  assert.ok(elapsedMs < 2_000, `five synchronous ACL updates held the loop ${Math.round(elapsedMs)}ms`);
  t.mock.restoreAll();
  syncBuiltinESMExports();
  for (const path of paths) {
    const sids = await aclSids(path);
    assert.equal(sids.includes('S-1-5-32-545'), false);
    assert.equal(sids.length, 1);
  }
});

test('a helper that cannot start falls back to a one-shot update per call', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async (t) => {
  const root = await fixture(t);
  const path = join(root, 'token');
  await writeFile(path, 'secret');
  await killHelper();
  const processes = countPowerShell(t);
  const { spawn } = childProcess;
  t.mock.method(childProcess, 'spawn', (_file, ...rest) => spawn(join(root, 'missing-powershell.exe'), ...rest));
  syncBuiltinESMExports();
  await widen(path);
  await enforceOwnerOnlyAclWin32Async(path);
  await widen(path);
  await enforceOwnerOnlyAclWin32Async(path);
  assert.equal(processes.oneShot, 2);
  assert.equal((await aclSids(path)).length, 1);
});
