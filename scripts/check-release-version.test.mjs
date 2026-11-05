import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { checkReleaseVersion } from './check-release-version.mjs';

async function tree({ root, desktop, cargo }) {
  const dir = await mkdtemp(join(tmpdir(), 'release-version-'));
  await mkdir(join(dir, 'apps/desktop'), { recursive: true });
  await mkdir(join(dir, 'native/core'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ version: root }));
  await writeFile(join(dir, 'apps/desktop/package.json'), JSON.stringify({ version: desktop }));
  await writeFile(join(dir, 'native/core/Cargo.toml'), `[workspace]\n\n[workspace.package]\nversion = "${cargo}"\nedition = "2024"\n`);
  return dir;
}

test('equal versions pass and return the release version', async () => {
  assert.equal(await checkReleaseVersion(await tree({ root: '1.4.6', desktop: '1.4.6', cargo: '1.4.6' })), '1.4.6');
});

test('a diverged desktop or crate version names where it differs', async () => {
  await assert.rejects(
    checkReleaseVersion(await tree({ root: '1.4.6', desktop: '1.4.5', cargo: '0.0.0' })),
    /apps\/desktop\/package\.json is 1\.4\.5; native\/core\/Cargo\.toml \[workspace\.package\] is 0\.0\.0/,
  );
});

test('the repository itself is consistent', async () => {
  await checkReleaseVersion();
});
