import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const previousRoot = process.env.MIXDOG_RUNTIME_ROOT;
const root = mkdtempSync(join(tmpdir(), 'mixdog-scheduler-lock-'));
process.env.MIXDOG_RUNTIME_ROOT = root;
const { Scheduler } = await import('./scheduler.mjs');
after(() => {
  if (previousRoot === undefined) delete process.env.MIXDOG_RUNTIME_ROOT;
  else process.env.MIXDOG_RUNTIME_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

const killFailingWith = (code) => () => {
  throw Object.assign(new Error(code), { code });
};

test('a lock owner the probe cannot signal (EPERM) is still the live owner', (t) => {
  writeFileSync(Scheduler.SCHEDULER_LOCK, `424242\n${Date.now()}\nother-instance`);
  t.mock.method(process, 'kill', killFailingWith('EPERM'));
  assert.equal(Scheduler._liveLockOwner(), 424242);
});

test('a lock owner that no longer exists (ESRCH) is reclaimable', (t) => {
  writeFileSync(Scheduler.SCHEDULER_LOCK, `424242\n${Date.now()}\nother-instance`);
  t.mock.method(process, 'kill', killFailingWith('ESRCH'));
  assert.equal(Scheduler._liveLockOwner(), 0);
});
