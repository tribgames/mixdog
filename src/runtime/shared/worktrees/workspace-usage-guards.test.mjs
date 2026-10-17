import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { releaseAll } from './activity-gate.mjs';
import { listShellJobRecords } from '../../agent/orchestrator/tools/builtin/lib/shell-job-records.mjs';
import { cleanupTempDirs, useTempDataDir } from './test-support.mjs';
import { isPidAliveOrUnknown } from '../pid-liveness.mjs';

let root;
beforeEach(() => {
  root = useTempDataDir();
});
after(cleanupTempDirs);
test('unknown process-probe failures are not treated as proof that a workspace owner died', (t) => {
  t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('unavailable'), { code: 'EIO' });
  });
  assert.equal(isPidAliveOrUnknown(process.pid), true);
});
test('a failing release never strands the remaining workspace holds', () => {
  const released = [];
  assert.throws(
    () =>
      releaseAll([
        () => released.push('folder'),
        () => {
          throw new Error('lease write failed');
        },
        () => released.push('activity'),
      ]),
    /lease write failed/
  );
  assert.deepEqual(released, ['activity', 'folder']);
});
test('strict background-job inspection refuses corrupt records and keeps live cwd information', async () => {
  const dir = join(root, 'shell-jobs');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'job_check.json');
  writeFileSync(path, '{broken');
  await assert.rejects(listShellJobRecords({ strict: true }));
  writeFileSync(path, JSON.stringify({ status: 'unknown', cwd: root }));
  await assert.rejects(listShellJobRecords({ strict: true }));
  writeFileSync(path, JSON.stringify({ status: 'running', cwd: root }));
  const rows = await listShellJobRecords({ strict: true });
  assert.equal(rows[0].cwd, root);
  assert.equal(rows[0].terminal, false);
});
