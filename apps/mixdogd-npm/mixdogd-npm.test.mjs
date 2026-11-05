import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { makeTempDirSync } from '../../scripts/lib/scoped-temp.mjs';
import { CORE_PLATFORM_TARGETS } from '../desktop/src/main/ssh/server-manifest.mjs';
import { PLATFORM_KEYS, platformPackageName, resolveMixdogd } from './platform.mjs';
import { stageNpm } from './scripts/stage-npm.mjs';

test('the launcher knows exactly the platforms the core is built for', () => {
  assert.deepEqual([...PLATFORM_KEYS].sort(), Object.keys(CORE_PLATFORM_TARGETS).sort());
});

test('the binary is found in the platform package npm installed, or the missing piece is named', () => {
  const resolved = resolveMixdogd({
    platform: 'linux',
    arch: 'arm64',
    resolvePackageJson: (name) => {
      assert.equal(name, platformPackageName('linux-arm64'));
      return join('/node_modules', name, 'package.json');
    },
  });
  assert.equal(resolved.replaceAll('\\', '/').endsWith('/@mixdog/mixdogd-linux-arm64/bin/mixdogd'), true);
  assert.match(
    resolveMixdogd({ platform: 'win32', arch: 'x64', resolvePackageJson: () => '/n/package.json' }).replaceAll('\\', '/'),
    /bin\/mixdogd\.exe$/
  );
  assert.throws(() => resolveMixdogd({ platform: 'freebsd', arch: 'x64' }), /no core for freebsd-x64/);
  assert.throws(
    () =>
      resolveMixdogd({
        platform: 'linux',
        arch: 'x64',
        resolvePackageJson: () => {
          throw new Error('not found');
        },
      }),
    /@mixdog\/mixdogd-linux-x64 is not installed/
  );
});

test('staging writes a launcher pinned to one platform package per target, each limited to its os and cpu', async () => {
  const targetDir = makeTempDirSync('npm-target');
  for (const target of Object.values(CORE_PLATFORM_TARGETS)) {
    mkdirSync(join(targetDir, target, 'release'), { recursive: true });
    writeFileSync(join(targetDir, target, 'release', target.includes('windows') ? 'mixdogd.exe' : 'mixdogd'), target);
  }
  const outDir = makeTempDirSync('npm-out');
  const { packages } = await stageNpm({ targetDir, outDir, version: '1.4.6' });
  assert.equal(packages.length, 7);
  const launcher = JSON.parse(readFileSync(join(outDir, 'mixdogd', 'package.json'), 'utf8'));
  assert.equal(launcher.name, '@mixdog/mixdogd');
  assert.equal(launcher.version, '1.4.6');
  assert.deepEqual(Object.keys(launcher.optionalDependencies).sort(), PLATFORM_KEYS.map(platformPackageName).sort());
  assert.ok(Object.values(launcher.optionalDependencies).every((version) => version === '1.4.6'));
  const windows = JSON.parse(readFileSync(join(outDir, 'mixdogd-win32-arm64', 'package.json'), 'utf8'));
  assert.deepEqual([windows.os, windows.cpu], [['win32'], ['arm64']]);
  assert.equal(readFileSync(join(outDir, 'mixdogd-win32-arm64', 'bin', 'mixdogd.exe'), 'utf8'), 'aarch64-pc-windows-msvc');
  assert.equal(readFileSync(join(outDir, 'mixdogd', 'bin', 'mixdogd.mjs'), 'utf8').startsWith('#!/usr/bin/env node'), true);
});
