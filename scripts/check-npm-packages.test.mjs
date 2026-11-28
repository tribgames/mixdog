// The rules of scripts/check-npm-packages.mjs: what the package must hold, with no tarball, and what the runtime archives
// beside it must be. (check-npm-packages.slow.test.mjs packs a real package.)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LAUNCHER_FILES, mainProblems, runtimeProblems } from './check-npm-packages.mjs';
import { PLATFORMS, runtimeAssetName } from './npm-platforms.mjs';
import { LEGACY_ENTRY, LEGACY_ENTRY_SOURCE, runtimeFiles, runtimeManifest, writeRuntimeArchive } from './npm-runtime-assets.mjs';

const VERSION = '4.5.6';
const BUILD = 'c0ffee';
const KEYS = PLATFORMS.map(({ key }) => key);
const json = (value) => Buffer.from(JSON.stringify(value));

/** A runtime manifest of every platform the release builds, as the release writes it. */
const manifestOf = (change = (targets) => targets) => ({
  schema: 1,
  repository: 'tribgames/mixdog',
  tag: `v${VERSION}`,
  targets: change(
    Object.fromEntries(
      PLATFORMS.map(({ key, platform }) => [
        key,
        { asset: runtimeAssetName(key), length: 10, sha256: 'a'.repeat(64), version: VERSION, buildId: BUILD, files: Object.fromEntries(runtimeFiles(platform).map((path) => [path, 1])) },
      ])
    )
  ),
});

const mainEntries = ({ manifest = {}, runtime = manifestOf(), drop = [], extra = [] } = {}) =>
  [
    {
      path: 'package/package.json',
      data: json({ name: 'mixdog', version: VERSION, bin: { mixdog: 'bin/mixdog.mjs', 'mixdog-runtime': 'bin/mixdog-runtime.mjs' }, ...manifest }),
    },
    ...LAUNCHER_FILES.map((path) => ({
      path: `package/${path}`,
      data: path === 'bin/runtime-manifest.json' ? json(runtime) : Buffer.from(path === LEGACY_ENTRY ? LEGACY_ENTRY_SOURCE : 'x'),
    })),
    ...extra.map((path) => ({ path, data: Buffer.from('x') })),
  ].filter((entry) => !drop.includes(entry.path));

const problemsOf = (options, check = {}) => mainProblems({ entries: mainEntries(options), version: VERSION, platforms: KEYS, buildId: BUILD, ...check }).join('\n');

test('the package holds the launcher, the 1.4.5 command and a manifest of exactly the runtimes of the release, and no program', () => {
  assert.equal(problemsOf({}, { repository: 'tribgames/mixdog', tag: `v${VERSION}` }), '');
  assert.match(problemsOf({ manifest: { optionalDependencies: { 'mixdog-linux-x64': VERSION } } }), /lists optional dependencies/);
  assert.match(problemsOf({ manifest: { bin: { mixdog: 'bin/mixdog.mjs' } } }), /the package's bin is/);
  assert.match(problemsOf({ manifest: { version: '1.0.0' } }), /the package is version 1\.0\.0, the release is 4\.5\.6/);
  assert.match(problemsOf({ extra: ['package/vendor/mixdogd.exe'] }), /carries a native program: package\/vendor\/mixdogd\.exe/);
  assert.match(problemsOf({ drop: [`package/${LEGACY_ENTRY}`] }), /lacks package\/src\/cli\.mjs/);
  assert.match(problemsOf({ drop: ['package/bin/download.mjs'] }), /lacks package\/bin\/download\.mjs/);
  assert.match(problemsOf({ drop: ['package/bin/runtime-manifest.json'] }), /lacks package\/bin\/runtime-manifest\.json/);
});

test('a 1.4.5 command that is not the launcher, and a manifest that is not this release\'s, are each named', () => {
  const entries = mainEntries().map((entry) => (entry.path === `package/${LEGACY_ENTRY}` ? { ...entry, data: Buffer.from('// stale') } : entry));
  assert.match(mainProblems({ entries, version: VERSION, platforms: KEYS }).join('\n'), /src\/cli\.mjs is not the command an install made by 1\.4\.5 starts/);
  assert.match(problemsOf({}, { buildId: 'other' }), /linux-x64: the build is c0ffee, not other/);
  assert.match(problemsOf({}, { repository: 'someone/fork' }), /names the repository tribgames\/mixdog, not someone\/fork/);
  assert.match(problemsOf({}, { tag: 'v9.9.9' }), /names the tag v4\.5\.6, not v9\.9\.9/);
  const { 'darwin-x64': _gone, ...fewer } = manifestOf().targets;
  assert.match(problemsOf({ runtime: manifestOf(() => fewer) }), /names no runtime for darwin-x64/);
  assert.match(problemsOf({}, { platforms: KEYS.filter((key) => key !== 'linux-arm64') }), /a runtime for linux-arm64, which this release does not build/);
  const renamed = manifestOf((targets) => ({ ...targets, 'linux-x64': { ...targets['linux-x64'], asset: 'mixdog-runtime-linux.tar.gz' } }));
  assert.match(problemsOf({ runtime: renamed }), /linux-x64: the asset is mixdog-runtime-linux\.tar\.gz, not mixdog-runtime-linux-x64\.tar\.gz/);
  const unlisted = manifestOf((targets) => ({ ...targets, 'win32-x64': { ...targets['win32-x64'], files: { ...targets['win32-x64'].files, 'extra.dll': 1 } } }));
  assert.match(problemsOf({ runtime: unlisted }), /win32-x64: the runtime lists .*extra\.dll/);
  const older = manifestOf((targets) => ({ ...targets, 'linux-x64': { ...targets['linux-x64'], version: '4.5.5' } }));
  assert.match(problemsOf({ runtime: older }), /the runtime manifest: linux-x64: the version "4\.5\.5" is not the package's 4\.5\.6/);
});

test('the runtime folder holds exactly the archives the manifest names, each of its bytes and its layout', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-runtime-check-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const built = join(dir, 'built');
  mkdirSync(built);
  for (const name of ['mixdog', 'mixdogd', 'mixdog-askpass']) writeFileSync(join(built, name), name);
  const assets = join(dir, 'assets');
  const archive = await writeRuntimeArchive({ key: 'linux-x64', from: [built], out: assets });
  const manifest = runtimeManifest({ archives: [archive], version: VERSION, buildId: BUILD, repository: 'o/r', tag: `v${VERSION}` });
  assert.deepEqual(await runtimeProblems({ manifest, dir: assets }), []);
  writeFileSync(join(assets, 'stray.txt'), 'x');
  const wrong = { ...manifest, targets: { 'linux-x64': { ...manifest.targets['linux-x64'], sha256: 'b'.repeat(64) }, 'win32-x64': { ...manifest.targets['linux-x64'], asset: 'mixdog-runtime-win32-x64.tar.gz' } } };
  const problems = (await runtimeProblems({ manifest: wrong, dir: assets })).join('\n');
  assert.match(problems, /holds stray\.txt, which is no asset of the runtime manifest/);
  assert.match(problems, /holds no mixdog-runtime-win32-x64\.tar\.gz/);
  assert.match(problems, /linux-x64: .* its SHA-256 is [0-9a-f]{64}, the release's is b{64}/);
});
