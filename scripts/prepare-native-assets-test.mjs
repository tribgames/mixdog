import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { prepareRequiredNativeAssets } from './prepare-native-assets.mjs';
import {
  NATIVE_TOOL_FILENAMES,
  packageNativeToolsDir,
} from '../src/runtime/shared/native-tool-paths.mjs';

test('npm postinstall prepares every required release-native asset', async () => {
  const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  assert.equal(
    pkg.scripts.postinstall,
    'node scripts/prune-embedding-runtime.mjs && node scripts/prepare-native-assets.mjs',
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
      ]),
    );
    const prepared = await prepareRequiredNativeAssets({ packageRoot: root, installers });
    assert.deepEqual(Object.keys(prepared), ['graph', 'patch', 'spawn', 'token']);
    assert.deepEqual(calls.map(([name]) => name), ['graph', 'patch', 'spawn', 'token']);
    assert.equal(new Set(calls.map(([, dataDir]) => dataDir)).size, 1);
    for (const [name, fileName] of Object.entries(NATIVE_TOOL_FILENAMES)) {
      assert.equal(await readFile(join(packageNativeToolsDir(root), fileName), 'utf8'), `${name}-fixture`);
      assert.equal(prepared[name], join(packageNativeToolsDir(root), fileName));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
          patch: async () => { throw new Error('release unavailable'); },
          spawn: async () => join(root, 'existing'),
          token: async () => join(root, 'existing'),
        },
      }),
      /release unavailable/,
    );
    await assert.rejects(readFile(target), /ENOENT|EISDIR/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
