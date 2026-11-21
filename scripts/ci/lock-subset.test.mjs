import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { lockSubset } from './lock-subset.mjs';

const lock = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'root', dependencies: { app: '^1', other: '^1' } },
    'node_modules/app': {
      version: '1.0.0',
      integrity: 'sha512-a',
      dev: true,
      dependencies: { shared: '^1', typed: '^2' },
      optionalDependencies: { fast: '^1', both: '^1' },
    },
    'node_modules/app/node_modules/typed': {
      version: '2.0.0',
      integrity: 'sha512-t',
      dependencies: { inner: '^1' },
      optionalDependencies: { native: '^1' },
    },
    'node_modules/app/node_modules/typed/node_modules/inner': { version: '1.5.0', integrity: 'sha512-i' },
    'node_modules/app/node_modules/typed/node_modules/native': { version: '1.0.0', integrity: 'sha512-n', optional: true },
    'node_modules/shared': { version: '1.2.0', integrity: 'sha512-s', dependencies: { typed: '^1', both: '^1' } },
    'node_modules/both': { version: '1.0.0', integrity: 'sha512-b' },
    'node_modules/typed': { version: '1.0.0', integrity: 'sha512-t1' },
    'node_modules/fast': { version: '1.0.0', integrity: 'sha512-f', optional: true },
    'node_modules/other': { version: '1.0.0', integrity: 'sha512-o', dependencies: { unrelated: '^1' } },
    'node_modules/unrelated': { version: '1.0.0', integrity: 'sha512-u' },
  },
};
const manifest = { dependencies: { app: '^1', other: '^1' }, devDependencies: {} };

test('the subset holds the requested packages and what they need, each at the version the lockfile pins', () => {
  const { manifest: out, lock: sub } = lockSubset({ lock, manifest, names: ['app'] });
  assert.deepEqual(out.dependencies, { app: '^1' });
  assert.deepEqual(Object.keys(sub.packages).sort(), [
    '',
    'node_modules/app',
    'node_modules/app/node_modules/typed',
    'node_modules/app/node_modules/typed/node_modules/inner',
    'node_modules/app/node_modules/typed/node_modules/native',
    'node_modules/both',
    'node_modules/fast',
    'node_modules/shared',
    'node_modules/typed',
  ]);
  assert.equal(sub.packages['node_modules/app'].integrity, 'sha512-a');
  assert.equal(sub.packages[''].dependencies.app, '^1');
});

test('a dependency resolves to the nearest node_modules above its requirer, as Node does', () => {
  const { lock: sub } = lockSubset({ lock, manifest, names: ['app'] });
  // `typed` is nested under app, so app's own copy is walked, and shared's `typed` is the one at the top
  assert.equal(sub.packages['node_modules/app/node_modules/typed'].version, '2.0.0');
  assert.equal(sub.packages['node_modules/typed'].version, '1.0.0');
});

test('dev flags of the old tree are dropped, and a package the new root reaches only optionally is optional', () => {
  const { lock: sub } = lockSubset({ lock, manifest, names: ['app'] });
  assert.equal('dev' in sub.packages['node_modules/app'], false);
  const optional = Object.keys(sub.packages).filter((key) => sub.packages[key].optional);
  // `both` is optional for app but required by shared; the nested typed and inner are required, typed's native is not
  assert.deepEqual(optional.sort(), ['node_modules/app/node_modules/typed/node_modules/native', 'node_modules/fast']);
});

test('a name listed as a required peer and as an optional dependency is optional, as npm treats it', () => {
  const overlap = (extra) => ({
    lockfileVersion: 3,
    packages: {
      'node_modules/a': {
        version: '1.0.0',
        integrity: 'sha512-a',
        peerDependencies: { p: '^1' },
        optionalDependencies: { p: '^1' },
      },
      ...extra,
    },
  });
  const request = { manifest: { dependencies: { a: '^1' } }, names: ['a'] };
  const held = lockSubset({ lock: overlap({ 'node_modules/p': { version: '1.0.0', integrity: 'sha512-p' } }), ...request });
  assert.equal(held.lock.packages['node_modules/p'].optional, true);
  assert.ok(lockSubset({ lock: overlap({}), ...request }));
});

const readRepo = (name) => JSON.parse(readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8'));

test("@napi-rs/canvas is optional in the desktop-computer subset (unpdf's optional peer) and required where it is named", () => {
  const subset = (names) =>
    lockSubset({ lock: readRepo('package-lock.json'), manifest: readRepo('package.json'), names }).lock.packages;
  const boot = subset(['onnxruntime-node', 'pptxgenjs', 'jszip', 'strip-ansi', 'unpdf']);
  const core = subset(['pptxgenjs', 'jszip', '@napi-rs/canvas']);
  assert.equal(boot['node_modules/@napi-rs/canvas'].optional, true);
  assert.equal(boot['node_modules/@napi-rs/canvas-android-arm64'].optional, true);
  assert.equal('optional' in core['node_modules/@napi-rs/canvas'], false);
  assert.equal(core['node_modules/@napi-rs/canvas-android-arm64'].optional, true);
  assert.equal('optional' in boot['node_modules/unpdf'], false);
});

test('a name that is not a root dependency, or not in the lockfile, or a dependency the lockfile lacks, fails', () => {
  assert.throws(() => lockSubset({ lock, manifest, names: ['missing'] }), /not a dependency of the package\.json/);
  assert.throws(
    () => lockSubset({ lock, manifest: { dependencies: { gone: '^1' } }, names: ['gone'] }),
    /not in the lockfile/
  );
  const broken = {
    lockfileVersion: 3,
    packages: { 'node_modules/a': { version: '1', integrity: 'sha512-a', dependencies: { b: '^1' } } },
  };
  assert.throws(
    () => lockSubset({ lock: broken, manifest: { dependencies: { a: '^1' } }, names: ['a'] }),
    /needs b, which the lockfile does not hold/
  );
  assert.throws(
    () => lockSubset({ lock: { ...lock, lockfileVersion: 2 }, manifest, names: ['app'] }),
    /lockfileVersion 2/
  );
});

test('an entry without an integrity hash fails, and so does a required peer the lockfile does not hold', () => {
  const bare = {
    lockfileVersion: 3,
    packages: { 'node_modules/a': { version: '1.0.0', resolved: 'https://registry.example/a.tgz' } },
  };
  assert.throws(
    () => lockSubset({ lock: bare, manifest: { dependencies: { a: '^1' } }, names: ['a'] }),
    /node_modules\/a has no integrity hash/
  );
  const peers = (meta) => ({
    lockfileVersion: 3,
    packages: { 'node_modules/a': { version: '1', integrity: 'sha512-a', peerDependencies: { p: '^1' }, ...meta } },
  });
  const request = { manifest: { dependencies: { a: '^1' } }, names: ['a'] };
  assert.throws(() => lockSubset({ lock: peers({}), ...request }), /required peer p/);
  // an optional peer may be absent
  assert.ok(lockSubset({ lock: peers({ peerDependenciesMeta: { p: { optional: true } } }), ...request }));
  // a peer the lockfile holds is followed
  const held = peers({});
  held.packages['node_modules/p'] = { version: '1', integrity: 'sha512-p' };
  assert.ok(lockSubset({ lock: held, ...request }).lock.packages['node_modules/p']);
});

test("the repository's own lockfile yields the packages the Rust office tests read", () => {
  const read = (name) => JSON.parse(readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8'));
  const { manifest: subsetManifest, lock: sub } = lockSubset({
    lock: read('package-lock.json'),
    manifest: read('package.json'),
    names: ['pptxgenjs', 'jszip'],
  });
  for (const key of ['node_modules/pptxgenjs', 'node_modules/jszip', 'node_modules/image-size'])
    assert.ok(sub.packages[key], key);
  assert.equal(subsetManifest.overrides?.pptxgenjs?.['image-size'], sub.packages['node_modules/image-size'].version);
  assert.equal(sub.packages['node_modules/sharp'], undefined);
  // pptxgenjs, jszip and their 16 dependencies; a changed count is a changed closure worth looking at
  assert.equal(Object.keys(sub.packages).length - 1, 18);
});

test('a devDependency of another package is installable (apps/desktop: @electron/asar), with its own lockfile closure', () => {
  const read = (name) => JSON.parse(readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8'));
  const { manifest, lock } = lockSubset({
    lock: read('apps/desktop/package-lock.json'),
    manifest: read('apps/desktop/package.json'),
    names: ['@electron/asar'],
  });
  assert.ok(manifest.dependencies['@electron/asar']);
  assert.ok(lock.packages['node_modules/@electron/asar']);
  assert.equal(Object.keys(lock.packages).length - 1, 16);
  assert.deepEqual(Object.keys(lock.packages).filter((key) => lock.packages[key].optional), []);
});
