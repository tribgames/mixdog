import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { createPackageWithOptions, statFile } from '@electron/asar';

import {
  asarPath,
  changedPlanGroups,
  decidePlan,
  fastDirectAsarOptions,
  fastDirectRuntimeArchive,
  hashBrowserImportNativeTools,
  installedFastRuntimeReady,
  packagingManifestForFingerprint,
  runtimePackageFileForFingerprint,
  targetInputs,
} from './dev-fast-direct.mjs';
import {
  DEFAULT_RENDERER_WATCH_IDLE_MS,
  MIN_RENDERER_WATCH_IDLE_MS,
  resolveRendererWatchIdleMs,
} from './dev-renderer-watch-config.mjs';

const repoRoot = resolve(import.meta.dirname, '../../..');
const groups = Object.fromEntries(
  ['renderer', 'main', 'preload', 'daemon', 'runtime', 'runtimeDependencies', 'package'].map((name) => [
    name,
    { hash: `${name}-same`, newestMtimeMs: 10 },
  ]),
);
const previous = {
  schemaVersion: 2,
  groups: Object.fromEntries(
    Object.entries(groups).map(([name, value]) => [name, { hash: value.hash }]),
  ),
};

test('ASAR API paths always use native separators', () => {
  const expected = join('out', 'main', 'daemon.cjs');
  assert.equal(asarPath('out\\main\\daemon.cjs'), expected);
  assert.equal(asarPath('out/main/daemon.cjs'), expected);
});

test('FastDirect shell integrity keeps the installed production runtime fallback', () => {
  assert.equal(
    fastDirectRuntimeArchive(join('C:', 'Mixdog', 'resources')),
    join('C:', 'Mixdog', 'resources', 'runtime.asar'),
  );
});

test('FastDirect fingerprints browser importer source and installed native tools', async (context) => {
  assert.ok(
    targetInputs.runtime.some((path) => path.endsWith(join('native', 'mixdog-browser-import'))),
  );
  const root = await mkdtemp(join(tmpdir(), 'mixdog-fast-direct-native-tools-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const missingHash = await hashBrowserImportNativeTools(root);
  await writeFile(join(root, 'mixdog-browser-import.exe'), 'fixture');
  const presentHash = await hashBrowserImportNativeTools(root);
  assert.notEqual(presentHash, missingHash);
});

test('FastDirect keeps Electron ESM entry points packed', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-fast-direct-asar-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const staging = join(root, 'staging');
  const archive = join(root, 'app.asar');
  const files = [
    'out/main/index.js',
    'out/main/daemon.cjs',
    'out/preload/index.js',
    'out/renderer/index.html',
  ];
  for (const file of files) {
    const target = join(staging, asarPath(file));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, file);
  }

  await createPackageWithOptions(staging, archive, fastDirectAsarOptions());

  assert.equal(
    Boolean(statFile(archive, asarPath('out/main/index.js'), false).unpacked),
    false,
  );
  assert.equal(
    Boolean(statFile(archive, asarPath('out/preload/index.js'), false).unpacked),
    false,
  );
  assert.equal(
    Boolean(statFile(archive, asarPath('out/main/daemon.cjs'), false).unpacked),
    true,
  );
  assert.equal(
    Boolean(statFile(archive, asarPath('out/renderer/index.html'), false).unpacked),
    true,
  );
});

test('FastDirect rejects a plan when build inputs changed before staging', () => {
  assert.deepEqual(changedPlanGroups(groups, structuredClone(groups)), []);
  const changedGroups = structuredClone(groups);
  changedGroups.main.hash = 'main-new';
  changedGroups.runtime.hash = 'runtime-new';
  assert.deepEqual(changedPlanGroups(groups, changedGroups), ['main', 'runtime']);
});

test('renderer build cache stays warm briefly and then releases memory', () => {
  assert.equal(resolveRendererWatchIdleMs(undefined), DEFAULT_RENDERER_WATCH_IDLE_MS);
  assert.equal(resolveRendererWatchIdleMs(1), MIN_RENDERER_WATCH_IDLE_MS);
  assert.equal(resolveRendererWatchIdleMs(90_000), 90_000);
});

test('unchanged installed build is a no-op', () => {
  assert.deepEqual(
    decidePlan({ previous, groups, installedMatches: true, bootstrapFresh: null }),
    {
      full: false,
      bootstrap: false,
      targets: [],
      daemon: false,
      runtime: false,
      runtimeMode: 'none',
      changed: {
        renderer: false,
        main: false,
        preload: false,
        daemon: false,
        runtime: false,
        runtimeDependencies: false,
        package: false,
      },
    },
  );
});

test('an explicit release version forces a shell rebuild without rebuilding unchanged runtime', () => {
  const plan = decidePlan({
    previous,
    groups,
    installedMatches: true,
    bootstrapFresh: null,
    forceFull: true,
  });
  assert.equal(plan.full, true);
  assert.deepEqual(plan.targets, []);
  assert.equal(plan.changed.package, true);
  assert.equal(plan.changed.runtime, false);
  assert.equal(plan.changed.daemon, false);
});

test('renderer-only change builds only renderer', () => {
  const changedGroups = structuredClone(groups);
  changedGroups.renderer.hash = 'renderer-new';
  const plan = decidePlan({
    previous,
    groups: changedGroups,
    installedMatches: true,
    bootstrapFresh: null,
  });
  assert.deepEqual(plan.targets, ['renderer']);
  assert.equal(plan.full, false);
  assert.equal(plan.daemon, false);
  assert.equal(plan.runtime, false);
});

test('runtime and daemon changes do not rebuild desktop targets', () => {
  const changedGroups = structuredClone(groups);
  changedGroups.daemon.hash = 'daemon-new';
  changedGroups.runtime.hash = 'runtime-new';
  const plan = decidePlan({
    previous,
    groups: changedGroups,
    installedMatches: true,
    bootstrapFresh: null,
    devRuntimeReady: true,
  });
  assert.deepEqual(plan.targets, []);
  assert.equal(plan.daemon, true);
  assert.equal(plan.runtime, true);
  assert.equal(plan.runtimeMode, 'code');
  assert.equal(plan.full, false);
});

test('runtime dependency changes rebuild the unpacked FastDirect dependency tree', () => {
  const changedGroups = structuredClone(groups);
  changedGroups.runtime.hash = 'runtime-new';
  changedGroups.runtimeDependencies.hash = 'dependencies-new';
  const plan = decidePlan({
    previous,
    groups: changedGroups,
    installedMatches: true,
    bootstrapFresh: null,
    devRuntimeReady: true,
  });
  assert.equal(plan.runtime, true);
  assert.equal(plan.runtimeMode, 'full');
});

test('a missing FastDirect dependency tree upgrades a source change to a full runtime stage', () => {
  const changedGroups = structuredClone(groups);
  changedGroups.runtime.hash = 'runtime-new';
  const plan = decidePlan({
    previous,
    groups: changedGroups,
    installedMatches: true,
    bootstrapFresh: null,
    devRuntimeReady: false,
  });
  assert.equal(plan.runtimeMode, 'full');
});

test('packaging change falls back to the complete directory build', () => {
  const changedGroups = structuredClone(groups);
  changedGroups.package.hash = 'package-new';
  const plan = decidePlan({
    previous,
    groups: changedGroups,
    installedMatches: true,
    bootstrapFresh: null,
  });
  assert.equal(plan.full, true);
  assert.deepEqual(plan.targets, []);
});

test('legacy plan migration ignores deploy-script hash drift but keeps newer package inputs', () => {
  const legacyPrevious = structuredClone(previous);
  delete legacyPrevious.groups.runtimeDependencies;
  legacyPrevious.deployedAt = new Date(15).toISOString();
  const migratedGroups = structuredClone(groups);
  migratedGroups.package.hash = 'new-package-algorithm';
  migratedGroups.package.newestMtimeMs = 10;
  const incremental = decidePlan({
    previous: legacyPrevious,
    groups: migratedGroups,
    installedMatches: true,
    bootstrapFresh: null,
    devRuntimeReady: false,
  });
  assert.equal(incremental.full, false);
  assert.equal(incremental.runtimeMode, 'none');

  migratedGroups.package.newestMtimeMs = 20;
  const fallback = decidePlan({
    previous: legacyPrevious,
    groups: migratedGroups,
    installedMatches: true,
    bootstrapFresh: null,
    devRuntimeReady: false,
  });
  assert.equal(fallback.full, true);
});

test('trusted bootstrap uses artifact times and always checks runtime', () => {
  const bootstrapGroups = structuredClone(groups);
  bootstrapGroups.renderer.newestMtimeMs = 20;
  const plan = decidePlan({
    previous: null,
    groups: bootstrapGroups,
    installedMatches: false,
    bootstrapFresh: {
      renderer: 15,
      main: 15,
      preload: 15,
      daemon: 15,
      package: 15,
    },
  });
  assert.equal(plan.full, false);
  assert.equal(plan.bootstrap, true);
  assert.deepEqual(plan.targets, ['renderer']);
  assert.equal(plan.runtime, true);
  assert.equal(plan.runtimeMode, 'full');
});

test('installed FastDirect runtime readiness requires the matching dependency marker', async (context) => {
  const installDir = await mkdtemp(join(tmpdir(), 'mixdog-fast-runtime-ready-'));
  context.after(() => rm(installDir, { recursive: true, force: true }));
  const runtimeRoot = join(installDir, 'resources', 'fast-runtime');
  const entry = join(runtimeRoot, 'node_modules', 'mixdog', 'src', 'standalone');
  await mkdir(entry, { recursive: true });
  await writeFile(join(entry, 'session-client.mjs'), 'export {};');
  await writeFile(join(runtimeRoot, '.mixdog-fast-runtime.json'), JSON.stringify({
    schemaVersion: 1,
    dependencyHash: 'dependencies-v1',
  }));

  assert.equal(await installedFastRuntimeReady(installDir, 'dependencies-v1'), true);
  assert.equal(await installedFastRuntimeReady(installDir, 'dependencies-v2'), false);
});

test('developer scripts do not invalidate the packaged application', () => {
  const first = packagingManifestForFingerprint({
    name: '@mixdog/desktop',
    main: './out/main/index.js',
    scripts: { test: 'node --test one.test.mjs' },
    dependencies: { ws: '^8.21.1' },
  });
  const second = packagingManifestForFingerprint({
    name: '@mixdog/desktop',
    main: './out/main/index.js',
    scripts: { test: 'node --test one.test.mjs two.test.mjs' },
    dependencies: { ws: '^8.21.1' },
  });
  assert.deepEqual(first, second);
  assert.equal('scripts' in first, false);
});

test('runtime package metadata still invalidates the packaged application', () => {
  const normalized = packagingManifestForFingerprint({
    scripts: { test: 'node --test' },
    dependencies: { ws: '^9.0.0' },
  });
  assert.deepEqual(normalized, { dependencies: { ws: '^9.0.0' } });
});

test('runtime fingerprint excludes developer-only package files but keeps build inputs', () => {
  assert.equal(
    runtimePackageFileForFingerprint(join(repoRoot, 'scripts', 'bench', 'trace.mjs')),
    false,
  );
  assert.equal(
    runtimePackageFileForFingerprint(join(repoRoot, 'scripts', 'release-gate.mjs')),
    true,
  );
  assert.equal(
    runtimePackageFileForFingerprint(
      join(repoRoot, 'scripts', 'runtime-dependency-cache-key.mjs'),
    ),
    true,
  );
  assert.equal(
    runtimePackageFileForFingerprint(
      join(repoRoot, 'scripts', 'lib', 'stage-postgres-runtime-windows.ps1'),
    ),
    true,
  );
  assert.equal(
    runtimePackageFileForFingerprint(join(repoRoot, 'scripts', 'local-only.ps1')),
    false,
  );
});
