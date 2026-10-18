import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { readSecretFile, writeSecretFile } from './secret-file.ts';

const execute = promisify(childProcess.execFile);

test('repeated secret reads verify the ACL without spawning a process; a widened ACL is tightened', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-secret-read-'));
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  });
  const path = join(root, 'credential');
  await writeSecretFile(path, 'first');
  assert.equal(await readSecretFile(path), 'first');
  const { execFile, spawn } = childProcess;
  let spawned = 0;
  t.mock.method(childProcess, 'execFile', (file, ...rest) => {
    spawned += 1;
    return execFile(file, ...rest);
  });
  t.mock.method(childProcess, 'spawn', (file, ...rest) => {
    spawned += 1;
    return spawn(file, ...rest);
  });
  syncBuiltinESMExports();

  for (let i = 0; i < 10; i += 1) assert.equal(await readSecretFile(path), 'first');
  await writeSecretFile(path, 'second');
  const afterWrite = spawned;
  await execute('icacls.exe', [path, '/grant', '*S-1-5-32-545:(R)'], { windowsHide: true });
  assert.equal(await readSecretFile(path), 'second');
  assert.equal(spawned, afterWrite, 'reads after a write spawn no process either');
  const { stdout } = await execute('icacls.exe', [path], { windowsHide: true });
  assert.equal(stdout.includes('S-1-5-32-545') || /BUILTIN\\Users/i.test(stdout), false);
});
