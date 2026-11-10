import assert from 'node:assert/strict';
import * as realChildProcess from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

import * as realBoundedDownload from '../../shared/bounded-download.mjs';
import * as realNativeAsset from '../../shared/native-asset.mjs';

// A first boot installs the PG runtime (tar probe, list, detail list,
// extract) inside the daemon process: none of it may use a synchronous child.
const syncCalls = [];
const forbidSync =
  (name) =>
  (...args) => {
    syncCalls.push([name, ...args]);
    throw new Error(`${name} on the runtime install path`);
  };
const spawnedCommands = [];
const { default: _childProcessDefault, ...childProcessNamed } = realChildProcess;
mock.module('node:child_process', {
  namedExports: {
    ...childProcessNamed,
    spawn: (file, args, options) => {
      spawnedCommands.push([file, ...args].join(' '));
      return realChildProcess.spawn(file, args, options);
    },
    spawnSync: forbidSync('spawnSync'),
    execFileSync: forbidSync('execFileSync'),
    execSync: forbidSync('execSync'),
  },
});

const root = mkdtempSync(join(tmpdir(), 'mixdog-runtime-async-'));
const archivePath = join(root, 'runtime.tar.gz');
const exe = process.platform === 'win32' ? 'postgres.exe' : 'postgres';
{
  const source = join(root, 'source');
  mkdirSync(join(source, 'bin'), { recursive: true });
  mkdirSync(join(source, 'share'), { recursive: true });
  writeFileSync(join(source, 'bin', exe), 'fake postgres');
  writeFileSync(join(source, 'share', 'postgres.bki'), 'bki');
  const created = realChildProcess.spawnSync('tar', ['-czf', 'runtime.tar.gz', '-C', 'source', '.'], {
    cwd: root,
    stdio: 'pipe',
    windowsHide: true,
  });
  assert.equal(created.status, 0, created.stderr?.toString());
}

// The release download is a local copy, and its digest check passes: the
// subject is the child-process path, not the network or the manifest digest.
mock.module('../../shared/bounded-download.mjs', {
  namedExports: {
    ...realBoundedDownload,
    downloadToFileWithRetry: async (_url, destPath) => copyFileSync(archivePath, destPath),
  },
});
mock.module('../../shared/native-asset.mjs', {
  namedExports: { ...realNativeAsset, verifySha256File: async () => {} },
});

const { ensureRuntime } = await import('./runtime-fetcher.mjs');

test.after(() => rmSync(root, { recursive: true, force: true }));

test('first-boot runtime install runs tar as async children only', async () => {
  const dataDir = join(root, 'data');
  const runtime = await ensureRuntime(dataDir);
  assert.equal(readFileSync(join(runtime.runtimeDir, 'bin', exe), 'utf8'), 'fake postgres');
  assert.equal(existsSync(join(runtime.sharePath, 'postgres.bki')), true);
  assert.deepEqual(syncCalls, [], 'no synchronous child on the install path');
  assert.deepEqual(
    spawnedCommands.map((command) => command.split(' ').slice(0, 2).join(' ')),
    ['tar --version', 'tar -tzf', 'tar -tvzf', 'tar -xzf']
  );
});
