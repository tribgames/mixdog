import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  realpathSync,
  lstatSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import test from 'node:test';

import { pruneTarget, packageNames } from './prune-core-target.mjs';

const H = '0123456789abcdef';
const target = realpathSync(mkdtempSync(join(tmpdir(), 'prune-core-target-')));
test.after(() => {
  assert.equal(realpathSync(dirname(target)), realpathSync(tmpdir()));
  assert.equal(lstatSync(target).isSymbolicLink(), false);
  rmSync(target, { recursive: true, force: true });
});

function put(path, size = 10) {
  const full = join(target, path);
  assert.ok(!relative(target, full).startsWith('..'));
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, 'x'.repeat(size));
}

// Third-party dependencies: kept. The workspace's own crates, test and binary executables, build state: removed.
const KEPT = [
  `debug/deps/libserde-${H}.rlib`,
  `debug/deps/libserde-${H}.rmeta`,
  `debug/deps/serde-${H}.d`,
  `debug/deps/libserde_derive-${H}.so`,
  `debug/deps/libtokio_macros-${H}.dylib`,
  `debug/deps/proc_macro2-${H}.dll`,
  `debug/.fingerprint/serde-${H}/lib-serde.json`,
  `debug/build/ring-${H}/output`,
];
const REMOVED = [
  `debug/deps/libmixdog_core-${H}.rlib`,
  `debug/deps/libmixdog_core-${H}.rmeta`,
  `debug/deps/mixdog_core-${H}.d`,
  `debug/deps/stores-${H}`,
  `debug/deps/it-${H}.exe`,
  `debug/deps/it-${H}.pdb`,
  `debug/.fingerprint/mixdog-core-${H}/lib-mixdog_core.json`,
  `debug/build/mixdog-cli-${H}/output`,
  `debug/incremental/mixdog_core-abc/x`,
  `debug/mixdogd`,
  `debug/mixdogd.exe`,
  `debug/mixdogd.pdb`,
  `debug/mixdogd.d`,
  `nextest/ci/junit.xml`,
];

test('only the third-party dependencies stay, and the removed bytes are counted', () => {
  for (const path of [...KEPT, ...REMOVED]) put(path);
  const removed = pruneTarget({ target, cacheRoot: target, profile: 'debug', packages: ['mixdog-core', 'mixdog-cli'] });
  for (const path of KEPT) assert.ok(existsSync(join(target, path)), `${path} must stay`);
  for (const path of REMOVED) assert.ok(!existsSync(join(target, path)), `${path} must go`);
  assert.equal(removed.bytes, 10 * REMOVED.length - 0);
  assert.ok(removed.entries > 0);
});

test('a target with nothing to remove, or no profile directory, is left alone', () => {
  assert.deepEqual(pruneTarget({ target, cacheRoot: target, profile: 'debug', packages: ['mixdog-core'] }), {
    bytes: 0,
    entries: 0,
  });
  assert.deepEqual(pruneTarget({ target, cacheRoot: target, profile: 'release', packages: ['mixdog-core'] }), {
    bytes: 0,
    entries: 0,
  });
});

test('profile escape, unverified target, and junction descendants are rejected before deletion', () => {
  assert.throws(() => pruneTarget({ target, cacheRoot: target, profile: '../outside', packages: [] }), /profile/);
  assert.throws(() => pruneTarget({ target, profile: 'debug', packages: [] }), /verified CI cache root/);
  put('debug/incremental/must-remain-until-plan-valid');
  const linked = join(target, 'debug', 'examples');
  symlinkSync(join(target, 'debug', 'deps'), linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => pruneTarget({ target, cacheRoot: target, profile: 'debug', packages: [] }), /link or junction/);
  assert.ok(existsSync(join(target, KEPT[0])));
  assert.ok(existsSync(join(target, 'debug/incremental/must-remain-until-plan-valid')));
  assert.throws(
    () => pruneTarget({ target: linked, cacheRoot: linked, profile: 'debug', packages: [] }),
    /link or junction/
  );
  // Remove only the junction itself; no recursive traversal of its target.
  rmSync(linked);
});

test('the CLI splits package names on whitespace, never on the letter s', () => {
  assert.deepEqual(packageNames('mixdog-services  mixdog-spawn\nmixdog-core'), [
    'mixdog-services',
    'mixdog-spawn',
    'mixdog-core',
  ]);
});
