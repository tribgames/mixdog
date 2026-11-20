// The rules of scripts/check-npm-packages.mjs on file lists, with no tarball: what a platform package and the main package
// must hold. (check-npm-packages.slow.test.mjs packs real packages.)
import assert from 'node:assert/strict';
import test from 'node:test';

import { expectedPlatformFiles, mainProblems, platformProblems } from './check-npm-packages.mjs';
import { PLATFORMS, platformPackageName } from './npm-platforms.mjs';

const VERSION = '4.5.6';
const json = (value) => Buffer.from(JSON.stringify(value));
const platformEntries = (key, overrides = {}) => {
  const { platform, cpu } = PLATFORMS.find((entry) => entry.key === key);
  const manifest = { name: platformPackageName(key), version: VERSION, os: [platform], cpu, ...overrides };
  return expectedPlatformFiles(platform).map((path) => ({
    path,
    mode: 0o755,
    data: path === 'package/package.json' ? json(manifest) : Buffer.from('x'),
  }));
};
const mainEntries = (overrides = {}, extra = []) => [
  {
    path: 'package/package.json',
    mode: 0o644,
    data: json({
      name: 'mixdog',
      version: VERSION,
      optionalDependencies: Object.fromEntries(PLATFORMS.map(({ key }) => [platformPackageName(key), VERSION])),
      ...overrides,
    }),
  },
  { path: 'package/bin/mixdog.mjs', mode: 0o644, data: Buffer.from('x') },
  { path: 'package/bin/native-layout.mjs', mode: 0o644, data: Buffer.from('x') },
  { path: 'package/bin/staged-swap.mjs', mode: 0o644, data: Buffer.from('x') },
  { path: 'package/bin/invocation.mjs', mode: 0o644, data: Buffer.from('x') },
  ...extra.map((path) => ({ path, mode: 0o644, data: Buffer.from('x') })),
];

test('a platform package holds its three programs, the three templates and its manifest, and nothing else', () => {
  assert.deepEqual(
    expectedPlatformFiles('linux').filter((path) => path.startsWith('package/bin/') && !path.includes('assets')),
    ['package/bin/mixdog', 'package/bin/mixdog-askpass', 'package/bin/mixdogd']
  );
  assert.ok(expectedPlatformFiles('win32').includes('package/bin/mixdogd.exe'));
  assert.equal(expectedPlatformFiles('linux').filter((path) => path.includes('assets/templates/')).length, 3);
  assert.deepEqual(platformProblems({ entries: platformEntries('linux-x64'), key: 'linux-x64', version: VERSION }), []);
  assert.deepEqual(platformProblems({ entries: platformEntries('win32-x64'), key: 'win32-x64', version: VERSION }), []);
});

test('a missing program, an extra file, a wrong version, os or cpu and a program that cannot be executed are each named', () => {
  const missing = platformEntries('linux-x64').filter((entry) => entry.path !== 'package/bin/mixdog-askpass');
  assert.match(
    platformProblems({ entries: missing, key: 'linux-x64', version: VERSION }).join('\n'),
    /lacks package\/bin\/mixdog-askpass/
  );
  const extra = [
    ...platformEntries('linux-x64'),
    { path: 'package/bin/js-runtime.json', mode: 0o644, data: Buffer.from('{}') },
  ];
  assert.match(
    platformProblems({ entries: extra, key: 'linux-x64', version: VERSION }).join('\n'),
    /holds package\/bin\/js-runtime\.json/
  );
  assert.match(
    platformProblems({ entries: platformEntries('linux-x64'), key: 'linux-x64', version: '4.5.7' }).join('\n'),
    /is version 4\.5\.6, the release is 4\.5\.7/
  );
  assert.match(
    platformProblems({
      entries: platformEntries('linux-x64', { os: ['darwin'] }),
      key: 'linux-x64',
      version: VERSION,
    }).join('\n'),
    /os is \["darwin"\]/
  );
  assert.match(
    platformProblems({
      entries: platformEntries('linux-x64', { cpu: ['arm64'] }),
      key: 'linux-x64',
      version: VERSION,
    }).join('\n'),
    /cpu is \["arm64"\]/
  );
  const plain = platformEntries('linux-x64').map((entry) => ({ ...entry, mode: 0o644 }));
  assert.match(
    platformProblems({ entries: plain, key: 'linux-x64', version: VERSION }).join('\n'),
    /mixdogd without the executable bit/
  );
  // Windows programs have no mode to check.
  const win = platformEntries('win32-x64').map((entry) => ({ ...entry, mode: 0o644 }));
  assert.deepEqual(platformProblems({ entries: win, key: 'win32-x64', version: VERSION }), []);
});

test('the main package lists every platform package at the release version and carries no program', () => {
  assert.deepEqual(mainProblems({ entries: mainEntries(), version: VERSION }), []);
  assert.match(
    mainProblems({ entries: mainEntries({ optionalDependencies: {} }), version: VERSION }).join('\n'),
    /optionalDependencies of mixdog/
  );
  const drift = Object.fromEntries(PLATFORMS.map(({ key }) => [platformPackageName(key), '4.5.5']));
  assert.match(
    mainProblems({ entries: mainEntries({ optionalDependencies: drift }), version: VERSION }).join('\n'),
    /optionalDependencies of mixdog/
  );
  assert.match(
    mainProblems({ entries: mainEntries({}, ['package/native-bin/linux-x64/mixdog']), version: VERSION }).join('\n'),
    /carries a native program/
  );
  assert.match(
    mainProblems({ entries: mainEntries({}, ['package/vendor/mixdogd.exe']), version: VERSION }).join('\n'),
    /carries a native program/
  );
  assert.match(
    mainProblems({ entries: mainEntries({ version: '1.0.0' }), version: VERSION }).join('\n'),
    /is version 1\.0\.0/
  );
  const noLauncher = mainEntries().filter((entry) => !entry.path.endsWith('native-layout.mjs'));
  assert.match(
    mainProblems({ entries: noLauncher, version: VERSION }).join('\n'),
    /lacks package\/bin\/native-layout\.mjs/
  );
  const noSwap = mainEntries().filter((entry) => !entry.path.endsWith('staged-swap.mjs'));
  assert.match(mainProblems({ entries: noSwap, version: VERSION }).join('\n'), /lacks package\/bin\/staged-swap\.mjs/);
});
