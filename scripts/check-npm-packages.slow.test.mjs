// scripts/check-npm-packages.mjs against a package npm really packed (slow: it runs `npm pack`) and the runtime archives the
// release writes beside it, and, when the built programs are at hand, the real start of each program through the launcher
// from an install of the packed package and an import of the archive.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkPackages, readTarball } from './check-npm-packages.mjs';
import { NATIVE_PROGRAMS, PLATFORMS, programFile } from './npm-platforms.mjs';
import { runtimeManifest, writeRuntimeArchive } from './npm-runtime-assets.mjs';
import { writePackage } from './npm-test-fixture.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = '9.8.7';
const KEYS = ['linux-x64', 'win32-x64'];

const npm = (args, cwd) =>
  spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
    timeout: 120_000,
  });

/** Where the built programs are: MIXDOG_TEST_NATIVE_DIR, or the cargo target folders of this checkout. */
function builtPrograms() {
  const candidates = [
    process.env.MIXDOG_TEST_NATIVE_DIR,
    process.env.CARGO_TARGET_DIR && join(process.env.CARGO_TARGET_DIR, 'debug'),
    join(root, 'native', 'core', 'target', 'debug'),
  ];
  return candidates.find(
    (dir) => dir && NATIVE_PROGRAMS.every((name) => existsSync(join(dir, programFile(name, process.platform))))
  );
}

/**
 * The release of `keys` from the programs `programs(platform)` names: the archives in `<dir>/assets`, and the package (the real
 * launcher, the skill entry, the manifest of those archives and the 1.4.5 command, as pack-npm writes them) packed by npm into
 * `<dir>/tarballs`, with `extra` files beside the launcher.
 */
async function release(dir, programs, { keys = KEYS, version = VERSION, extra = [] } = {}) {
  const assets = join(dir, 'assets');
  const archives = [];
  for (const key of keys) archives.push(await writeRuntimeArchive({ key, from: [programs(key.split('-')[0])], out: assets }));
  const manifest = runtimeManifest({ archives, version, buildId: 'build-1', repository: 'o/r', tag: `v${version}` });
  const main = writePackage(join(dir, 'main'), { version, manifest });
  writeFileSync(
    join(main, 'package.json'),
    JSON.stringify({ name: 'mixdog', version, type: 'module', bin: { mixdog: 'bin/mixdog.mjs', 'mixdog-runtime': 'bin/mixdog-runtime.mjs' }, files: ['bin/', 'src/'] })
  );
  for (const [path, text] of extra) writeFileSync(join(main, path), text);
  const out = join(dir, 'tarballs');
  mkdirSync(out, { recursive: true });
  const packed = npm(['pack', '--ignore-scripts', '--pack-destination', out], main);
  assert.equal(packed.status, 0, packed.stderr);
  return { out, assets, manifest };
}

/** Fake programs: files with a name and some bytes (the structure checks start nothing). */
function fakePrograms(dir) {
  return (platform) => {
    const folder = join(dir, `fake-${platform}`);
    mkdirSync(folder, { recursive: true });
    for (const name of NATIVE_PROGRAMS)
      writeFileSync(join(folder, programFile(name, platform)), `${name} of ${platform}`);
    return folder;
  };
}

test('the packed package of a release and its archives are accepted, and npm packs the files pack-npm writes for it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-npm-check-test-'));
  try {
    const { out, assets } = await release(dir, fakePrograms(dir));
    assert.deepEqual(await checkPackages({ dir: out, runtime: assets, platforms: KEYS, version: VERSION, buildId: 'build-1', repository: 'o/r', tag: `v${VERSION}` }), []);
    const files = readTarball(join(out, `mixdog-${VERSION}.tgz`)).map((entry) => entry.path);
    for (const path of ['package/bin/runtime-manifest.json', 'package/src/cli.mjs', 'package/bin/mixdog-runtime.mjs', 'package/bin/download.mjs'])
      assert.ok(files.includes(path), path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a package that carries a program, of another version, or beside archives that are not the ones it names, is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-npm-check-test-'));
  try {
    const { out, assets } = await release(dir, fakePrograms(dir), { extra: [['bin/mixdogd', 'program']] });
    writeFileSync(join(assets, 'mixdog-runtime-win32-x64.tar.gz'), 'not the archive');
    const problems = (await checkPackages({ dir: out, runtime: assets, platforms: KEYS, version: VERSION })).join('\n');
    assert.match(problems, /carries a native program: package\/bin\/mixdogd/);
    assert.match(problems, /win32-x64: .*mixdog-runtime-win32-x64\.tar\.gz is \d+ bytes, not the \d+ bytes of mixdog-runtime-win32-x64\.tar\.gz of mixdog 9\.8\.7/);
    const other = (await checkPackages({ dir: out, runtime: assets, platforms: KEYS, version: '9.8.8' })).join('\n');
    assert.match(other, /the package is version 9\.8\.7, the release is 9\.8\.8/);
    assert.match(other, /linux-x64: the version "9\.8\.7" is not the package's 9\.8\.8/);
    // The folder of the package holds it alone.
    copyFileSync(join(out, `mixdog-${VERSION}.tgz`), join(out, 'mixdog-linux-x64-9.8.7.tgz'));
    await assert.rejects(checkPackages({ dir: out, runtime: assets, platforms: KEYS, version: VERSION }), /not the one tarball of the package/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const programs = builtPrograms();
test('the launcher of the packed package starts every program of this machine\'s archive, imported with its own command', {
  skip: programs
    ? false
    : 'no built mixdog, mixdogd and mixdog-askpass (set MIXDOG_TEST_NATIVE_DIR to a folder holding them)',
  timeout: 600_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-npm-check-run-'));
  try {
    const key = PLATFORMS.find((entry) => entry.platform === process.platform && entry.arch === process.arch)?.key;
    assert.ok(key, `${process.platform}-${process.arch} is not a staged platform`);
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    const { out, assets } = await release(dir, () => programs, { keys: [key], version });
    assert.deepEqual(await checkPackages({ dir: out, runtime: assets, platforms: [key], run: key, version }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
