import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { syncFsCalls } from './sync-fs-calls.fixture.mjs';
import { withFileLock } from './file-lock.mjs';
import { writeFileSync } from 'node:fs';

test('an async contended acquire reclaims a dead owner without any synchronous fs call', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-lock-reclaim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = join(dir, 'state.json.lock');
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  writeFileSync(lockPath, `${deadPid} ${Date.now()} deadbeef\n`);
  let ran = false;
  const calls = await syncFsCalls(() =>
    withFileLock(
      lockPath,
      async () => {
        ran = true;
      },
      { timeoutMs: 2000 }
    )
  );
  assert.equal(ran, true, 'the stale lock was reclaimed and the callback ran');
  assert.deepEqual(calls, []);
});
