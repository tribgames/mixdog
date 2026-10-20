import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { capturePatchRollbackState, restorePatchRollbackState } from './rollback-state.mjs';

test('a restored file is flushed to disk through the handle that wrote it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-rollback-'));
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  });
  const target = join(dir, 'file.txt');
  writeFileSync(target, 'original');
  const [snapshot] = capturePatchRollbackState([target]);
  writeFileSync(target, 'patched');
  const synced = [];
  const realFsync = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', (fd) => {
    synced.push(fd);
    return realFsync(fd);
  });
  syncBuiltinESMExports();
  assert.deepEqual(restorePatchRollbackState([snapshot], 'scope'), []);
  assert.equal(readFileSync(target, 'utf8'), 'original');
  assert.equal(synced.length, 1);
});
