import assert from 'node:assert/strict';
import test from 'node:test';

import { planRuntimeReleaseTag, selectRuntimeRelease } from './plan-runtime-release-tag.mjs';

const WIN = 'mixdog-runtime-win32-x64-pg16.4-pgvector0.8.2.tar.gz';
const LINUX = 'mixdog-runtime-linux-x64-pg16.4-pgvector0.8.2.tar.gz';

test('a rebuild that would replace an asset of a shipped tag moves to the next patch tag', () => {
  const plan = (requestedTag) =>
    planRuntimeReleaseTag({
      requestedTag,
      shippedTag: 'runtime-v0.4.1',
      neededAssets: [WIN],
      publishedAssets: [WIN, LINUX, 'build-success-win32-x64-old.marker'],
    });
  assert.equal(plan('runtime-v0.4.1'), 'runtime-v0.4.2');
  // An older tag is shipped by older apps too.
  assert.equal(plan('runtime-v0.3.9'), 'runtime-v0.4.2');
});

test('unshipped tags and builds that only add missing assets keep the requested tag', () => {
  assert.equal(
    planRuntimeReleaseTag({
      requestedTag: 'runtime-v0.4.2',
      shippedTag: 'runtime-v0.4.1',
      neededAssets: [WIN],
      publishedAssets: [WIN],
    }),
    'runtime-v0.4.2'
  );
  assert.equal(
    planRuntimeReleaseTag({
      requestedTag: 'runtime-v0.4.1',
      shippedTag: 'runtime-v0.4.1',
      neededAssets: [WIN],
      publishedAssets: [LINUX],
    }),
    'runtime-v0.4.1'
  );
  assert.equal(
    planRuntimeReleaseTag({
      requestedTag: 'runtime-v0.4.1',
      shippedTag: 'runtime-v0.4.1',
      neededAssets: [],
      publishedAssets: [WIN],
    }),
    'runtime-v0.4.1'
  );
});

test('malformed tags are rejected', () => {
  assert.throws(
    () =>
      planRuntimeReleaseTag({
        requestedTag: 'v0.4.1',
        shippedTag: 'runtime-v0.4.1',
        neededAssets: [WIN],
        publishedAssets: [WIN],
      }),
    /invalid runtime release tag: v0\.4\.1/
  );
});

test('an occupied public tag does not prevent a later commit from releasing or resuming its own tag', () => {
  const occupied = { state: 'public', belongsToCommit: false };
  const own = { state: 'public', belongsToCommit: true };
  const plan = (second) =>
    selectRuntimeRelease({
      requested: 'runtime-v0.4.1',
      shipped: 'runtime-v0.4.1',
      inspect: (tag) => ({ 'runtime-v0.4.2': occupied, 'runtime-v0.4.3': second })[tag],
    });
  assert.deepEqual(plan({ state: 'none', belongsToCommit: true }), { tag: 'runtime-v0.4.3', mode: 'build' });
  assert.deepEqual(plan(own), { tag: 'runtime-v0.4.3', mode: 'recover' });
});
