// scripts/check-npm-packages.mjs against packages that npm really packed (slow: it runs `npm pack` for each), and, when the built
// programs are at hand, the real start of the launcher from an install of the packed tarballs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkPackages, expectedPlatformFiles, readTarball } from './check-npm-packages.mjs';
import { NATIVE_PROGRAMS, PLATFORMS, programFile } from './npm-platforms.mjs';
import { lockOptionalDependencies, stageNpmNative } from './stage-npm-native.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = '9.8.7';
const KEYS = ['linux-x64', 'win32-x64'];

const npm = (args, cwd) => spawnSync('npm', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });

/** Where the built programs are: MIXDOG_TEST_NATIVE_DIR, or the cargo target folders of this checkout. */
function builtPrograms() {
  const candidates = [process.env.MIXDOG_TEST_NATIVE_DIR, process.env.CARGO_TARGET_DIR && join(process.env.CARGO_TARGET_DIR, 'debug'), join(root, 'native', 'core', 'target', 'debug')];
  return candidates.find((dir) => dir && NATIVE_PROGRAMS.every((name) => existsSync(join(dir, programFile(name, process.platform)))));
}

/** The main package with the real launcher files and the two staged platform packages, packed by npm into `out`. */
async function packAll(dir, programs) {
  const out = join(dir, 'tarballs');
  mkdirSync(out, { recursive: true });
  const main = join(dir, 'main');
  mkdirSync(join(main, 'bin'), { recursive: true });
  mkdirSync(join(main, 'src'));
  for (const file of ['mixdog.mjs', 'native-layout.mjs']) writeFileSync(join(main, 'bin', file), readFileSync(join(root, 'bin', file)));
  writeFileSync(join(main, 'src', 'skill-script-entry.mjs'), '');
  writeFileSync(join(main, 'package.json'), JSON.stringify({ name: 'mixdog', version: VERSION, type: 'module', bin: { mixdog: 'bin/mixdog.mjs' }, files: ['bin/', 'src/'] }));
  lockOptionalDependencies(join(main, 'package.json'));
  const staged = join(dir, 'staged');
  const folders = [];
  for (const key of KEYS) {
    const { platform, arch } = PLATFORMS.find((entry) => entry.key === key);
    folders.push(await stageNpmNative({ from: [programs(platform)], out: staged, platform, arch, version: VERSION }));
  }
  for (const folder of [main, ...folders]) {
    const packed = npm(['pack', '--ignore-scripts', '--pack-destination', out], folder);
    assert.equal(packed.status, 0, packed.stderr);
  }
  return out;
}

/** Fake programs: files with a name and some bytes (the structure checks start nothing). */
function fakePrograms(dir) {
  return (platform) => {
    const folder = join(dir, `fake-${platform}`);
    mkdirSync(folder, { recursive: true });
    for (const name of NATIVE_PROGRAMS) writeFileSync(join(folder, programFile(name, platform)), `${name} of ${platform}`);
    return folder;
  };
}

test('the packed packages of a release are accepted, with the exact files each carries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-npm-check-test-'));
  try {
    const out = await packAll(dir, fakePrograms(dir));
    // A Windows host cannot give a file of a Linux package the executable bit (the release packs on Linux); that is the one thing it cannot show.
    const problems = checkPackages({ dir: out, platforms: KEYS, version: VERSION }).filter((problem) => process.platform !== 'win32' || !/without the executable bit/.test(problem));
    assert.deepEqual(problems, []);
    const tarball = readFileSync(join(out, `mixdog-linux-x64-${VERSION}.tgz`));
    assert.ok(tarball.length > 0);
    const files = readTarball(join(out, `mixdog-linux-x64-${VERSION}.tgz`)).map((entry) => entry.path).sort();
    assert.deepEqual(files, expectedPlatformFiles('linux'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing platform, a wrong version, a native program in the main package and an extra file are each refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-npm-check-test-'));
  try {
    const out = await packAll(dir, fakePrograms(dir));
    // A platform the release stages but whose tarball is not there.
    const missing = checkPackages({ dir: out, platforms: [...KEYS, 'darwin-arm64'], version: VERSION });
    assert.ok(missing.some((problem) => /holds no tarball of mixdog-darwin-arm64/.test(problem)), missing.join('\n'));
    // A tarball the release does not stage.
    const extra = checkPackages({ dir: out, platforms: ['linux-x64'], version: VERSION });
    assert.ok(extra.some((problem) => /mixdog-win32-x64, which this release does not stage/.test(problem)), extra.join('\n'));
    // The release version differs from the packages'.
    const wrong = checkPackages({ dir: out, platforms: KEYS, version: '9.8.8' });
    assert.ok(wrong.some((problem) => /is version 9\.8\.7, the release is 9\.8\.8/.test(problem)), wrong.join('\n'));
    assert.ok(wrong.some((problem) => /optionalDependencies of mixdog/.test(problem)), wrong.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a platform package with a program missing or an extra file, and a main package that carries a program, are refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-npm-check-test-'));
  try {
    const programs = fakePrograms(dir);
    const full = programs('linux');
    // mixdog-askpass is not built: staging refuses it before a package exists.
    rmSync(join(full, 'mixdog-askpass'));
    await assert.rejects(stageNpmNative({ from: [full], out: join(dir, 'staged'), platform: 'linux', arch: 'x64', version: VERSION }), /mixdog-askpass is not built/);
    writeFileSync(join(full, 'mixdog-askpass'), 'askpass');

    // A platform package packed with a stray file (here a js-runtime.json: the install writes it, the package never carries it).
    const folder = await stageNpmNative({ from: [full], out: join(dir, 'staged'), platform: 'linux', arch: 'x64', version: VERSION });
    writeFileSync(join(folder, 'bin', 'js-runtime.json'), '{}');
    const out = join(dir, 'tarballs');
    mkdirSync(out);
    assert.equal(npm(['pack', '--ignore-scripts', '--pack-destination', out], folder).status, 0);
    const main = join(dir, 'main');
    mkdirSync(join(main, 'bin'), { recursive: true });
    mkdirSync(join(main, 'native-bin', 'linux-x64'), { recursive: true });
    writeFileSync(join(main, 'bin', 'mixdog.mjs'), '');
    writeFileSync(join(main, 'bin', 'native-layout.mjs'), '');
    writeFileSync(join(main, 'native-bin', 'linux-x64', 'mixdog'), 'program');
    writeFileSync(join(main, 'package.json'), JSON.stringify({ name: 'mixdog', version: VERSION, files: ['bin/', 'native-bin/'] }));
    assert.equal(npm(['pack', '--ignore-scripts', '--pack-destination', out], main).status, 0);
    const problems = checkPackages({ dir: out, platforms: ['linux-x64'], version: VERSION });
    assert.ok(problems.some((problem) => /holds package\/bin\/js-runtime\.json, which the package is not to carry/.test(problem)), problems.join('\n'));
    assert.ok(problems.some((problem) => /carries a native program: package\/native-bin\/linux-x64\/mixdog/.test(problem)), problems.join('\n'));
    assert.ok(problems.some((problem) => /optionalDependencies of mixdog/.test(problem)), problems.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const programs = builtPrograms();
test(
  'the launcher of the packed main package starts the programs of the packed platform package of this machine',
  { skip: programs ? false : 'no built mixdog, mixdogd and mixdog-askpass (set MIXDOG_TEST_NATIVE_DIR to a folder holding them)', timeout: 600_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mixdog-npm-check-run-'));
    try {
      const key = PLATFORMS.find((entry) => entry.platform === process.platform && entry.arch === process.arch)?.key;
      assert.ok(key, `${process.platform}-${process.arch} is not a staged platform`);
      const out = join(dir, 'tarballs');
      mkdirSync(out, { recursive: true });
      const main = join(dir, 'main');
      mkdirSync(join(main, 'bin'), { recursive: true });
      mkdirSync(join(main, 'src'));
      for (const file of ['mixdog.mjs', 'native-layout.mjs']) writeFileSync(join(main, 'bin', file), readFileSync(join(root, 'bin', file)));
      writeFileSync(join(main, 'src', 'skill-script-entry.mjs'), '');
      const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
      writeFileSync(join(main, 'package.json'), JSON.stringify({ name: 'mixdog', version, type: 'module', files: ['bin/', 'src/'] }));
      lockOptionalDependencies(join(main, 'package.json'));
      const entry = PLATFORMS.find((candidate) => candidate.key === key);
      const folder = await stageNpmNative({ from: [programs], out: join(dir, 'staged'), platform: entry.platform, arch: entry.arch, version });
      for (const packageDir of [main, folder]) {
        const packed = npm(['pack', '--ignore-scripts', '--pack-destination', out], packageDir);
        assert.equal(packed.status, 0, packed.stderr);
      }
      // Only this machine's platform is staged here, so the main package's other optional dependencies have no tarball to check.
      const problems = checkPackages({ dir: out, platforms: [key], run: key, version });
      assert.deepEqual(problems, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
