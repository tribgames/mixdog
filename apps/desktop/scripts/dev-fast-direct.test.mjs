import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import {
  asarPath,
  changedPlanGroups,
  decidePlan,
  packagingManifestForFingerprint,
} from './dev-fast-direct.mjs';
import {
  DEFAULT_RENDERER_WATCH_IDLE_MS,
  MIN_RENDERER_WATCH_IDLE_MS,
  resolveRendererWatchIdleMs,
} from './dev-renderer-watch-config.mjs';

const groups = Object.fromEntries(
  ['renderer', 'main', 'preload', 'daemon', 'runtime', 'package'].map((name) => [
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
      changed: {
        renderer: false,
        main: false,
        preload: false,
        daemon: false,
        runtime: false,
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
  });
  assert.deepEqual(plan.targets, []);
  assert.equal(plan.daemon, true);
  assert.equal(plan.runtime, true);
  assert.equal(plan.full, false);
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
