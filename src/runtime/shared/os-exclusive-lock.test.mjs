import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { acquireOsExclusiveLockSync } from './os-exclusive-lock.mjs';

test('a burst of intact() asks stats the lock file once per run, never by clock', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-os-lock-'));
  const path = join(dir, 'a.lock');
  const lock = acquireOsExclusiveLockSync(path, { namespace: 'test-intact' });
  t.after(() => {
    lock.release();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(lock.held, true);

  const real = fs.statSync;
  let stats = 0;
  fs.statSync = (target, ...rest) => {
    if (String(target) === path) stats += 1;
    return real(target, ...rest);
  };
  syncBuiltinESMExports();
  try {
    for (let n = 0; n < 100; n += 1) assert.equal(lock.intact(), true);
  } finally {
    fs.statSync = real;
    syncBuiltinESMExports();
  }
  assert.equal(stats, 1);

  // The next run asks the file again (another process may have replaced it).
  await new Promise((resolve) => setImmediate(resolve));
  fs.statSync = (target, ...rest) => {
    if (String(target) === path) stats += 1;
    return real(target, ...rest);
  };
  syncBuiltinESMExports();
  try {
    assert.equal(lock.intact(), true);
  } finally {
    fs.statSync = real;
    syncBuiltinESMExports();
  }
  assert.equal(stats, 2);
});