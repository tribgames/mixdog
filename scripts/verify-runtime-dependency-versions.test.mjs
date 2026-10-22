import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { finished } from 'node:stream/promises';

import {
  compareDesktopPtyVersion,
  compareShippedVersions,
  desktopRequire,
  lockKeyForPackageJson,
  readArchivePackages,
  readSidecarPackages,
  verifyRuntimeDependencyVersions,
} from './verify-runtime-dependency-versions.mjs';

let asar = null;
let asarSkipReason = false;
try {
  asar = desktopRequire('@electron/asar');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND') throw error;
  asarSkipReason = '@electron/asar is not installed in apps/desktop (run npm ci there)';
}

test('lockKeyForPackageJson maps installed package manifests to lock keys', () => {
  assert.equal(lockKeyForPackageJson('/node_modules/zod/package.json'), 'node_modules/zod');
  assert.equal(lockKeyForPackageJson('node_modules\\@scope\\pkg\\package.json'), 'node_modules/@scope/pkg');
  assert.equal(
    lockKeyForPackageJson('/node_modules/a/node_modules/@s/b/package.json'),
    'node_modules/a/node_modules/@s/b'
  );
  assert.equal(lockKeyForPackageJson('/package.json'), null);
  assert.equal(lockKeyForPackageJson('/node_modules/zod/dist/package.json'), null);
  assert.equal(lockKeyForPackageJson('/node_modules/mixdog/src/defaults/skills/x/package.json'), null);
  assert.equal(lockKeyForPackageJson('/node_modules/zod/README.md'), null);
});

const lockPackages = {
  '': { name: 'mixdog', version: '1.3.2' },
  'node_modules/zod': { version: '3.25.76' },
  'node_modules/@scope/pkg': { version: '2.0.0' },
  'node_modules/a/node_modules/zod': { version: '3.0.0' },
};

test('compareShippedVersions accepts a runtime that matches the lockfile', () => {
  const shipped = [
    { key: 'node_modules/zod', version: '3.25.76', source: 'runtime.asar' },
    { key: 'node_modules/@scope/pkg', version: '2.0.0', source: 'runtime.asar.unpacked' },
    { key: 'node_modules/a/node_modules/zod', version: '3.0.0', source: 'runtime.asar' },
    { key: 'node_modules/mixdog', version: '1.3.2', source: 'runtime.asar' },
  ];
  assert.deepEqual(compareShippedVersions({ lockPackages, shipped }), []);
});

test('compareShippedVersions lists every drifted, unlocked and stale-root package', () => {
  const shipped = [
    { key: 'node_modules/zod', version: '3.25.0', source: 'runtime.asar' },
    { key: 'node_modules/@scope/pkg', version: '1.0.0', source: 'runtime.asar.unpacked' },
    { key: 'node_modules/extra', version: '1.0.0', source: 'runtime.asar' },
    { key: 'node_modules/mixdog', version: '1.3.1', source: 'runtime.asar' },
  ];
  const mismatches = compareShippedVersions({ lockPackages, shipped });
  assert.equal(mismatches.length, 4);
  assert.match(mismatches[0], /node_modules\/zod: shipped 3\.25\.0, lockfile 3\.25\.76 \(runtime\.asar\)/);
  assert.match(mismatches[1], /@scope\/pkg: shipped 1\.0\.0, lockfile 2\.0\.0 \(runtime\.asar\.unpacked\)/);
  assert.match(mismatches[2], /node_modules\/extra: .*absent from the lockfile/);
  assert.match(mismatches[3], /node_modules\/mixdog: shipped 1\.3\.1, lockfile 1\.3\.2/);
});

test('compareDesktopPtyVersion checks the shipped node-pty against the desktop lockfile', () => {
  const desktopLockPackages = {
    'node_modules/@homebridge/node-pty-prebuilt-multiarch': { version: '0.13.1' },
  };
  assert.deepEqual(compareDesktopPtyVersion({ desktopLockPackages, shippedVersion: '0.13.1', source: 's' }), []);
  const stale = compareDesktopPtyVersion({ desktopLockPackages, shippedVersion: '0.12.0', source: 's' });
  assert.equal(stale.length, 1);
  assert.match(stale[0], /shipped 0\.12\.0, desktop lockfile 0\.13\.1/);
  assert.equal(compareDesktopPtyVersion({ desktopLockPackages: {}, shippedVersion: '0.13.1', source: 's' }).length, 1);
});

test('readSidecarPackages reads versions from an unpacked sidecar tree', async () => {
  const sidecar = await mkdtemp(join(tmpdir(), 'sidecar-'));
  try {
    await mkdir(join(sidecar, 'node_modules', '@scope', 'pkg', 'bin'), { recursive: true });
    await writeFile(join(sidecar, 'node_modules', '@scope', 'pkg', 'package.json'), '{"version":"2.0.0"}');
    await writeFile(join(sidecar, 'node_modules', '@scope', 'pkg', 'bin', 'package.json'), '{"type":"module"}');
    assert.deepEqual(await readSidecarPackages(sidecar), [
      { key: 'node_modules/@scope/pkg', version: '2.0.0', source: 'runtime.asar.unpacked' },
    ]);
  } finally {
    await rm(sidecar, { recursive: true, force: true });
  }
});

test('compareShippedVersions resolves linked lock entries to their target', () => {
  const linkLock = {
    '': { name: 'mixdog', version: '1.3.2' },
    'node_modules/linked': { resolved: 'packages/linked', link: true },
    'node_modules/dangling': { resolved: 'packages/gone', link: true },
    'packages/linked': { version: '1.0.0' },
  };
  const ship = (key, version) => [{ key, version, source: 'runtime.asar' }];
  assert.deepEqual(
    compareShippedVersions({ lockPackages: linkLock, shipped: ship('node_modules/linked', '1.0.0') }),
    []
  );
  const stale = compareShippedVersions({ lockPackages: linkLock, shipped: ship('node_modules/linked', '0.9.0') });
  assert.equal(stale.length, 1);
  assert.match(stale[0], /node_modules\/linked: shipped 0\.9\.0, lockfile 1\.0\.0/);
  const dangling = compareShippedVersions({ lockPackages: linkLock, shipped: ship('node_modules/dangling', '1.0.0') });
  assert.equal(dangling.length, 1);
  assert.match(dangling[0], /link target packages\/gone is missing/);
});

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

/** A real runtime.asar with packed and unpacked manifests, built from a fixture tree. */
async function buildRuntimeFixture({ zodVersion }) {
  const base = await mkdtemp(join(tmpdir(), 'runtime-verify-'));
  const source = join(base, 'source');
  const runtimeDir = join(base, 'runtime');
  const modules = join(source, 'node_modules');
  await writeJson(join(modules, 'zod', 'package.json'), { name: 'zod', version: zodVersion });
  await writeJson(join(modules, '@scope', 'pkg', 'package.json'), { name: '@scope/pkg', version: '2.0.0' });
  await writeJson(join(modules, 'outer', 'package.json'), { name: 'outer', version: '1.0.0' });
  await writeJson(join(modules, 'outer', 'node_modules', 'inner', 'package.json'), { name: 'inner', version: '0.5.0' });
  await writeJson(join(modules, 'outer', 'dist', 'package.json'), { type: 'module' });
  await writeJson(join(modules, 'native', 'package.json'), { name: 'native', version: '3.0.0' });
  await writeFile(join(modules, 'native', 'addon.node'), 'binary');
  await writeJson(join(modules, 'mixdog', 'package.json'), { name: 'mixdog', version: '1.3.2' });
  await mkdir(runtimeDir);
  await finished(
    await asar.createPackageWithOptions(source, join(runtimeDir, 'runtime.asar'), {
      unpackDir: join('node_modules', 'native'),
    })
  );
  await writeJson(join(runtimeDir, 'desktop-node-pty', 'package.json'), { version: '0.13.1' });
  const lock = (packages) => ({
    lockfileVersion: 3,
    packages: { '': { name: 'mixdog', version: '1.3.2' }, ...packages },
  });
  await writeJson(
    join(base, 'package-lock.json'),
    lock({
      'node_modules/zod': { version: '3.25.76' },
      'node_modules/@scope/pkg': { version: '2.0.0' },
      'node_modules/outer': { version: '1.0.0' },
      'node_modules/outer/node_modules/inner': { version: '0.5.0' },
      'node_modules/native': { version: '3.0.0' },
    })
  );
  const desktopDir = join(base, 'desktop');
  await writeJson(
    join(desktopDir, 'package-lock.json'),
    lock({ 'node_modules/@homebridge/node-pty-prebuilt-multiarch': { version: '0.13.1' } })
  );
  return { base, runtimeDir, rootDir: base, desktopDir };
}

test('readArchivePackages lists packed manifests and leaves unpacked ones to the sidecar', {
  skip: asarSkipReason,
}, async () => {
  const fixture = await buildRuntimeFixture({ zodVersion: '3.25.76' });
  try {
    const archive = join(fixture.runtimeDir, 'runtime.asar');
    const packed = (await readArchivePackages(archive)).map(({ key, version }) => `${key}@${version}`).sort();
    assert.deepEqual(packed, [
      'node_modules/@scope/pkg@2.0.0',
      'node_modules/mixdog@1.3.2',
      'node_modules/outer/node_modules/inner@0.5.0',
      'node_modules/outer@1.0.0',
      'node_modules/zod@3.25.76',
    ]);
    assert.deepEqual(await readSidecarPackages(`${archive}.unpacked`), [
      { key: 'node_modules/native', version: '3.0.0', source: 'runtime.asar.unpacked' },
    ]);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('verifyRuntimeDependencyVersions passes a runtime that matches the lockfiles', {
  skip: asarSkipReason,
}, async () => {
  const fixture = await buildRuntimeFixture({ zodVersion: '3.25.76' });
  try {
    assert.deepEqual(await verifyRuntimeDependencyVersions(fixture), []);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('verifyRuntimeDependencyVersions reports drift, unversioned manifests and a stale node-pty', {
  skip: asarSkipReason,
}, async () => {
  const fixture = await buildRuntimeFixture({ zodVersion: '3.0.0' });
  try {
    await writeJson(join(fixture.runtimeDir, 'desktop-node-pty', 'package.json'), { version: '0.12.0' });
    // The lockfile moves @scope/pkg ahead of the shipped 2.0.0.
    const lockPath = join(fixture.rootDir, 'package-lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    lock.packages['node_modules/@scope/pkg'].version = '2.1.0';
    await writeFile(lockPath, JSON.stringify(lock));
    const mismatches = await verifyRuntimeDependencyVersions(fixture);
    assert.equal(mismatches.length, 3);
    assert.ok(
      mismatches.some((line) => /node_modules\/zod: shipped 3\.0\.0, lockfile 3\.25\.76 \(runtime\.asar\)/.test(line))
    );
    assert.ok(mismatches.some((line) => /@scope\/pkg: shipped 2\.0\.0, lockfile 2\.1\.0/.test(line)));
    assert.ok(mismatches.some((line) => /shipped 0\.12\.0, desktop lockfile 0\.13\.1/.test(line)));
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test('verifyRuntimeDependencyVersions flags a shipped manifest without a version', {
  skip: asarSkipReason,
}, async () => {
  const fixture = await buildRuntimeFixture({ zodVersion: '3.25.76' });
  try {
    const sidecarManifest = join(
      `${join(fixture.runtimeDir, 'runtime.asar')}.unpacked`,
      'node_modules',
      'native',
      'package.json'
    );
    await writeJson(sidecarManifest, { name: 'native' });
    const mismatches = await verifyRuntimeDependencyVersions(fixture);
    assert.equal(mismatches.length, 1);
    assert.match(
      mismatches[0],
      /node_modules\/native: shipped manifest has no version, lockfile 3\.0\.0 \(runtime\.asar\.unpacked\)/
    );
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});
