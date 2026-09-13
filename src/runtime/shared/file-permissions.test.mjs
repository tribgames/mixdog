import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  enforceOwnerOnlyAclWin32,
  enforceOwnerOnlyAclWin32Async,
} from './file-permissions.mjs';

const execute = promisify(childProcess.execFile);

async function aclSids(path, directory = false) {
  const quoted = path.replaceAll("'", "''");
  const { stdout } = await execute('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `[System.IO.${directory ? 'Directory' : 'File'}]::GetAccessControl('${quoted}').Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }`,
  ], { windowsHide: true });
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
    skip: process.platform !== 'win32',
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
  skip: process.platform !== 'win32',
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
