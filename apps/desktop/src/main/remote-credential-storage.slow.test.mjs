import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { loadOrCreatePairingToken } from './remote-pairing-token.ts';
import { loadOrCreateRelayE2EEIdentity } from './remote-e2ee.ts';
import { readSecretFile, writeSecretFile } from './secret-file.ts';

const execute = promisify(execFile);

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-remote-credential-'));
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

for (const [name, create] of [
  ['pairing token', loadOrCreatePairingToken],
  ['E2EE identity', loadOrCreateRelayE2EEIdentity],
]) {
  test(`concurrent ${name} initialization returns one persisted identity`, async (t) => {
    const root = await fixture(t);
    const values = await Promise.all([create(root), create(root), create(root)]);
    assert.equal(new Set(values.map((value) => JSON.stringify(value))).size, 1);
    assert.equal(JSON.stringify(await create(root)), JSON.stringify(values[0]));
  });
}

test('an unreadable pairing token is not silently replaced', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'remote-bridge.token');
  const token = 'ab'.repeat(24);
  await fs.writeFile(path, token);
  const read = fs.readFile;
  const failure = Object.assign(new Error('credential disk read failed'), { code: 'EIO' });
  t.mock.method(fs, 'readFile', async (target, ...args) => {
    if (target === path) throw failure;
    return read(target, ...args);
  });
  syncBuiltinESMExports();
  await assert.rejects(loadOrCreatePairingToken(root), (error) => error === failure);
  assert.equal(await read(path, 'utf8'), token);
});

test('secret writes preserve exact bytes and recover after a rejected predecessor', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'credential');
  await fs.mkdir(path);
  await assert.rejects(writeSecretFile(path, 'rejected'));
  await fs.rmdir(path);
  await Promise.all([writeSecretFile(path, 'first'), writeSecretFile(path, 'last\n')]);
  assert.equal(await readSecretFile(path), 'last\n');
});

for (const existing of [false, true]) {
  test(`Windows ${existing ? 'existing credential read' : 'credential publication'} removes broad read grants`, {
    skip: process.platform !== 'win32',
  }, async (t) => {
    const root = await fixture(t);
    const path = join(root, 'credential');
    await execute('icacls.exe', [root, '/grant', '*S-1-1-0:(OI)(CI)(RX)'], { windowsHide: true });
    if (existing) {
      await fs.writeFile(path, 'fixture secret');
      assert.equal(await readSecretFile(path), 'fixture secret');
    } else {
      await writeSecretFile(path, 'fixture secret');
    }
    const quoted = path.replaceAll("'", "''");
    const { stdout } = await execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[System.IO.File]::GetAccessControl('${quoted}').Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }`,
      ],
      { windowsHide: true }
    );
    assert.equal(stdout.split(/\r?\n/).includes('S-1-1-0'), false);
  });
}
