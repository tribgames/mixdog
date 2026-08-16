import assert from 'node:assert/strict';
import test from 'node:test';

import { decidePlan } from './dev-fast-direct.mjs';

const groups = Object.fromEntries(
  ['renderer', 'main', 'preload', 'daemon', 'runtime', 'package'].map((name) => [
    name,
    { hash: `${name}-same`, newestMtimeMs: 10 },
  ]),
);
const previous = {
  schemaVersion: 1,
  groups: Object.fromEntries(
    Object.entries(groups).map(([name, value]) => [name, { hash: value.hash }]),
  ),
};

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
