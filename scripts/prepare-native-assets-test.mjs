import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { NATIVE_ASSET_PLATFORMS, prepareRequiredNativeAssets } from './prepare-native-assets.mjs';
import { NATIVE_TOOL_FILENAMES, packageNativeToolsDir } from '../src/runtime/shared/native-tool-paths.mjs';

test('native asset host platforms share the published native-tool keys', () => {
  assert.deepEqual(
    [...NATIVE_ASSET_PLATFORMS],
    ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']
  );
});

test('npm postinstall prepares every required release-native asset', async () => {
  const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  assert.equal(
    pkg.scripts.postinstall,
    'node scripts/prune-embedding-runtime.mjs && node scripts/prepare-native-assets.mjs'
  );

  const root = await mkdtemp(join(tmpdir(), 'mixdog-native-install-test-'));
  try {
    const calls = [];
    const installers = Object.fromEntries(
      Object.keys(NATIVE_TOOL_FILENAMES).map((name) => [
        name,
        async (dataDir) => {
          calls.push([name, dataDir]);
          const source = join(root, `${name}.source`);
          await writeFile(source, `${name}-fixture`);
          return source;
        },
      ])
    );
    const prepared = await prepareRequiredNativeAssets({ packageRoot: root, installers });
    assert.deepEqual(Object.keys(prepared), ['graph', 'patch', 'spawn']);
    assert.deepEqual(
      calls.map(([name]) => name),
      ['graph', 'patch', 'spawn']
    );
    assert.equal(new Set(calls.map(([, dataDir]) => dataDir)).size, 1);
    for (const [name, fileName] of Object.entries(NATIVE_TOOL_FILENAMES)) {
      assert.equal(await readFile(join(packageNativeToolsDir(root), fileName), 'utf8'), `${name}-fixture`);
      assert.equal(prepared[name], join(packageNativeToolsDir(root), fileName));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows on ARM prepares the native assets it runs under x64 emulation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-native-install-arm64-'));
  try {
    const installers = Object.fromEntries(
      Object.keys(NATIVE_TOOL_FILENAMES).map((name) => [
        name,
        async () => {
          const source = join(root, `${name}.source`);
          await writeFile(source, `${name}-fixture`);
          return source;
        },
      ])
    );
    const prepared = await prepareRequiredNativeAssets({ packageRoot: root, platform: 'win32', arch: 'arm64', installers });
    assert.deepEqual(Object.keys(prepared), ['graph', 'patch', 'spawn']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unsupported host platforms fail closed before downloading native assets', async () => {
  await assert.rejects(
    prepareRequiredNativeAssets({
      packageRoot: join(tmpdir(), 'mixdog-native-unsupported-'),
      platform: 'freebsd',
      arch: 'x64',
      installers: {
        graph: async () => {
          throw new Error('should not download');
        },
        patch: async () => {
          throw new Error('should not download');
        },
        spawn: async () => {
          throw new Error('should not download');
        },
      },
    }),
    /not published for freebsd-x64/
  );
});

test('a required native asset failure rejects the complete install step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-native-install-failure-'));
  try {
    const target = packageNativeToolsDir(root);
    await writeFile(join(root, 'existing'), 'existing');
    await assert.rejects(
      prepareRequiredNativeAssets({
        packageRoot: root,
        installers: {
          graph: async () => join(root, 'existing'),
          patch: async () => {
            throw new Error('release unavailable');
          },
          spawn: async () => join(root, 'existing'),
        },
      }),
      /release unavailable/
    );
    await assert.rejects(readFile(target), /ENOENT|EISDIR/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
