import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyUpdateMetadata } from './verify-update-metadata.mjs';

const validMetadata = [
  'provider: github',
  'owner: tribgames',
  'repo: mixdog',
  'updaterCacheDirName: mixdog-desktop-updater',
  '',
].join('\n');

async function withDist(run) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-update-metadata-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('packaged updater metadata accepts every platform resource layout', async () => {
  await withDist(async (root) => {
    const paths = [
      join(root, 'win-unpacked', 'resources'),
      join(root, 'mac-arm64', 'Mixdog.app', 'Contents', 'Resources'),
      join(root, 'linux-unpacked', 'resources'),
    ];
    for (const directory of paths) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'app-update.yml'), validMetadata);
    }
    const files = await verifyUpdateMetadata(root);
    assert.equal(files.length, paths.length);
  });
});

test('packaged updater metadata fails closed when absent or misrouted', async () => {
  await withDist(async (root) => {
    await assert.rejects(() => verifyUpdateMetadata(root), /metadata is missing/);
    const resources = join(root, 'win-unpacked', 'resources');
    await mkdir(resources, { recursive: true });
    await writeFile(join(resources, 'app-update.yml'), validMetadata.replace('repo: mixdog', 'repo: other'));
    await assert.rejects(() => verifyUpdateMetadata(root), /does not declare repo: mixdog/);
  });
});
