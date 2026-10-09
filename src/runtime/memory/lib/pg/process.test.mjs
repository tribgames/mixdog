import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { classifyOrphanTempPostmaster, withInitdbShareDir } from './process.mjs';

const tempRoot = process.platform === 'win32' ? 'C:/Users/test/AppData/Local/Temp' : '/tmp';
const args =
  `"${tempRoot}/mixdog-headless-pristine-test/data/runtime/bin/postgres" ` +
  `-D "${tempRoot}/mixdog-headless-pristine-test/data/pgdata"`;

test('old unowned temp postmasters are sweep candidates', () => {
  assert.equal(
    classifyOrphanTempPostmaster({
      args,
      uptimeSec: 3600,
      tempRoot,
      ownerAlive: false,
    }),
    true
  );
});

test('a live owner protects a long-running temp postmaster', () => {
  assert.equal(
    classifyOrphanTempPostmaster({
      args,
      uptimeSec: 3600,
      tempRoot,
      ownerAlive: true,
    }),
    false
  );
});

test('the official data directory is never a sweep candidate', () => {
  assert.equal(
    classifyOrphanTempPostmaster({
      args: 'postgres -D "/home/test/.mixdog/data/pgdata"',
      uptimeSec: 3600,
      tempRoot,
    }),
    false
  );
});

test('initdb keeps its default share dir for an ASCII runtime path', () => {
  assert.equal(
    withInitdbShareDir(join(tempRoot, 'mixdog', 'runtime'), (shareDir) => shareDir),
    null
  );
});

test('initdb reads a non-ASCII runtime share dir through a temporary ASCII junction', {
  skip: process.platform !== 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-initdb-share-'));
  try {
    const runtimeDir = join(root, '김현철', 'runtime');
    mkdirSync(join(runtimeDir, 'share'), { recursive: true });
    writeFileSync(join(runtimeDir, 'share', 'sql_features.txt'), 'features');

    const shareDir = withInitdbShareDir(runtimeDir, (dir) => {
      assert.match(dir, /^[\x20-\x7e]+$/);
      assert.equal(readFileSync(join(dir, 'sql_features.txt'), 'utf8'), 'features');
      return dir;
    });

    assert.equal(existsSync(dirname(shareDir)), false);
    assert.equal(readFileSync(join(runtimeDir, 'share', 'sql_features.txt'), 'utf8'), 'features');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('junction cleanup failures never replace the initdb result or error', {
  skip: process.platform !== 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-initdb-share-'));
  try {
    const runtimeDir = join(root, '김현철', 'runtime');
    mkdirSync(join(runtimeDir, 'share'), { recursive: true });

    // The callback removes the junction first, so the helper's own unlink fails.
    let linkRoot;
    const result = withInitdbShareDir(runtimeDir, (dir) => {
      linkRoot = dirname(dir);
      unlinkSync(dir);
      return { status: 0 };
    });
    assert.deepEqual(result, { status: 0 });
    assert.equal(existsSync(linkRoot), false);

    assert.throws(
      () =>
        withInitdbShareDir(runtimeDir, (dir) => {
          unlinkSync(dir);
          throw new Error('initdb exploded');
        }),
      /initdb exploded/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
